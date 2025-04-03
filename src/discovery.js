// require('events').EventEmitter.prototype._maxListeners = 128;
(async() => {
   /*
    *  Name: "discovery.js"
    *  Version: "0.1.22"
    *  Description: "topology discovery with directed command execution"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - plugable cmd execution
    *  - support for async required to parallelise and access the topology with auth
    *
    *  TBA:
    *  - add standalone host discovery
    *  - add LoadBalanced topology type
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] discovery.js

   // Example: mongosh --host "replset/localhost" discovery.js

   // async function stats(client, options) {
   //    return client.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, options).databases;
   // }

   function discoverRSHosts() {
      /*
       *  returns an array of healthy, non-hidden data bearing replica set members
       */
      let members = [];
      try {
         // attempt to grab the replica set config to discover hidden nodes
         members = rs.status().members.filter(
            ({ health, 'stateStr': role }) => health === 1 && role !== 'ARBITER'
         ).map(
            ({ name, 'stateStr': role }) => new Object({ "host": name, "role": role })
         );
      } catch(e) {
         // else we can just grab the list of discoverable nodes
         const { hosts = [], passives = [] } = db.hello();
         members = [...hosts, ...passives].map(
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
      const namespace = db.getSiblingDB('config').getCollection('mongos');
      const options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": "Discovering living mongos process"
      };
      const offsetMS = 60000; // 1min
      const pipeline = [
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
      } catch(e) {
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
      } catch(e) {
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
      } catch(e) {
         console.log('Lack the ability to discover the CSRS:');
         return e;
      }

      return csrs.map(({ shardName, configsvrConnectionString } = {}) =>
            new Object({ "name": shardName, "host": configsvrConnectionString })
         );
   }

   function discoverShardedHosts(shards = []) {
      /*
       *  returns an array of hosts across all available shards
       */
      return shards.map(({ host }) => {
         const { setName, seedList } = host.match(/^(?<setName>.+)\/(?<seedList>.+)$/).groups;
         return seedList.split(',').map(name =>
            new Object({ "name": setName, "host": name })
         );
      }).flat();
   }

   async function me(node) {
      /*
       *  returns a node's self-identity
       */
      return await node.hello().me;
   }

   async function execHostCmd({ 'host': hostname } = {}, cmdFn = async() => {}) {
      /*
       *  execute a command on a mongod
       */
      const [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      const readPreference = 'secondaryPreferred';
      let credentials, node;
      if (username !== null) {
         credentials = username + ':' + password + '@';
      }
      const directURI = `mongodb://${credentials}${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      try {
         node = connect(directURI);
      } catch(e) {
         console.log('Could not connect to host:', hostname);
         return e;
      }

      return {
         "process": await me(node),
         "results": await cmdFn(node, { "readPreference": readPreference })
      };
   }

   async function execMongosCmd({ 'host': hostname } = {}, cmdFn = async() => {}) {
      /*
       *  execute a command on a mongos
       */
      const [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      const readPreference = 'secondaryPreferred';
      let credentials, node;
      if (username !== null) {
         credentials = username + ':' + password + '@';
      }
      const directURI = `mongodb://${credentials}${hostname}/?directConnection=true&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;
      try {
         node = connect(directURI);
      } catch(e) {
         console.log('Could not connect to host:', hostname);
         return e;
      }

      return {
         "process": hostname,
         "results": await cmdFn(node, { "readPreference": readPreference })
      };
   }

   async function execShardCmd({ 'host': shardString } = {}, cmdFn = async() => {}) {
      /*
       *  execute a command on a shard replset
       */
      const [username, password, authSource, authMech, compressors, tls] = mongoOptions();
      const readPreference = 'primaryPreferred';
      const { setName, seedList } = shardString.match(/^(?<setName>.+)\/(?<seedList>.+)$/).groups;
      let credentials, shard;
      if (username !== null) {
         credentials = username + ':' + password + '@';
      }
      const shardURI = `mongodb://${credentials}${seedList}/?replicaSet=${setName}&tls=${tls}&authSource=${authSource}&authMechanism=${authMech}&compressors=${compressors}&readPreference=${readPreference}`;

      try {
         shard = connect(shardURI);
      } catch(e) {
         console.log('Could not connect to shard:', seedList);
         return e;
      }

      return {
         "process": await me(shard),
         "results": await cmdFn(shard, { "readPreference": readPreference })
      };
   }

   async function execAllHostsCmd(hosts = [], cmdFn = async() => {}) {
      /*
       *  async exec wrapper to parallelise tasks
       */
      const promises = () => hosts.map(host => execHostCmd(host, cmdFn));

      return await Promise.allSettled(promises()).then(results => {
         return results.map(({ status, value }) => (status == 'fulfilled') && value);
      });
   }

   async function execAllMongosesCmd(mongos = [], cmdFn = async() => {}) {
      /*
       *  async exec wrapper to parallelise tasks
       */
      const promises = () => mongos.map(host => execMongosCmd(host, cmdFn));

      return await Promise.allSettled(promises()).then(results => {
         return results.map(({ status, value }) => (status == 'fulfilled') && value);
      });
   }

   async function execAllShardsCmd(shards = [], cmdFn = async() => {}) {
      /*
       *  async exec wrapper to parallelise tasks
       */
      const promises = () => shards.map(host => execShardCmd(host, cmdFn));

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
      const {
         username = null,
         password = null,
         'source': authSource = 'admin',
         'mechanism': authMech = 'DEFAULT'
      } = db.getMongo().__serviceProvider.mongoClient.options?.credentials ?? {};
      const {
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
       *  Execute mongos/shard/host specific commands
       */

      let mongos, csrs, csrsHosts, shards,
         allMongosResults, allCSRSResults,
         csrsResults, allShardResults,
         hosts, allHostResults;

      const mongosCmd = async(client, options) => 'I am a mongos, ';
      const shardCmd = async(client, options) => 'I am a shard primary, ' + await me(client);
      const csrsCmd = async(client, options) => 'I am the CSRS primary, ' + await me(client);
      const csrsHostCmd = async(client, options) => 'I am a CSRS member host, ' + await me(client);
      const hostCmd = async(client, options) => 'I am a member host, ' + await me(client);
      // const hostCmd = async(client, options) => await dbstats(client, options);
      async function dbstats(client /*, options*/) {
         const db = client;
         const options = { "output": { "format": "json" } };
         let dbStats;
         // load('dbstats.js');
         return await dbStats;
      }

      // discover topology
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

      // execute commands
      if (isSharded()) {
         allMongosResults = execAllMongosesCmd(mongos, mongosCmd);
         allCSRSResults = execAllShardsCmd(csrs, csrsCmd);
         allShardResults = execAllShardsCmd(shards, shardCmd);
         csrsResults = execAllShardsCmd(csrs, csrsCmd);
         allCSRSResults = execAllHostsCmd(csrsHosts, csrsHostCmd);
      }
      allHostResults = execAllHostsCmd(hosts, hostCmd);

      // return command results
      if (isSharded()) {
         console.log(`"all mongos cmd results":`, allMongosResults);
         console.log(`"csrs shard cmd results:`, allCSRSResults);
         console.log(`"csrs hosts cmd results:`, csrsResults);
         console.log(`"all shards cmd results:`, allShardResults);
      }
      console.log(`"all hosts cmd results":`, allHostResults);

      return;
   }

   await main();
})();

// EOF
