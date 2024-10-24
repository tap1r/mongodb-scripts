/*
 *  Name: "discovery.js"
 *  Version: "0.1.2"
 *  Description: "topology discovery with directed command execution"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
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
               new Object({ 'host': name, 'health': health, 'role': stateStr })
            ).filter(({ health, role }) =>
               health == 1 && role != 'ARBITER'
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

      async function fetchHostStats({ 'host': hostname }) {
         let directURI;
         if (username == null) {
            directURI = `mongodb://${hostname}/?directConnection=true&tls=${tls}&compressors=${compressors}&readPreference=${readPreference}`;
         } else {
            directURI = `mongodb://${username}:${password}@${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
         }
         let node = connect(directURI);
         // let db = context;
         // console.log(getDBNames());
         // console.log('listDatabases:', node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases);
         // console.log('dbstats:', node.getSiblingDB('admin').stats());
         // console.log('listCollections:', node.getSiblingDB('database').runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true }, { "readPreference": readPreference }).cursor.firstBatch);
         // console.log('collStats:', node.getSiblingDB('database').getCollection('collection').aggregate({ "$collStats": { "storageStats": { "scale": 1 } } }).toArray()[0].ns);

         return node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      }

      function discoverShardedHosts(shards) {
         shards.forEach(({ _id, host }) => console.log(`\nID: ${_id} with: ${host}`));
         let hosts = shards.map(({ host }) => {
            // console.log(`\nConnecting to: ${_id}`);
            let { setName, seedList } = host.match(/(?<setName>\w+)\/(?<seedList>.+)/).groups;
            return seedList.split(',');
         });
         hosts = hosts.flat();
         hosts = hosts.map((name) =>
            new Object({ 'host': name, 'health': '', 'role': '' })
         );
         // let promises = shards.map(fetchShardHosts(setName, seedList));

         // return await Promise.all(promises);
         // return await Promise.allSettled(promises);
         return hosts;
      }

      async function fetchAllStats(hosts) {
         let promises = hosts.map(fetchHostStats);

         return await Promise.all(promises);
         // return await Promise.allSettled(promises);
      }

      let {
         username = null,
         password = null,
         'source': authSource = 'admin',
         'mechanism': authMech = 'DEFAULT'
      } = db.getMongo().__serviceProvider.mongoClient.options?.credentials ?? {};
      let {
         compressors = ['none'],
         tls = false
      } = db.getMongo().__serviceProvider.mongoClient.options;
      let readPreference = 'secondaryPreferred';
      let hosts, shards, shardStats;
      if (db.hello().msg == 'isdbgrid') { // is mongos process
         shards = discoverShards();
         hosts = discoverShardedHosts(shards);
      } else {
         hosts = discoverHosts();
      }
      console.log(hosts);
      let allHostStats = fetchAllStats(hosts);

      console.log(allHostStats);

      return;
   }

   await main();
})();

// EOF
