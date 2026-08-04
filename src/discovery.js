(async() => {
   /*
    *  Name: "discovery.js"
    *  Version: "0.1.32"
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
    *  - add SRV connection string support
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] discovery.js

   // Example: mongosh --host "replset/localhost" discovery.js

   // async function stats(client, options) {
   //    return client.getSiblingDB('admin').runCommand({ "listDatabases": 1, "nameOnly": false }, options).databases;
   // }

   function parseReplSetHosts(hostString) {
      const { setName = false, seedList = false } = /^(?<setName>[^/]+)\/(?<seedList>.+)$/.exec(hostString)?.groups || {};
      if (!setName || !seedList) throw new Error(`Invalid replSet connection string: ${hostString}`);

      return { setName, seedList };
   }

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
            ({ name, 'stateStr': role }) => { return { "host": name, "role": role } }
         );
      } catch(e) {
         // else we can just grab the list of discoverable nodes
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
         console.log('Lack the ability to discover mongos:', e.errmsg ?? e.message ?? String(e));
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
         console.log('Lack the ability to discover shards:', e.errmsg ?? e.message ?? String(e));
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
         console.log('Lack the ability to discover the CSRS:', e.errmsg ?? e.message ?? String(e));
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

   async function execMongosCmd({ 'host': hostname } = {}, cmdFn = async() => {}) {
      /*
       *  execute a command on a mongos
       */
      const url = mongoOptions();
      const readPreference = 'nearest';
      url.host = hostname;
      url.searchParams.set('readPreference', readPreference);
      url.searchParams.set('directConnection', 'true');
      const mongoURL = url.toString();
      let node;
      try {
         node = connect(mongoURL);
         return {
            "success": true,
            "process": hostname,
            "results": await cmdFn(node, { "readPreference": readPreference })
         };
      } catch(e) {
         return {
            "success": false,
            "process": hostname,
            "results": e.errmsg ?? e.message ?? String(e)
         };
      } finally {
         try { /* node.close(); */ } // cloe method not supported
         catch(_) {}
      }
   }

   async function execShardCmd({ 'host': shardString } = {}, cmdFn = async() => {}) {
      /*
       *  execute a command on a shard replset
       */
      const { setName, seedList } = parseReplSetHosts(shardString);
      const url = mongoOptions();
      const readPreference = 'primaryPreferred';
      url.port = null;
      url.searchParams.delete('directConnection');
      url.searchParams.set('readPreference', readPreference);
      url.searchParams.set('replicaSet', setName);
      url.searchParams.sort();

      let shard;
      // seedlists are considered malformed by the URL() parser, so we splice it manually
      const shardURL = url.toString().replace(/@[^/]+\//, `@${seedList}/`);
      try {
         shard = connect(shardURL);
         return {
            "success": true,
            "process": await me(shard),
            "results": await cmdFn(shard, { "readPreference": readPreference })
         };
      } catch(e) {
         return {
            "success": false,
            "process": setName,
            "results": e.errmsg ?? e.message ?? String(e)
         };
      } finally {
         try { /* node.close(); */ } // cloe method not supported
         catch(_) {}
      }
   }

   async function execHostCmd({ 'host': hostname } = {}, cmdFn = async() => {}) {
      /*
       *  execute a command on a mongod
       */
      const url = mongoOptions();
      const readPreference = 'nearest';
      url.host = hostname;
      url.searchParams.set('readPreference', readPreference);
      url.searchParams.set('directConnection', 'true');
      const directURI = url.toString();
      let node;
      try {
         node = connect(directURI);
         return {
            "success": true,
            "process": await me(node),
            "results": await cmdFn(node, { "readPreference": readPreference })
         };
      } catch(e) {
         return {
            "success": false,
            "process": hostname,
            "results": e.errmsg ?? e.message ?? String(e)
         };
      } finally {
         try { /* node.close(); */ } // cloe method not supported
         catch(_) {}
      }
   }

   async function execAllMongosesCmd(mongos = [], cmdFn = async() => {}) {
      /*
       *  async exec wrapper to parallelise tasks
       */

      return await Promise.allSettled(mongos.map(host => execMongosCmd(host, cmdFn))).then(results => {
         return results
            .filter(({ status }) => status === 'fulfilled')
            .map(({ value }) => value);
      });
   }

   async function execAllShardsCmd(shards = [], cmdFn = async() => {}) {
      /*
       *  async exec wrapper to parallelise tasks
       */

      return await Promise.allSettled(shards.map(host => execShardCmd(host, cmdFn))).then(results => {
         return results
            .filter(({ status }) => status === 'fulfilled')
            .map(({ value }) => value);
      });
   }

   async function execAllHostsCmd(hosts = [], cmdFn = async() => {}) {
      /*
       *  async exec wrapper to parallelise tasks
       */

      return await Promise.allSettled(hosts.map(host => execHostCmd(host, cmdFn))).then(results => {
         return results
            .filter(({ status }) => status === 'fulfilled')
            .map(({ value }) => value);
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

   function mongoOptions() {
      /*
       *  returns MongoClient() options to construct new connections
       */

      // TODO: add support for SRV connection string conversion

      const url = new URL(db.getMongo().getURI());
      // optimise params for direct connection and avoid conflicting options
      url.searchParams.set('directConnection', 'true');
      url.searchParams.set('readPreference', 'nearest');
      url.searchParams.delete('replicaSet');
      url.searchParams.delete('tags');
      url.searchParams.delete('readPreferenceTags');
      url.searchParams.delete('maxStalenessSeconds');
      url.searchParams.delete('minPoolSize');
      url.searchParams.delete('maxPoolSize');
      url.searchParams.delete('srvMaxHosts');
      url.searchParams.sort();

      return url;
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

      /*
       *  TODO:
       *     - Add support for standalone and loadbalanced types
       *     - Convert to topology object
       */

      let mongos = [], csrs = [], csrsHosts = [], shards = [], hosts = [];
      let allMongosResults = [],
         allCSRSResults = [],
         csrsResults = [],
         allShardResults = [],
         allHostResults = [];
      const sharded = isSharded();
      // const tasks = [];
      // let results;

      const mongosCmd = async(client) => 'I am a mongos found on ' + await me(client);
      const shardCmd = async(client) => 'I am a shard primary found at ' + await me(client);
      const csrsCmd = async(client) => 'I am the CSRS primary found at ' + await me(client);
      const csrsHostCmd = async(client) => 'I am a CSRS member host found at ' + await me(client);
      // const hostCmd = async(client) => 'I am a member host found at ' + await me(client);
      // const hostCmd = async(client, options) => await dbstats(client, options);
      const hostCmd = async(client, options) => await autoCompact(client, options);
      const autoCompact = (client, options) => client.getSiblingDB('admin').runCommand({
         "autoCompact": true,
         "freeSpaceTargetMB": 1,
         "runOnce": true
      }, options);
      // async function dbstats(client /*, options*/) {
      //    const db = client;
      //    const options = { "output": { "format": "json" } };
      //    let dbStats;
      //    // load('dbstats.js');
      //    return await dbStats;
      // }

      // discover topology
      if (sharded) {
         mongos = discoverMongos();
         csrs = discoverCSRSshard();
         shards = discoverShards();
         csrsHosts = discoverShardedHosts(csrs);
         hosts = discoverShardedHosts(shards);
      } else {
         hosts = discoverRSHosts();
      }

      // report topology
      if (sharded) {
         console.log('mongoses:', mongos);
         console.log('csrs:', csrs);
         console.log('shards:', shards);
         console.log('csrsMembers:', csrsHosts);
      }
      console.log('hosts:', hosts);

      // execute commands
      if (sharded) {
         allMongosResults = await execAllMongosesCmd(mongos, mongosCmd);
         allShardResults = await execAllShardsCmd(shards, shardCmd);
         csrsResults = await execAllShardsCmd(csrs, csrsCmd);
         allCSRSResults = await execAllHostsCmd(csrsHosts, csrsHostCmd);
      }
      allHostResults = await execAllHostsCmd(hosts, hostCmd);

      // Execute all tasks in parallel
      // results = await Promise.allSettled(tasks.map(({ target = {}, fn = () => {} }) => executeRemote(target, fn)));

      // Execute all tasks in parallel
      // Execute all tasks in serial only
      // Execute all tasks on shards in parallel serially per shard
      // Execute all tasks in a limited pool in parallel
      // Add jitter/variance to task execution (random delays)
      // Add task cancellation if connection times out
      // Add option to target replSet primary or secondaries only
      // Add default option to avoid arbiters
      // Add load monitoring metrics

      // return command results
      if (sharded) {
         console.log('All mongos CMD results:', allMongosResults);
         console.log('CSRS shard primaries CMD results:', csrsResults);
         console.log('CSRS hosts CMD results:', allCSRSResults);
         console.log('All shard primaries CMD results:', allShardResults);
      }
      console.log('All hosts CMD results:', allHostResults);

      // Process results
      // console.log(results);

      return;
   }

   await main();
})();

// EOF
