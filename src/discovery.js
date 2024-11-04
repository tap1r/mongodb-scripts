(async() => {
   /*
    *  Name: "discovery.js"
    *  Version: "0.1.15"
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

   // Usage: mongosh [connection options] [--quiet] [-f|--file] discovery.js

   function discoverRSHosts() {
      /*
       *  returns an array of healthy, non-hidden data bearing replica set members
       */
      let members = [];
      try {
         // attempt to grab the replica set config to discover hidden nodes
         members = rs.status().members.filter(
            ({ health, 'stateStr': role }) => health == 1 && role !== 'ARBITER'
         ).map(
            ({ name, 'stateStr': role }) => new Object({ "host": name, "role": role })
         );
      }
      catch(e) {
         // else we can just grab the list of discoverable nodes
         let { hosts = [], passives = [] } = db.hello();
         members = hosts.concat(passives).map(
            name => new Object({ "host": name })
         );
      }

      return members;
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
         return e;
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
         console.log('Lack the ability to discover shards');
         return e;
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
         console.log('Lack the ability to discover shards:');
         return e;
      }

      return csrs.map(({ shardName, configsvrConnectionString } = {}) =>
            new Object({ "name": shardName, "host": configsvrConnectionString })
         );
   }

   async function me(node) {
      return await node.hello().me;
   }

   async function stats(client, options) {
      // console.log(getDBNames());
      // console.log('listDatabases:', node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases);
      // console.log('dbstats:', node.getSiblingDB('admin').stats());
      // console.log('listCollections:', node.getSiblingDB('database').runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true }, { "readPreference": readPreference }).cursor.firstBatch);
      // console.log('collStats:', node.getSiblingDB('database').getCollection('collection').aggregate({ "$collStats": { "storageStats": { "scale": 1 } } }).toArray()[0].ns);

      return await client.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": options.readPreference }).databases;
   }

   // async function fetchHostStats({ 'host': hostname } = {}, cmdFn) {
   async function fetchHostStats({ 'host': hostname } = {}) {
      /*
       *
       */
      let [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      let readPreference = 'secondaryPreferred';
      let credentials, node;
      if (username !== null) {
         credentials = username + ':' + password + '@';
      }
      let directURI = `mongodb://${credentials}${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      try {
         node = connect(directURI);
      } catch(e) {
         console.log('Could not connect to host:', hostname);
         return e;
      }

      return {
         "process": await me(node),
         "stats": await stats(node, { 'readPreference': readPreference })
         // 'stats': await cmdFn(node, { 'readPreference': readPreference })
      };
   }

   async function fetchMongosStats({ 'host': hostname } = {}) {
      /*
       *
       */
      let [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      let readPreference = 'secondaryPreferred';
      let credentials, node;
      if (username !== null) {
         credentials = username + ':' + password + '@';
      }
      let directURI = `mongodb://${credentials}${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      try {
         node = connect(directURI);
      } catch(e) {
         console.log('Could not connect to host:', hostname);
         return e;
      }

      let stats = async() => node.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, { "readPreference": readPreference }).databases;
      let results = {
         "process": hostname,
         "stats": await stats(node, { 'readPreference': readPreference })
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
      let credentials, shard;
      if (username !== null) {
         credentials = username + ':' + password + '@';
      }
      let shardURI = `mongodb://${credentials}${seedList}/?replicaSet=${setName}&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;

      try {
         shard = connect(shardURI);
      } catch(e) {
         console.log('Could not connect to shard:', seedList);
         return e;
      }

      return {
         "process": await me(shard),
         "stats": await stats(shard, { 'readPreference': readPreference })
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
      let promises = () => hosts.map(fetchHostStats);

      return await Promise.allSettled(promises()).then(results => {
         return results.map(({ status, value }) => (status == 'fulfilled') && value);
      });
   }

   async function fetchMongosesStats(mongos = []) {
      /*
       *
       */
      let promises = () => mongos.map(fetchMongosStats);

      return await Promise.allSettled(promises()).then(results => {
         return results.map(({ status, value }) => (status == 'fulfilled') && value);
      });
   }

   async function fetchShardedStats(shards = []) {
      /*
       *
       */
      let promises = () => shards.map(fetchShardStats);

      return await Promise.allSettled(promises()).then(results => {
         return results.map(({ status, value }) => (status == 'fulfilled') && value);
      });
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
