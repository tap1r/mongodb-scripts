(async() => {
   /*
    *  Name: "discovery.js"
    *  Version: "0.1.42"
    *  Description: "Topology discovery with directed command execution"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - mongosh only
    *  - support for async required to parallelise and access the topology with auth
    *  - only supports driver URI parameters, some driver options may not be supported
    *  - WARNING: debugging may leak credentials
    *
    *  TBA:
    *  - plugable cmd execution
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

   function discoverRSMembers(errors = []) {
      /*
       *  returns an array of healthy, non-hidden data bearing replica set members
       */
      try { // attempt to grab the replSet status to discover hidden nodes
         return rs.status().members.filter(
            ({ health, 'stateStr': role }) => health === 1 && role !== 'ARBITER'
         ).map(
            ({ name, 'stateStr': role }) => ({ "name": "mongod", "host": name, "role": role })
         );
      } catch(e1) {
         try {
            const { hosts = [], passives = [] } = db.hello();
            return [...hosts, ...passives].map(
               name => ({ "name": "mongod", "host": name })
            );
         } catch(e2) {
            errors.push({
               "step": "discoverRSMembers",
               "message": e2.errmsg ?? e2.message ?? String(e2)
            });
            return [];
         }
      }
   }

      function discoverRSName() {
      /*
       *  returns the replica set name
       */
      try { // attempt to grab the replSet config to discover the set name
         return rs.config()._id;
      } catch(e) { // else we can just grab the list of discoverable nodes
         return db.hello().setName;
      }
   }

   function discoverMongos(errors = []) {
      /*
       *  returns an array of available mongos instances attached to the sharded cluster
       */
      const namespace = db.getSiblingDB('config').getCollection('mongos');
      const options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": "Discovering living mongos processes"
      };
      const offsetMS = 60000; // 1min defined here because the constant is specific to this function
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
                  { "$concat": [ // potentially fragile to IPv6 format
                     { "$first": "$advisoryHostFQDNs" },
                     ":",
                     { "$arrayElemAt": [{ "$split": ["$_id", ":"] }, 1] }
                  ] }
               ]
            }
         } }
      ];
      try {
         return namespace.aggregate(pipeline, options).toArray();
      } catch(e) {
         errors.push({
            "step": "discoverMongos",
            "message": e.errmsg ?? e.message ?? String(e)
         });
         return [];
      }
   }

   function discoverShards(errors = []) {
      /*
       *  returns an array of available shards
       */
      let shards = [];
      try {
         shards = db.adminCommand({ "listShards": 1 }).shards ?? [];
      } catch(e) {
         errors.push({
            "step": "discoverShards",
            "message": e.errmsg ?? e.message ?? String(e)
         });
         return [];
      }

      return shards.filter(({ state } = {}) =>
            state === 1
         ).map(({ _id, host } = {}) => (
            { "name": _id, "host": host }
         ));
   }

   function discoverCSRSshard(errors = []) {
      /*
       *  returns an array with the CSRS 'config' shard
       */
      let csrs = [];
      try {
         csrs = db.getSiblingDB('admin').getCollection('system.version').find(
            { "_id": "shardIdentity" }
         ).toArray();
      } catch(e) {
         errors.push({
            "step": "discoverCSRSshard",
            "message": e.errmsg ?? e.message ?? String(e)
         });
         return [];
      }

      // TBA: check for non-empty csrs array first
      return csrs.map(({ shardName, configsvrConnectionString } = {}) => (
         { "name": shardName, "host": configsvrConnectionString }
      ));
   }

   function discoverShardedHosts(shards = [], errors = []) {
      /*
       *  returns an array of hosts across all available shards
       */
      if (!Array.isArray(shards)) return [];

      return shards.flatMap(({ name, host } = {}) => {
         try {
            const { setName, seedList } = parseReplSetHosts(host);
            return seedList.split(',').map(seed => ({ 'name': setName, 'host': seed }));
         } catch(e) {
            errors.push({
               "step": "discoverShardedHosts",
               "name": name,
               "host": host,
               "message": e.errmsg ?? e.message ?? String(e)
            });
            return [];
         }
      });
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
       *  setting read preferences to a specific target doesn't necessarily align with cmdFn read preferences
       *  therefore the operator will need to exercise discretion for the appropriate read preferences per command
       */

      // Document shape
      // {
      //    "success": <bool>, // execution status
      //    "target": <string>, // what actually got targetted
      //    "process": <string>, // what we tried to target
      //    "name": <string>, // name of the target
      //    "host": <string>, // host of the target
      //    "cmdOpts": <object>, // command options
      //    "results": <array|object> | <null>, // command results or null
      //    "error": <string> | <null> // reported errors or null
      // }

      try {
         const node = connect(buildConnectionURI({ host, targetType }));
         return {
            "success": true,
            "target": await me(node),
            "process": targetType,
            "name": name,
            "host": host,
            "cmdOpts": { "readPreference": readPreference },
            "results": await cmdFn(node, { "readPreference": readPreference }),
            "error": null
         };
      } catch(e) {
         return {
            "success": false,
            "target": host ?? name ?? 'unknown',
            "process": targetType,
            "name": name,
            "host": host,
            "cmdOpts": { "readPreference": readPreference },
            "results": null,
            "error": e.errmsg ?? e.message ?? String(e)
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
               "target": null,
               "process": options.targetType,
               "name": null,
               "host": null,
               "cmdOpts": { "readPreference": options.readPreference },
               "results": null,
               "error": String(reason)
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
       *  is load balanced topology (Flex cluster?)
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
       *  returns MongoClient() URI to construct new targetted connections
       *  by design, the discovery scope is limited to the current 'db' context
       */

      // TODO: add support for SRV connection string conversion

      const url = new URL(db.getMongo().getURI());
      let targetURL = '';
      // optimise params for direct connection and avoid conflicting options
      url.searchParams.delete('tags');
      url.searchParams.delete('readPreferenceTags');
      url.searchParams.delete('maxStalenessSeconds');
      url.searchParams.delete('minPoolSize');
      url.searchParams.delete('maxPoolSize');
      url.searchParams.delete('srvMaxHosts');

      const mode = ['shard', 'csrs', 'replSet'].includes(targetType) ? 'replSet' : 'direct';
      switch (mode) {
         case 'direct': {
            url.host = host;
            url.searchParams.delete('replicaSet');
            url.searchParams.set('readPreference', 'nearest');
            url.searchParams.set('directConnection', 'true');
            url.searchParams.sort();
            targetURL = url.toString();
            break;
         }
         case 'replSet': {
            const { setName, seedList } = parseReplSetHosts(host);
            url.searchParams.set('readPreference', 'primaryPreferred');
            url.searchParams.set('directConnection', 'false');
            url.searchParams.set('replicaSet', setName);
            url.searchParams.sort();
            // seedlists are considered malformed by the URL() parser, so we splice it manually
            targetURL = url.toString().replace(/@[^/]+\//, `@${seedList}/`);
            break;
         }
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
      const topology = {
         "type": sharded ? 'sharded' : 'replSet',
         "mongos": [],
         "csrs": [],
         "shards": [],
         "replSetName": '',
         "csrsHosts": [],
         "members": [],
         "errors": []
      };
      if (sharded) {
         topology.mongos = discoverMongos(topology.errors);
         topology.csrs = discoverCSRSshard(topology.errors);
         topology.shards = discoverShards(topology.errors);
         topology.csrsHosts = discoverShardedHosts(topology.csrs, topology.errors);
         topology.members = discoverShardedHosts(topology.shards, topology.errors);
      } else {
         topology.replSetName = discoverRSName();
         topology.members = discoverRSMembers();
      }

      return topology;
   }

   async function mongosCmd(client, options) {
      // return 'I am a mongos found on ' + await me(client);
      return await whatsmyuri(client, options);
   }

   async function shardCmd(client, options) {
      return 'I am a shard primary found at ' + await me(client);
   }

   async function csrsCmd(client, options) {
      return 'I am the CSRS primary found at ' + await me(client);
   }

   async function csrsHostCmd(client, options) {
      // https://www.mongodb.com/docs/manual/reference/supported-shard-direct-commands/
      return 'I am a CSRS member host found at ' + await me(client);
   }

   async function memberCmd(client, options) {
      // https://www.mongodb.com/docs/manual/reference/supported-shard-direct-commands/
      return await whatsmyuri(client, options);
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

   // async function dbstats(client /*, options*/) {
   //    const db = client;
   //    const options = { "output": { "format": "json" } };
   //    let dbStats;
   //    // load('dbstats.js');
   //    return await dbStats();
   // }

   async function dbList(client, options) {
      return client.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, options).databases;
   }

   async function appendOplogNote(client, options) {
      return await client.adminCommand({
         "appendOplogNote": 1,
         "data": {
            "msg": "Advance the change stream highwatermark token timestamp"
         }
      }, options);
   }

   async function shardingState(client, options) {
      return await client.adminCommand({
         "shardingState": 1
      }, options);
   }

   async function whatsmyuri(client, options) {
      return await client.adminCommand({ "whatsmyuri": 1 }, options);
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
