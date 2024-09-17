/*
 *  Name: "discovery.js"
 *  Version: "0.1.1"
 *  Description: topology discovery with directed command execution
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Notes: mongosh only, support for async required to parallelise and access the topology with auth
 *  TBA:
 *  - contextualise mdblib.js
 */

// Usage: "mongosh [connection options] --quiet discovery.js"

(async() => {
   async function main() {

      // load('mdblib.js');

      // ['ReplSet', 'Sharded', 'LoadBalanced', 'Standalone']

      function discoverHosts() {
         let hosts = [];
         try {
            hosts = rs.status().members.map(({ name, health, stateStr }) =>
               new Object({ 'name': name, 'health': health, 'role': stateStr })
            ).filter(node =>
               node.health == 1 && node.role != 'ARBITER'
            );
         }
         catch(e) {
            console.log('Lack the rights to discover hidden nodes:', e);
            hosts = db.hello().hosts;
         }

         return hosts;
      }

      function discoverShards() {
         let shards = [];
         try {
            shards = db.adminCommand({ "listShards": 1 }).shards;
         }
         catch(e) {
            console.log('Lack the ability to discover shards:', e);
            // shards = [''];
         }

         return shards;
      }

      async function fetchHostStats(host) {
         let directURI = `mongodb://${username}:${password}@${host.name}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
         let node = connect(directURI);
         // let db = context;
         // console.log(getDBNames());
         // console.log('listDatabases:', node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases);
         // console.log('dbstats:', node.getSiblingDB('admin').stats());
         // console.log('listCollections:', node.getSiblingDB('database').runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true }, { "readPreference": readPreference }).cursor.firstBatch);
         // console.log('collStats:', node.getSiblingDB('database').getCollection('collection').aggregate({ "$collStats": { "storageStats": { "scale": 1 } } }).toArray()[0].ns);

         return node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      }

      async function fetchAllShards(shards) {
         shards.forEach(shard => console.log(`\nID: ${shard._id} with: ${shard.host}`));
         shards.forEach(shard => {
            console.log(`\nConnecting to: ${shard._id}`);
            let { setName, seedList } = shard.host.match(/(?<setName>\w+)\/(?<seedList>.+)/).groups;
            // let [, setName, seedList] = shard.host.match(/(\w+)\/(.+)/);
         });
         // let promises = shards.map(shard => fetchHostStats(shard));
         let promises = shards.map(fetchReplHosts);

         return await Promise.all(promises);
         // return await Promise.allSettled(promises);
      }

      async function fetchAllStats(hosts) {
         // let promises = hosts.map(host => fetchHostStats(host));
         let promises = hosts.map(fetchHostStats);

         return await Promise.all(promises);
         // return await Promise.allSettled(promises);
      }

      let {
         'credentials': {
            username = '',
            password = '',
            'source': authSource = 'admin',
            'mechanism': authMech = 'DEFAULT'
         },
         compressors = ['none'],
         tls = false
      } = db.getMongo().__serviceProvider.mongoClient.options;
      let readPreference = 'secondaryPreferred';
      let shards, shardStats;
      if (this.proc == 'mongos') {
         shards = discoverShards();
         shardStats = fetchAllShards(shards);
      }
      let hosts = discoverHosts();
      let allHostStats = fetchAllStats(hosts);

      console.log(allHostStats);
      // console.log(shardStats);

      return;
   }

   await main();
})();

// EOF
