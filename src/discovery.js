/*
 *  Name: "discovery.js"
 *  Version: "0.1.6"
 *  Description: "topology discovery with directed command execution"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Notes:
 *  - mongosh only
 *  - support for async required to parallelise and access the topology with auth
 *  TBA:
 *  - contextualise mdblib.js
 */

// Usage: mongosh [connection options] --quiet -f discovery.js

(async() => {
   /*
    *
    */

   function discoverRSHosts() {
      /*
       *
       */
      let hosts = [];
      try {
         hosts = rs.status().members.map(({ name, health, stateStr } = {}) =>
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

   function discoverMongos() {
      /*
       *
       */
      let mongos = [];
      let namespace = db.getSiblingDB('config').getCollection('mongos');
      let options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": "Discovering living mongos process"
      };
      let offsetMS = 60000; // 1min
      let pipeline = [
         { "$match": {
            "$expr": {
               "$gte": ["$ping", { "$subtract": ["$$NOW", offsetMS] }]
         } } },
         { "$project": {
            "_id": 0,
            "host": "$_id"
         } }
      ];
      // [
      //    {
      //       _id: 'M-Q37M74FXLF:27017',
      //       created: ISODate('2024-10-20T22:59:48.082Z'),
      //       mongoVersion: '8.0.3',
      //       ping: ISODate('2024-10-28T04:43:54.493Z'),
      //       up: Long('2303'),
      //       waiting: true,
      //       advisoryHostFQDNs: [ 'm-q37m74fxlf.lan' ]
      //    }
      // ]
      try {
         mongos = namespace.aggregate(pipeline, options).toArray();
      }
      catch(e) {
         console.log('Lack the ability to discover mongos:', e);
      }

      return mongos;
   }

   function discoverShards() {
      /*
       *
       */
      let shards = [];
      try {
         shards = db.adminCommand({ "listShards": 1 }).shards;
      }
      catch(e) {
         console.log('Lack the ability to discover shards:', e);
      }

      return shards;
   }

   async function fetchHostStats({ 'host': hostname } = {}) {
      /*
       *
       */
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
      let directURI;
      if (username == null) {
         directURI = `mongodb://${hostname}/?directConnection=true&tls=${tls}&compressors=${compressors}&readPreference=${readPreference}`;
      } else {
         directURI = `mongodb://${username}:${password}@${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      }
      let node = connect(directURI);
      // console.log(getDBNames());
      // console.log('listDatabases:', node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases);
      // console.log('dbstats:', node.getSiblingDB('admin').stats());
      // console.log('listCollections:', node.getSiblingDB('database').runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true }, { "readPreference": readPreference }).cursor.firstBatch);
      // console.log('collStats:', node.getSiblingDB('database').getCollection('collection').aggregate({ "$collStats": { "storageStats": { "scale": 1 } } }).toArray()[0].ns);

      let me = async() => node.hello().me;
      let stats = async() => node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      let results = {
         'process': await me(),
         'stats': await stats()
      };
      return results;
   }

   async function fetchMongosStats({ 'host': hostname } = {}) {
      /*
       *
       */
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
      let directURI;
      if (username == null) {
         directURI = `mongodb://${hostname}/?directConnection=true&tls=${tls}&compressors=${compressors}&readPreference=${readPreference}`;
      } else {
         directURI = `mongodb://${username}:${password}@${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      }
      let node = connect(directURI);
      let stats = async() => node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      let results = {
         'process': hostname,
         'stats': await stats()
      };
      return results;
   }

   async function fetchShardStats({ 'host': shardString } = {}) {
      /*
       *
       */
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
      let readPreference = 'primaryPreferred';
      let { setName, seedList } = shardString.match(/^(?<setName>\w+)\/(?<seedList>.+)$/).groups;
      let shardURI;
      if (username == null) {
         shardURI = `mongodb://${seedList}/?replicaSet=${setName}&tls=${tls}&compressors=${compressors}&readPreference=${readPreference}`;
      } else {
         shardURI = `mongodb://${username}:${password}@${seedList}/?replicaSet=${setName}&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      }
      let shard = connect(shardURI);
      let me = async() => shard.hello().me;
      let stats = async() => shard.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      let results = {
         'process': await me(),
         'stats': await stats()
      };
      return results;
   }

   function discoverShardedHosts(shards) {
      /*
       *
       */
      let hosts = shards.map(({ host }) => {
         let { seedList } = host.match(/^(?:\w+)\/(?<seedList>.+)$/).groups;
         return seedList.split(',').map(name =>
            new Object({ 'host': name, 'health': '', 'role': '' })
         );
      }).flat();
      // let promises = shards.map(fetchShardHosts(setName, seedList));
      // return await Promise.all(promises);
      // return await Promise.allSettled(promises);
      return hosts;
   }

   async function fetchAllStats(hosts) {
      /*
       *
       */
      let promises = hosts.map(fetchHostStats);

      return Promise.all(promises);
      // return await Promise.allSettled(promises);
   }

   async function fetchMongosesStats(mongos) {
      /*
       *
       */
      let promises = mongos.map(fetchMongosStats);

      return Promise.all(promises);
      // return await Promise.allSettled(promises);
   }

   async function fetchShardedStats(shards) {
      /*
       *
       */
      let promises = shards.map(fetchShardStats);

      return Promise.all(promises);
      // return await Promise.allSettled(promises);
   }

   function isSharded() {
      /*
       *  is mongos process
       */
      return db.hello().msg == 'isdbgrid';
   }

   async function main() {
      /*
       *
       */

      // load('mdblib.js');
      // ['ReplSet', 'Sharded', 'LoadBalanced', 'Standalone']

      let mongos, shards, hosts, allMongosStats, allShardStats, allHostStats;

      if (isSharded()) {
         mongos = discoverMongos();
         console.log('mongos', mongos);
         shards = discoverShards();
         console.log('shards', shards);
         hosts = discoverShardedHosts(shards);
      } else {
         hosts = discoverRSHosts();
      }
      console.log('hosts', hosts);

      if (isSharded()) {
         allMongosStats = fetchMongosesStats(mongos);
         allShardStats = fetchShardedStats(shards);
      }
      allHostStats = fetchAllStats(hosts);

      if (isSharded()) {
         console.log('all mongos stats', allMongosStats);
         console.log('all shard stats', allShardStats);
      }

      console.log('all host stats', allHostStats);

      return;
   }

   await main();
})();

// EOF
