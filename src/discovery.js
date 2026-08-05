(async() => {
   /*
    *  Name: "discovery.js"
    *  Version: "0.1.37"
    *  Description: "Topology discovery with directed command execution"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - plugable cmd execution
    *  - support for async required to parallelise and access the topology with auth
    *  - only supports driver URI parameters, some driver options may not be supported
    *  - WARNING: debugging may leak credentials
    *
    *  TBA:
    *  - add standalone host discovery
    *  - add LoadBalanced topology type
    *  - add support for arbiters
    *  - add SRV connection string support
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] discovery.js

   // Example: mongosh --host "replset/localhost" discovery.js

   function parseReplSetHosts(hostString) {
      const { setName = null, seedList = null } = /^(?<setName>[^/]+)\/(?<seedList>.+)$/.exec(hostString)?.groups || {};
      if (!setName || !seedList) throw new Error(`Invalid replSet connection string: ${hostString}`);

      return { setName, seedList };
   }

   function discoverRSHosts() {
      /*
       *  returns an array of healthy, non-hidden data bearing replica set members
       */
      let members = [];
      try { // attempt to grab the replica set config to discover hidden nodes
         members = rs.status().members.filter(
            ({ health, 'stateStr': role }) => health === 1 && role !== 'ARBITER'
         ).map(
            ({ name, 'stateStr': role }) => { return { "host": name, "role": role } }
         );
      } catch(e) { // else we can just grab the list of discoverable nodes
         const { hosts = [], passives = [] } = db.hello();
         members = [...hosts, ...passives].map(
            name => { return { "host": name } }
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
         "comment": "Discovering living mongos processes"
      };
      const offsetMS = 60000; // 1min
      const pipeline = [
         { "$match": {
            "$expr": {
               "$gte": ["$ping", { "$subtract": ["$$NOW", offsetMS] }]
         } } },
         { "$project": {
            "_id": 0,
            "name": "mongos",
            "host": {
               "$cond": [
                  { "$eq": [
                     { "$ifNull": [{ "$first": "$advisoryHostFQDNs" }, null] },
                     null
                  ] },
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
         // console.log('Lack the ability to discover mongos:', e.errmsg ?? e.message ?? String(e));
         return { "error": `Lack the ability to discover mongos: ${e.errmsg ?? e.message ?? String(e)}` };
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
         // console.log('Lack the ability to discover shards:', e.errmsg ?? e.message ?? String(e));
         return { "error": `Lack the ability to discover shards: ${e.errmsg ?? e.message ?? String(e)}` };
      }

      // TBA: check for non-empty shards array first
      return shards.filter(({ state } = {}) =>
            state === 1
         ).map(({ _id, host } = {}) => {
            return { "name": _id, "host": host };
         });
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
         // console.log('Lack the ability to discover the CSRS:', e.errmsg ?? e.message ?? String(e));
         return { "error": `Lack the ability to discover the CSRS: ${e.errmsg ?? e.message ?? String(e)}` };
      }

      // TBA: check for non-empty csrs array first
      return csrs.map(({ shardName, configsvrConnectionString } = {}) => {
         return { "name": shardName, "host": configsvrConnectionString };
      });
   }

   function discoverShardedHosts(shards = []) {
      /*
       *  returns an array of hosts across all available shards
       */
      return shards.map(({ host }) => {
         const { setName, seedList } = parseReplSetHosts(host);
         return seedList.split(',').map(name => {
            return { "name": setName, "host": name };
         });
      }).flat();
   }

   async function me(node) {
      /*
       *  returns a node's self-identity
       */
      // TBA: add shell version and privileges checks
      return await node.hello().me || await node.hostInfo().system.hostname || 'unknown';
   }

   async function connectAndExec({ name, host } = {}, cmdFn = async() => {}, { targetType = null, readPreference = 'nearest' } = {}) {
      /*
       *  connect to the target and execute a command
       */
      // const url = buildConnectionURI({ host, targetType });
      // let targetURL = '';
      // const targetURL = buildConnectionURI({ host, targetType });
      // let setName, seedList;
      // let node;
      
      // const mode = ['shard', 'csrs', 'replSet'].includes(targetType) ? 'replSet' : 'direct';
      // switch (mode) {
      //    case 'direct':
      //       url.host = host;
      //       url.searchParams.set('readPreference', 'nearest');
      //       url.searchParams.set('directConnection', 'true');
      //       url.searchParams.sort();
      //       targetURL = url.toString();
      //       break;
      //    case 'replSet':
      //       ({ setName, seedList } = parseReplSetHosts(host));
      //       url.searchParams.set('readPreference', 'primaryPreferred');
      //       url.searchParams.set('directConnection', 'false');
      //       url.searchParams.set('replicaSet', setName);
      //       url.searchParams.sort();
      //       // seedlists are considered malformed by the URL() parser, so we splice it manually
      //       targetURL = url.toString().replace(/@[^/]+\//, `@${seedList}/`);
      //       break;
      //    // case 'loadBalanced':
      //    //    readPreference = 'nearest';
      //    //    url.searchParams.set('readPreference', readPreference);
      //    //    url.searchParams.set('directConnection', 'false');
      //    //    url.searchParams.sort();
      //    //    targetURL = url.toString();
      //    //    break;
      //    // default:
      //    //    throw new Error(`Unsupported target type: ${targetType}`);
      // }

      try {
         const node = connect(buildConnectionURI({ host, targetType }));
         return {
            "success": true,
            "target": targetType,
            "process": host ?? name ?? await me(node),
            "results": await cmdFn(node, { "readPreference": readPreference })
         };
      } catch(e) {
         return {
            "success": false,
            "target": targetType,
            "process": host ?? name ?? null,
            "results": e.errmsg ?? e.message ?? String(e)
         };
      }
   }

   async function execAll(targets = [], cmdFn = async() => {}, options = {}) {
      /*
       *  execute a command on all targets
       *  async exec wrapper to parallelise tasks
       */
      const settled = await Promise.allSettled(
         targets.map(target => connectAndExec(target, cmdFn, options))
      );
      // filter out rejected promises so we don't stop processing
      return settled.map(({ status, value, reason }) => {
         return status === 'fulfilled'
            ? value
            : { // return rejected promises so we log the errors
               "success": false,
               "target": options.targetType,
               "process": null,
               "results": "",
               "errors": String(reason)
            };
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
      console.log('[TODO] isLoadBalanced() method is not implemented yet');

      return false;
   }

   function isStandalone() {
      /*
       *  is standalone topology
       */
      console.log('[TODO] isStandalone() method is not implemented yet');

      return false;
   }

   function buildConnectionURI({ host, targetType } = {}) {
      /*
       *  returns MongoClient() options to construct new connections
       */

      // TODO: add support for SRV connection string conversion

      const url = new URL(db.getMongo().getURI());
      let targetURL = '';
      // optimise params for direct connection and avoid conflicting options
      url.searchParams.delete('replicaSet');
      url.searchParams.delete('tags');
      url.searchParams.delete('readPreferenceTags');
      url.searchParams.delete('maxStalenessSeconds');
      url.searchParams.delete('minPoolSize');
      url.searchParams.delete('maxPoolSize');
      url.searchParams.delete('srvMaxHosts');
      
      const mode = ['shard', 'csrs', 'replSet'].includes(targetType) ? 'replSet' : 'direct';
      switch (mode) {
         case 'direct':
            url.host = host;
            url.searchParams.set('readPreference', 'nearest');
            url.searchParams.set('directConnection', 'true');
            url.searchParams.sort();
            targetURL = url.toString();
            break;
         case 'replSet':
            const { setName, seedList } = parseReplSetHosts(host);
            url.searchParams.set('readPreference', 'primaryPreferred');
            url.searchParams.set('directConnection', 'false');
            url.searchParams.set('replicaSet', setName);
            url.searchParams.sort();
            // seedlists are considered malformed by the URL() parser, so we splice it manually
            targetURL = url.toString().replace(/@[^/]+\//, `@${seedList}/`);
            break;
         // case 'loadBalanced':
         //    readPreference = 'nearest';
         //    url.searchParams.set('readPreference', readPreference);
         //    url.searchParams.set('directConnection', 'false');
         //    url.searchParams.sort();
         //    targetURL = url.toString();
         //    break;
         // default:
         //    throw new Error(`Unsupported target type: ${targetType}`);
      }

      return targetURL;
   }

   function discoverTopology() {
      /*
       *  discover topology type
       */

      const sharded = isSharded();

      // const topology = {
      //    "type": sharded ? 'sharded' : 'replSet',
      //    "mongos": sharded ? discoverMongos() : [],
      //    "csrs": sharded ? discoverCSRSshard() : [],
      //    "shards": sharded ? discoverShards() : [],
      //    // "replSet": sharded ? discoverShards() : [],
      //    "errors": []
      // };
      // topology.csrsHosts = sharded ? discoverShardedHosts(topology.csrs) : [];
      // topology.members = sharded ? discoverShardedHosts(topology.shards) : discoverRSHosts();

      const topology = {
         "type": sharded ? 'sharded' : 'replSet',
         "mongos": [],
         "csrs": [],
         "shards": [],
         "replSet": [],
         "csrsHosts": [],
         "members": [],
         "errors": []
      };

      if (sharded) {
         try {
            topology.mongos = discoverMongos();
            topology.csrs = discoverCSRSshard();
            topology.shards = discoverShards();
            topology.csrsHosts = discoverShardedHosts(topology.csrs);
            topology.members = discoverShardedHosts(topology.shards);
         } catch(e) {
            topology.errors.push(e.message);
         }
      } else {
         try {
            // topology.replSet = discoverShards();
            topology.members = discoverRSHosts();
         } catch(e) {
            topology.errors.push(e.message);
         }
      }

      return topology;
   }

   async function mongosCmd(client) {
      return 'I am a mongos found on ' + await me(client);
   }

   async function shardCmd(client) {
      return 'I am a shard primary found at ' + await me(client);
   }

   async function csrsCmd(client) {
      return 'I am the CSRS primary found at ' + await me(client);
   }

   async function csrsHostCmd(client) {
      return 'I am a CSRS member host found at ' + await me(client);
   }

   async function memberCmd(client, options) {
      return await dbList(client, options);
   }

   // async function memberCmd(client) {
   //    return 'I am a member host found at ' + await me(client);
   // }

   // async function hostCmd(client, options) {
   //    return await autoCompact(client, options);
   // }

   async function autoCompact(client, options) {
      return client.getSiblingDB('admin').runCommand({
         "autoCompact": true,
         "freeSpaceTargetMB": 1,
         "runOnce": true
      }, options);
   }

   async function dbstats(client /*, options*/) {
      const db = client;
      const options = { "output": { "format": "json" } };
      let dbStats;
      // load('dbstats.js');
      return await dbStats;
   }

   async function dbList(client, options) {
      return client.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, options).databases;
   }

   async function main() {
      /*
       *  Discover topology type:
       *  - mongos
       *  - shards
       *  - replset
       *
       *  Execute mongos/shard/mongod specific commands
       */

      /*
       *  TODO:
       *     - Add support for standalone and loadbalanced types
       */

      // get topology
      const topology = discoverTopology();
      const results = {};
      // const tasks = [];

      // Execute all tasks in parallel
      // results = await Promise.allSettled(tasks.map(({ target = {}, fn = () => {} }) => executeRemote(target, fn)));
      // Execute all tasks in serial only
      // Execute all tasks on shards in parallel serially per shard
      // Execute all tasks in a limited pool in parallel
      // Add jitter/variance to task execution (random delays)
      // Add task cancellation if connection times out
      // Add option to target replSet primary or secondaries only
      // Add default option to avoid arbiters
      // Add load monitoring metrics

      // execute commands
      if (topology.type === 'sharded') {
         results.mongos = await execAll(topology.mongos, mongosCmd, { "targetType": "mongos", "readPreference": "nearest" });
         results.csrs = await execAll(topology.csrs, csrsCmd, { "targetType": "csrs", "readPreference": "primaryPreferred" });
         results.csrsHosts = await execAll(topology.csrsHosts, csrsHostCmd, { "targetType": "mongod", "readPreference": "primaryPreferred" });
         results.shards = await execAll(topology.shards, shardCmd, { "targetType": "shard", "readPreference": "primaryPreferred" });
      }
      // results.replSet = await execAll(topology.replSet, rsCmd, { "targetType": "replSet", "readPreference": "primaryPreferred" });
      results.members = await execAll(topology.members, memberCmd, { "targetType": "mongod", "readPreference": "nearest" });

      return { topology, results };
   }

   console.log(await main());
})();

// EOF
