(async() => {
   /*
    *  Name: "discovery.js"
    *  Version: "0.1.12"
    *  Description: "topology discovery with directed command execution"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - support for async required to parallelise and access the topology with auth
    *  TBA:
    *  - add plugable cmd executors
    */

   // Usage: mongosh [connection options] --quiet -f discovery.js

   function discoverRSHosts() {
      /*
       *  returns an array of healthy, non-hidden data bearing replica set members
       */
      let hosts = [];
      try {
         hosts = rs.status().members.filter(
            ({ health, role }) => health == 1 && role !== 'ARBITER'
         ).map(
            ({ name, stateStr }) => new Object({ "host": name, "role": stateStr })
         );
      }
      catch(e) {
         console.log('Lack the rights to discover hidden nodes:', e);
         hosts = db.hello().hosts.map(
            (name) => new Object({ "host": name, "role": "" })
         );
      }

      return hosts;
   }

   function discoverMongos() {
      /*
       *  returns an array of available mongos instances attached to the sharded cluster
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
            "host": {
               "$cond": [
                  { "$ifNull": ["$advisoryHostFQDNs", true] },
                  "$_id",
                  { "$concat": [
                     { "$first": "$advisoryHostFQDNs" },
                     ":",
                     { "$arrayElemAt": [{ "$split": ["$_id", ":"] }, 1] }
                  ] }
               ]
            }
         } }
      ];
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
       *  returns an array of available shards
       */
      let shards = [];
      try {
         shards = db.adminCommand({ "listShards": 1 }).shards;
      }
      catch(e) {
         console.log('Lack the ability to discover shards:', e);
      }

      return shards.filter(({ state } = {}) =>
            state === 1
         ).map(({ _id, host } = {}) =>
            new Object({ "name": _id, "host": host })
         );
   }

   function discoverCSRSshard() {
      /*
       *  returns an array with the CSRS 'config' shard
       */
      let csrs = [];
      try {
         csrs = db.getSiblingDB('admin').getCollection('system.version').find(
               { "_id": "shardIdentity" }
            ).toArray();
      }
      catch(e) {
         console.log('Lack the ability to discover shards:', e);
      }

      return csrs.map(({ shardName, configsvrConnectionString } = {}) =>
            new Object({ "name": shardName, "host": configsvrConnectionString })
         );
   }

   async function me(node) {
      return await node.hello().me;
   }

   async function stats(client, options) {
      return await client.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": options.readPreference }).databases;
   }

   // async function fetchHostStats({ 'host': hostname } = {}, cmdFn) {
   async function fetchHostStats({ 'host': hostname } = {}) {
      /*
       *
       */
      let [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      let readPreference = 'secondaryPreferred';
      let directURI;
      if (username == null) {
         directURI = `mongodb://${hostname}/?directConnection=true&tls=${tls}&compressors=${compressors}&readPreference=${readPreference}`;
      } else {
         directURI = `mongodb://${username}:${password}@${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      }

      let node;
      try{
         node = connect(directURI);
      } catch(e) {
         console.log('Could not connect to host:', hostname, e);
         return null;
      }

      // console.log(getDBNames());
      // console.log('listDatabases:', node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases);
      // console.log('dbstats:', node.getSiblingDB('admin').stats());
      // console.log('listCollections:', node.getSiblingDB('database').runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true }, { "readPreference": readPreference }).cursor.firstBatch);
      // console.log('collStats:', node.getSiblingDB('database').getCollection('collection').aggregate({ "$collStats": { "storageStats": { "scale": 1 } } }).toArray()[0].ns);

      return {
         'process': await me(node),
         'stats': await stats(node, { 'readPreference': readPreference })
         // 'stats': await cmdFn(node, { 'readPreference': readPreference })
      };
   }

   async function fetchMongosStats({ 'host': hostname } = {}) {
      /*
       *
       */
      let [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      let readPreference = 'secondaryPreferred';
      let directURI;
      if (username == null) {
         directURI = `mongodb://${hostname}/?tls=${tls}&compressors=${compressors}`;
      } else {
         directURI = `mongodb://${username}:${password}@${hostname}/?tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}`;
      }

      let node;
      try {
         node = connect(directURI);
      } catch(e) {
         console.log('Could not connect to host:', hostname, e);
         return null;
      }

      let stats = async() => node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      let results = {
         'process': hostname,
         'stats': await stats(node, { 'readPreference': readPreference })
      };

      return results;
   }

   async function fetchShardStats({ 'host': shardString } = {}) {
      /*
       *
       */
      let [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      let readPreference = 'primaryPreferred';
      let { setName, seedList } = shardString.match(/^(?<setName>.+)\/(?<seedList>.+)$/).groups;
      let shardURI;
      if (username == null) {
         shardURI = `mongodb://${seedList}/?replicaSet=${setName}&tls=${tls}&compressors=${compressors}&readPreference=${readPreference}`;
      } else {
         shardURI = `mongodb://${username}:${password}@${seedList}/?replicaSet=${setName}&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      }
      let shard;
      try {
         shard = connect(shardURI);
      } catch(e) {
         console.log('Could not connect to shard:', seedList, e);
         return null;
      }

      return {
         'process': await me(shard),
         'stats': await stats(shard, { 'readPreference': readPreference })
      };
   }

   function discoverShardedHosts(shards = []) {
      /*
       *
       */
      let hosts = shards.map(({ host }) => {
         let { setName, seedList } = host.match(/^(?<setName>.+)\/(?<seedList>.+)$/).groups;
         return seedList.split(',').map(name =>
            new Object({ "name": setName, "host": name })
         );
      });
      return hosts.flat();
   }

   async function fetchAllStats(hosts = []) {
      /*
       *
       */
      let promises = hosts.map(fetchHostStats);

      return Promise.all(promises);
      // return await Promise.allSettled(promises);
   }

   async function fetchMongosesStats(mongos = []) {
      /*
       *
       */
      let promises = mongos.map(fetchMongosStats);

      return Promise.all(promises);
      // return await Promise.allSettled(promises);
   }

   async function fetchShardedStats(shards = []) {
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
      return db.hello().msg === 'isdbgrid';
   }

   function isLoadBalanced() {
      /*
       *  is load balanced topology
       */
      return false;
   }

   function isStandalone() {
      /*
       *  is standalone topology
       */
      return false;
   }

   function mongoOptions() {
      /*
       *  returns MongoClient() options to construct new connections
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

      return [username, password, authSource, authMech, compressors, tls];
   }

   async function main() {
      /*
       *  Discover topology type:
       *  - mongos
       *  - shards
       *  - replset
       *
       *  TBA:
       *  - standalone host
       *  - LoadBalanced
       */

      let mongos, csrs, csrsHosts, shards, hosts, allMongosStats, allShardStats, allHostStats;

      if (isSharded()) {
         mongos = discoverMongos();
         console.log('mongos:', mongos);
         csrs = discoverCSRSshard();
         console.log('csrs:', csrs);
         shards = discoverShards();
         console.log('shards:', shards);
         csrsHosts = discoverShardedHosts(csrs);
         console.log('csrsMembers:', csrsHosts);
         hosts = discoverShardedHosts(shards);
      } else {
         hosts = discoverRSHosts();
      }
      console.log('hosts:', hosts);

      if (isSharded()) {
         allMongosStats = fetchMongosesStats(mongos);
         allShardStats = fetchShardedStats(shards);
      }
      allHostStats = fetchAllStats(hosts);

      if (isSharded()) {
         console.log('all mongos stats:', allMongosStats);
         console.log('all shard stats:', allShardStats);
      }

      console.log('all host stats:', allHostStats);

      return;
   }

   await main();
})();

// EOF
