/*
 *  Name: "dbstats.js"
 *  Version: "0.12.19"
 *  Description: "DB storage stats uber script"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: [mongo|mongosh] [connection options] --quiet [--eval 'var options = {...};'] [-f|--file] </path/to/>dbstats.js

/*
 *  options = {
 *     filter: {
 *        db: <null|<string>|/<regex>/>,
 *        collection: <null|<string>|/<regex>/>,
 *        system: <true|false|'include'|'exclude'|'only'> // default true/'include'; system.*|replset.*
 *     },
 *     sort: {
 *        db: {
 *           name: <1|0|-1>,
 *           dataSize: <1|0|-1>,
 *           storageSize: <1|0|-1>,
 *           freeStorageSize: <1|0|-1>,
 *           idxStorageSize: <1|0|-1>, // TBA
 *           idxFreeStorageSize: <1|0|-1>, // TBA
 *           reuse: <1|0|-1>, // TBA
 *           idxReuse: <1|0|-1>, // TBA
 *           compaction: <1|0|-1>, // TBA
 *           compression: <1|0|-1>, // TBA
 *           objects: <1|0|-1>
 *        },
 *        collection: {
 *           name: <1|0|-1>,
 *           dataSize: <1|0|-1>,
 *           storageSize: <1|0|-1>,
 *           freeStorageSize: <1|0|-1>,
 *           reuse: <1|0|-1>, // TBA
 *           compaction: <1|0|-1>, // TBA
 *           compression: <1|0|-1>, // TBA
 *           objects: <1|0|-1>
 *        },
 *        view: {
 *           name: <1|0|-1>
 *        },
 *        namespace: {
 *           namespace: <1|0|-1>,
 *           dataSize: <1|0|-1>,
 *           storageSize: <1|0|-1>,
 *           freeStorageSize: <1|0|-1>,
 *           reuse: <1|0|-1>,
 *           compaction: <1|0|-1>,
 *           compression: <1|0|-1>,
 *           objects: <1|0|-1>
 *        },
 *        index: {
 *           name: <1|0|-1>,
 *           idxDataSize: <1|0|-1>, // TBA (inferred from "storageSize - freeStorageSize")
 *           idxStorageSize: <1|0|-1>,
 *           idxFreeStorageSize: <1|0|-1>,
 *           reuse: <1|0|-1>, // TBA
 *           compaction: <1|0|-1> // TBA
 *        }
 *     },
 *     limit: { // TBA
 *        dataSize: <int>,
 *        storageSize: <int>,
 *        freeStorageSize: <int>,
 *        reuse: <int>,
 *        compression: <int>,
 *        objects: <int>
 *     },
 *     output: {
 *        format: <'tabular'|'table'|'nsTable'|'json'|'html'>, // 'table' aliases 'tabular'
 *        topology: <'summary'|'expanded'>, // TBA
 *        colour: <true|false>, // TBA
 *        verbosity: <'full'|'summary'|'summaryIdx'|'compactOnly'/> // TBA
 *     },
 *     topology: { // TBA
 *        discover: <true|false>,
 *        replica: <'summary'|'expanded'>,
 *        sharded: <'summary'|'expanded'>
 *     }
 *  }
 */

/*
 *  Examples of using filters with namespace regex:
 *
 *    mongosh --quiet --eval 'var options = { filter: { db: "^database$" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { filter: { collection: "^c.+" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { filter: { db: /(^(?!(d.+)).+)/i, collection: /collection/i } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { filter: { system: false } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { filter: { system: "only" } };' -f dbstats.js
 *
 *  Examples of using sorting:
 *
 *    mongosh --quiet --eval 'var options = { sort: { collection: { dataSize: -1 }, index: { idxStorageSize: -1 } } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { sort: { collection: { freeStorageSize: -1 }, index: { idxFreeStorageSize: -1 } } };' -f dbstats.js
 *
 *  Examples of using formatting:
 *
 *    mongosh --quiet --eval 'var options = { output: { format: "tabular" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { format: "table" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { format: "json" } };' -f dbstats.js
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 *  We overwrite options with var due to mongosh sloppy mode processing
 */

(() => {
   const __script = { "name": "dbstats.js", "version": "0.12.19" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
         __lib.paths = [_getEnv('MDBLIB'), `${_getEnv('HOME')}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fileExists(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else if (typeof process !== 'undefined') { // mongosh process.env attribute
         __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else {
         print(`[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
      // Fix: Namespace the library. Instead of global.$stats = ..., use global.mdblib = { $stats: ..., MetaStats: ... } and access via mdblib.$stats
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   // console.clear();
   console.log(`\n\n[yellow]${__comment}[/]`);
})();

(() => {
   /*
    *  Minimum useful roles for a full report:
    *  clusterMonitor@admin && readAnyDatabase@admin
    *  (or a stronger admin role). Unauthenticated / localhost exception skips the warn.
    */
   try {
      db.adminCommand({ "features": 1 });
   } catch(e) {
      // Legacy mongo often has code 13 / errmsg only — same idea as $collStats.
      if (e.codeName == 'Unauthorized' || +e.code === 13
            || /not authorized|unauthorized/i.test(e.errmsg || e.message || '')) {
         console.log('[red][ERR] MongoServerError: Unauthorized user requires authentication[/]');
      }
   }

   const monitorRoles = ['clusterMonitor'];
   const adminRoles = ['atlasAdmin', 'clusterAdmin', 'backup', 'root', '__system'];
   const dbRoles = ['dbAdminAnyDatabase', 'readAnyDatabase', 'readWriteAnyDatabase'];

   const { 'authInfo': { authenticatedUsers, authenticatedUserRoles } }
      = db.adminCommand({ "connectionStatus": 1 });

   const hasAdminRole = authenticatedUserRoles.some(
      ({ role, db: roleDb }) => adminRoles.includes(role) && roleDb == 'admin'
   );
   const hasMonitorRole = authenticatedUserRoles.some(
      ({ role, db: roleDb }) => monitorRoles.includes(role) && roleDb == 'admin'
   );
   const hasReadAnyRole = authenticatedUserRoles.some(
      ({ role, db: roleDb }) => dbRoles.includes(role) && roleDb == 'admin'
   );

   const isUnauthenticated = authenticatedUsers.length === 0; // localhost exception / auth off
   const hasMonitorAndRead = hasMonitorRole && hasReadAnyRole;
   const authzAdequate = isUnauthenticated || hasAdminRole || hasMonitorAndRead;

   if (!authzAdequate) {
      console.log(`[red][WARN] The connecting user's authz privileges may be inadequate to report all namespaces statistics[/]`);
      console.log(`[red][WARN] consider inheriting the built-in roles for 'clusterMonitor@admin' and 'readAnyDatabase@admin' at a minimum[/]`);
   }
})();

// (async(db, options, dbstats = {}) => {
(async() => {
   /*
    *  User defined parameters
    */
   const optionsDefaults = {
      "filter": {
         "db": new RegExp(/.+/),
         "collection": new RegExp(/.+/),
         "system": true // true|'include' (default) | false|'exclude' | 'only' — see mdblib systemCollectionFilter
      },
      "sort": {
         "db": {
            "name": 0,
            "dataSize": 0,
            "storageSize": 0,
            "idxStorageSize": 0, // TBA
            "freeStorageSize": 0,
            "idxFreeStorageSize": 0, // TBA
            "reuse": 0, // TBA
            "idxReuse": 0, // TBA
            "compression": 0,
            "objects": 0,
            "compaction": 0 // TBA
         },
         "collection": {
            "name": 0,
            "dataSize": 0,
            "storageSize": 0,
            "freeStorageSize": 0,
            "reuse": 0, // TBA
            "compression": 0,
            "objects": 0,
            "compaction": 0 // TBA
         },
         "view": {
            "name": 1
         },
         "namespace": {
            "name": 0, // do not use
            "namespace": 0,
            "dataSize": 0,
            "storageSize": 0,
            "freeStorageSize": 0,
            "reuse": 0, // TBA
            "compression": 0, // TBA
            "objects": 0,
            "compaction": 0 // TBA
         },
         "index": {
            "name": 0,
            "idxDataSize": 0, // TBA (inferred from "storageSize - freeStorageSize")
            "idxStorageSize": 0,
            "idxFreeStorageSize": 0,
            "reuse": 0, // TBA
            "compaction": 0 // TBA
         }
      },
      "limit": { // TBA
         "dataSize": 0,
         "storageSize": 0,
         "freeStorageSize": 0,
         "reuse": 0,
         "compression": 0,
         "objects": 0
      },
      "output": {
         "format": "tabular", // ['tabular'|'table'|'nsTable'|'json'|'html'] ('table' → 'tabular')
         "topology": "summary", // ['summary'|'expanded'] // TBA
         "colour": true, // [true|false] // TBA
         "verbosity": "full" // ['full'|'summary'|'summaryIdx'|'compactOnly'] // TBA
      },
      "topology": { // TBA
         "discover": true, // [true|false]
         "replica": "summary", // ['summary'|'expanded']
         "sharded": "summary" // ['summary'|'expanded']
      }
   };
   // Partial user overrides must not wipe sibling defaults (shallow merge was wrong for sort.*).
   typeof options === 'undefined' && (options = {});
   const filterOptions = { ...optionsDefaults.filter, ...(options.filter || {}) };
   const sortOptions = {};
   for (const section of Object.keys(optionsDefaults.sort)) {
      sortOptions[section] = {
         ...optionsDefaults.sort[section],
         ...((options.sort || {})[section] || {})
      };
   }
   const outputOptions = { ...optionsDefaults.output, ...(options.output || {}) };
   // const limitOptions = { ...optionsDefaults.limit, ...(options.limit || {}) };
   // const topologyOptions = { ...optionsDefaults.topology, ...(options.topology || {}) };

   /*
    *  Global defaults
    */

   // scalar unit B, KiB, MiB, GiB, TiB, PiB
   const scaled = new AutoFactor();

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 137) || termWidth;
   typeof columnWidth === 'undefined' && (columnWidth = 14) || columnWidth;
   typeof rowHeader === 'undefined' && (rowHeader = 40) || rowHeader;

   // connection preferences
   typeof readPref === 'undefined' && (readPref = (hello().secondary) ? 'secondaryPreferred' : 'primaryPreferred');

   async function main() {
      /*
       *  main
       */
      let { 'format': formatOutput = 'tabular' } = outputOptions;
      if (formatOutput === 'table') formatOutput = 'tabular'; // alias

      slaveOk(readPref);
      const dbStats = await getStats();

      switch (formatOutput) {
         case 'json':
            jsonOut(dbStats);
            // return dbStats;
            // dbStats
            break;
         case 'html':
            htmlOut(dbStats);
            break;
         case 'nsTable':
            nsTableOut(dbStats);
            break;
         case 'tabular':
         default:
            tableOut(dbStats);
      }

      return;
   }

   async function getStats() {
      /*
       *  Gather DB stats
       */
      let { 'db': dbFilter, 'collection': collFilter, 'system': systemOpt = true } = filterOptions;
      collFilter = new RegExp(collFilter);
      const acceptCollName = systemCollectionFilter(systemOpt);
      let dbPath = new MetaStats();
      dbPath.init();
      delete dbPath.name;
      delete dbPath.collections;
      delete dbPath.views;
      // delete dbPath.indexes;
      // delete dbPath.nindexes;
      delete dbPath.compressor;

      const dbNames = stableSort(getDBNames(dbFilter), compareBy(v => v, 1));
      console.log('');
      // Map: build per-DB metas only. Reduce: rollupDbPath aggregates totals (no map side-effects).
      dbPath.databases = dbNames.map(dbName => buildDatabaseMeta(dbName, dbPath.shards));
      rollupDbPath(dbPath, dbPath.databases);

      // add debug clause
      // if (dbPath.shards.length > 0) {
      //    console.log(
      //       'Discovered distributed namespaces:',
      //       JSON.stringify(
      //          dbPath.shards.map((shard, _i) => {
      //             return { [shard]: dbPath.namespaces[_i] }
      //          }), null, 3
      //       ).replace(/(?<![\[])(?:\n\s+)/g, ' '); // legacy shell doesn't support this
      //    );
      //    console.log(
      //       'Discovered distributed indexes:',
      //       JSON.stringify(
      //          dbPath.shards.map((shard, _i) => {
      //             return { [shard]: dbPath.nindexes[_i] }
      //          }), null, 3
      //       ).replace(/(?<![\[])(?:\n\s+)/g, ' '); // legacy shell doesn't support this
      //    );
      // } else {
      //    console.log('Discovered', dbPath.namespaces, 'distinct namespaces');
      //    console.log('Discovered', dbPath.nindexes, 'distinct indexes');
      // }

      let collNamesTasks = dbPath.databases.map(async database => {
         database.collections = (shellVer(2.0) && isMongosh())
            ? db.getSiblingDB(database.name).getCollectionInfos({ // mongosh v2 optimised
                  "type": /^(collection|timeseries)$/,
                  "name": collFilter
               },
               { "nameOnly": true },
               true
              )
            : db.getSiblingDB(database.name).getCollectionInfos({ // legacy shell(s) method
                  "type": /^(collection|timeseries)$/,
                  "name": collFilter
               },
               isMongosh() ? { "nameOnly": true } : true,
               true
              );
         database.collections = stableSort(
            database.collections.filter(acceptCollName),
            compareBy('name', 1)
         );
         database.views = (shellVer(2.0) && isMongosh())
            ? db.getSiblingDB(database.name).getCollectionInfos({ // mongosh v2 optimised
                  "type": "view",
                  "name": collFilter
               },
               { "nameOnly": true },
               true
              )
            : db.getSiblingDB(database.name).getCollectionInfos({ // legacy shell(s) method
                  "type": "view",
                  "name": collFilter
               },
               isMongosh() ? { "nameOnly": true } : true,
               true
              );
         database.views = stableSort(
            database.views.filter(acceptCollName),
            sortBy('view')
         );

         return database;
      });
      dbPath.databases = await Promise.all(collNamesTasks);

      const dbFetchTasks = dbPath.databases.map(async database => {
         const collFetchTasks = database.collections.map(async({ 'name': collName }) => {
            // Prefer catalog name if $collStats stub/defaults omit it (legacy Unauthorized without codeName).
            let collection = new MetaStats($collStats(database.name, collName) || { "name": collName });
            if (!collection.name) collection.name = collName;
            delete collection.databases;
            delete collection.collections;
            delete collection.views;
            delete collection.ncollections;
            delete collection.nviews;
            delete collection.namespaces;
            delete collection.instance;
            delete collection.hostname;
            delete collection.proc;
            delete collection.dbPath;
            collection.indexes = stableSort(collection.indexes || [], sortBy('index'));

            return collection;
         });
         database.collections = await Promise.all(collFetchTasks);
         database.collections = stableSort(database.collections, sortBy('collection'));
         // database.views already listed + sorted in collNamesTasks (nameOnly);
         // collections above may be tagged "(unauthorized)" by $collStats on auth failure

         return database;
      });
      dbPath.databases = await Promise.all(dbFetchTasks);
      dbPath.databases = stableSort(dbPath.databases, sortBy('db'));

      // If every namespace hid WT free-space, don't keep a db.stats() 0 as an empty free list.
      dbPath.databases.forEach(database => {
         if (database.collections.length && database.collections.every(c => c.freeStorageSize == null)) {
            database.freeStorageSize = null;
         }
         if (database.collections.length && database.collections.every(c =>
               c.totalIndexBytesReusable == null && (c.indexes || []).every(i => i.freeStorageSize == null))) {
            database.totalIndexBytesReusable = null;
         }
      });
      if (dbPath.databases.length && dbPath.databases.every(d => d.freeStorageSize == null)) {
         dbPath.freeStorageSize = null;
      }
      if (dbPath.databases.length && dbPath.databases.every(d => d.totalIndexBytesReusable == null)) {
         dbPath.totalIndexBytesReusable = null;
      }

      return dbPath;
   }

   function buildDatabaseMeta(dbName, shards = []) {
      /*
       *  Pure-ish: $stats → MetaStats for one DB (no cluster rollup mutation)
       */
      let database = new MetaStats($stats(dbName));
      delete database.databases;
      delete database.instance;
      delete database.hostname;
      delete database.proc;
      delete database.dbPath;
      database.shards = shards;
      return database;
   }

   function sumNullable(values) {
      /*
       *  Sum numbers; any null/undefined → null (Atlas hidden free-space propagates)
       */
      if (!values.length) return 0;
      if (values.some(v => v == null)) return null;
      return values.reduce((a, b) => a + b, 0);
   }

   function sumPerShard(arrays, nShards) {
      const zeros = Array(nShards).fill(0);
      return arrays.reduce(
         (acc, arr) => acc.map((v, i) => v + (+((arr && arr[i]) || 0))),
         zeros
      );
   }

   function rollupDbPath(dbPath, databases = []) {
      /*
       *  Aggregate database metas into dbPath totals (sharded arrays or scalars).
       *  Empty catalog: sharded → zero-filled per-shard arrays; unsharded → leave MetaStats defaults.
       */
      const nShards = dbPath.shards.length;
      if (!databases.length) {
         if (nShards > 0) {
            const zeros = Array(nShards).fill(0);
            dbPath.ncollections = zeros;
            dbPath.nviews = zeros.slice();
            dbPath.namespaces = zeros.slice();
            dbPath.indexes = zeros.slice();
            dbPath.nindexes = dbPath.indexes;
         }
         return dbPath;
      }
      if (nShards > 0) {
         dbPath.ncollections = sumPerShard(databases.map(d => d.ncollections), nShards);
         dbPath.nviews = sumPerShard(databases.map(d => d.nviews), nShards);
         dbPath.namespaces = sumPerShard(databases.map(d => d.namespaces), nShards);
         dbPath.indexes = sumPerShard(databases.map(d => d.indexes), nShards);
         dbPath.nindexes = dbPath.indexes;
      } else {
         dbPath.ncollections = databases.reduce((s, d) => s + d.ncollections, 0);
         dbPath.nviews = databases.reduce((s, d) => s + d.nviews, 0);
         dbPath.namespaces = databases.reduce((s, d) => s + d.namespaces, 0);
         dbPath.nindexes = databases.reduce((s, d) => s + +d.indexes, 0);
      }
      dbPath.dataSize = databases.reduce((s, d) => s + d.dataSize, 0);
      dbPath.storageSize = databases.reduce((s, d) => s + d.storageSize, 0);
      dbPath.objects = databases.reduce((s, d) => s + d.objects, 0);
      dbPath.orphans = databases.reduce((s, d) => s + d.orphans, 0);
      dbPath.totalIndexSize = databases.reduce((s, d) => s + d.totalIndexSize, 0);
      dbPath.freeStorageSize = sumNullable(databases.map(d => d.freeStorageSize));
      dbPath.totalIndexBytesReusable = sumNullable(databases.map(d => d.totalIndexBytesReusable));
      return dbPath;
   }

   function tableOut(dbStats = {}) {
      /*
       *  Print plain tabular report
       */
      dbStats.databases.forEach(database => {
         printDbHeader(database);
         printCollHeader(database.collections.length);
         database.collections.forEach(collection => {
            printCollection(collection);
            collection.indexes.forEach(printIndex);
         });
         printViewHeader(database.views.length);
         database.views.forEach(({ name }) => printView(name));
         printDb(database);
      });
      printDbPath(dbStats);

      return;
   }

   function nsTableOut(dbStats = {}) {
      /*
       *  Print aggregated namespaces tabular report
       */
      const namespaces = dbStats.databases.flatMap(database => {
         return database.collections.reduce((collections, collection) => {
            const namespace = database.name + '.' + collection.name;
            delete collection.name;
            const updatedCollection = { ...{ "namespace": namespace }, ...collection, ...{ compression: 0 }
            // , ...{ get compression() {
            //    return this.dataSize / (this.storageSize - this.freeStorageSize);
            // } }
            };
            collections.push(updatedCollection);
            return collections;
         }, []);
      });
      const sortedNamespaces = stableSort(namespaces, sortBy('namespace'));

      printNSHeader(sortedNamespaces.length);
      sortedNamespaces.forEach(namespace => {
         printNamespace(namespace);
         namespace.indexes.forEach(printIndex);
      });
      printDbPath(dbStats);

      return;
   }

   function jsonOut(dbStats = {}) {
      /*
       *  JSON out
       */
      console.log('');
      printjson(dbStats);

      return;
   }

   function htmlOut(dbStats = {}) {
      /*
       *  HTML out
       */
      console.log('HTML support TBA');

      return;
   }

   function compareBy(keyOrGetter, dir = 1) {
      /*
       *  Comparator factory: string key or getter, dir 1|-1. Null/non-finite numerics sort last.
       */
      const get = (typeof keyOrGetter === 'function') ? keyOrGetter : (o => o[keyOrGetter]);
      return (a, b) => {
         const av = get(a), bv = get(b);
         if (typeof av === 'string' && typeof bv === 'string')
            return dir * av.localeCompare(bv);
         const an = (av == null) ? NaN : +av, bn = (bv == null) ? NaN : +bv;
         const aOk = Number.isFinite(an), bOk = Number.isFinite(bn);
         if (aOk && bOk) return dir * (an - bn);
         if (aOk !== bOk) return aOk ? -1 : 1; // finite before null/NaN
         if (av == null && bv == null) return 0;
         return dir * String(av).localeCompare(String(bv));
      };
   }

   function stableSort(arr, cmp) {
      /*
       *  Non-mutating sort: toSorted on mongosh 2+, copy+.sort otherwise.
       */
      if (!Array.isArray(arr)) return arr;
      return (shellVer(2.0) && isMongosh()) ? arr.toSorted(cmp) : arr.slice().sort(cmp);
   }

   function sortBy(type) {
      /*
       *  Resolve options.sort[type] → comparator (first non-zero key wins).
       */
      const sortByType = sortOptions[type] || {};
      const sortKey = Object.keys(sortByType).find(key => sortByType[key] !== 0) || 'name';
      const dir = sortByType[sortKey] === -1 ? -1 : 1;
      const getters = {
         "name": o => o.name,
         "namespace": o => o.namespace,
         "dataSize": o => o.dataSize,
         "storageSize": o => o.storageSize,
         "freeStorageSize": o => o.freeStorageSize,
         "idxDataSize": o => (o.freeStorageSize == null) ? null : (o.storageSize - o.freeStorageSize),
         "idxStorageSize": o => o.storageSize,
         "idxFreeStorageSize": o => o.freeStorageSize,
         "objects": o => o.objects,
         "reuse": o => o.freeStorageSize, // TBA: reuse ratio
         "compression": o => o.compression,
         "compaction": o => o.name // TBA
      };

      return compareBy(getters[sortKey] || getters.name, dir);
   }

   function formatUnit(metric) {
      /*
       *  Pretty format unit
       */
      return scaled.format(metric);
   }

   function formatPct(numerator = 0, denominator = 1) {
      /*
       *  Pretty format percentage. Zero/null/NaN denominator → n/a (not Infinity%/NaN%).
       */
      const num = +numerator, den = +denominator;
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 'n/a';
      return `${Number.parseFloat(((num / den) * 100).toFixed(1))}%`;
   }

   function freeStorageKnown(bytes) {
      return bytes != null && !Number.isNaN(+bytes);
   }

   function formatFree(bytes, storageSize) {
      /*
       *  Free blocks │ reuse. Hidden WT free-space (Atlas M0/Flex) → n/a, not 0.
       */
      if (!freeStorageKnown(bytes)) {
         return (`n/a │${'n/a'.padStart(6)}`).padStart(columnWidth + 8);
      }
      return (formatUnit(bytes) + ' │' + formatPct(bytes, storageSize).padStart(6)).padStart(columnWidth + 8);
   }

   function formatCompaction(kind, storageSize, freeStorageSize, { oplog = false, idIndex = false } = {}) {
      if (!freeStorageKnown(freeStorageSize)) return 'n/a';
      if (kind === 'collection') {
         if (oplog && compactionHelper('collection', storageSize, freeStorageSize)) return 'wait';
         return compactionHelper('collection', storageSize, freeStorageSize) ? 'compact' : '———— ';
      }
      if (kind === 'index') {
         if (idIndex && compactionHelper('index', storageSize, freeStorageSize)) return 'compact';
         return compactionHelper('index', storageSize, freeStorageSize) ? 'rebuild' : '———— ';
      }
      if (kind === 'dbPath') {
         return compactionHelper('dbPath', storageSize, freeStorageSize) ? 'resync' : '———— ';
      }
      return '———— ';
   }

   function formatRatio(metric) {
      /*
       *  Pretty format compression ratio. Non-finite (÷0 from MetaStats.compression) → n/a.
       */
      const value = +metric;
      if (!Number.isFinite(value)) return 'n/a';
      return `${Number.parseFloat(value.toFixed(2))}:1`;
   }

   function printRule(style = 'light', width = termWidth) {
      const ch = (style === 'heavy') ? '═' : '━';
      console.log(`[yellow]${ch.repeat(width)}[/]`);
   }

   function columnHeaders() {
      return `${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks │ reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Compaction'.padStart(columnWidth - 1)}`;
   }

   function formatShardCounts(shards, counts) {
      /*
       *  Inline per-shard count map for rollup rows
       */
      return JSON.stringify(
         shards.map((shard, i) => ({ [shard]: counts[i] })),
         null, 3
      ).replace(/(?:\n\s+)|(?:\n)/g, ' ');
   }

   function truncateLabel(label, maxLen, cutWidth) {
      label = (label == null) ? '' : String(label);
      return (label.length > maxLen) ? `${label.substring(0, cutWidth)}~` : label;
   }

   function formatCompressionCell(compression, compressor) {
      if (compressor == null || compressor === '')
         return formatRatio(compression).padStart(columnWidth + 1);
      const abbr = (compressor == 'snappy') ? 'snpy' : compressor;
      return (formatRatio(compression) + abbr.padStart(abbr.length + 1)).padStart(columnWidth + 1);
   }

   function metricsCols({
         dataSize = 0, compression = 0, compressor, storageSize = 0, freeStorageSize = 0,
         objects, compaction = '———— ', mode = 'full'
      } = {}) {
      /*
       *  Shared metric columns: full NS row | index rollup | index detail row
       */
      const compact = String(compaction).padStart(columnWidth - 2);
      if (mode === 'indexRow') {
         return `${formatUnit(storageSize).padStart(columnWidth)} ${formatFree(freeStorageSize, storageSize)} ${''.padStart(columnWidth)} [cyan]${compact}[/]`;
      }
      if (mode === 'indexRollup') {
         return `${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${formatFree(freeStorageSize, storageSize)} ${''.padStart(columnWidth)} [cyan]${compact}[/]`;
      }
      const obj = (objects == null ? '' : objects.toString()).padStart(columnWidth);
      return `${formatUnit(dataSize).padStart(columnWidth)} ${formatCompressionCell(compression, compressor)} ${formatUnit(storageSize).padStart(columnWidth)} ${formatFree(freeStorageSize, storageSize)} ${obj} [cyan]${compact}[/]`;
   }

   function printRollupRows({
         shards = [], dataSize, compression, storageSize, freeStorageSize, objects,
         namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         nsLabel, idxLabel, nsCompactionKind = 'collection'
      } = {}) {
      /*
       *  Shared DB / dbPath namespace + index subtotal rows (sharded or not)
       */
      const nsCompaction = formatCompaction(nsCompactionKind, storageSize, freeStorageSize);
      const idxCompaction = formatCompaction('index', totalIndexSize, totalIndexBytesReusable);
      const nsMetrics = metricsCols({
         dataSize, compression, storageSize, freeStorageSize, objects, "compaction": nsCompaction
      });
      const idxMetrics = metricsCols({
         "storageSize": totalIndexSize,
         "freeStorageSize": totalIndexBytesReusable,
         "compaction": idxCompaction,
         "mode": 'indexRollup'
      });
      if (shards.length > 0) {
         console.log(`[bold][green]${`${nsLabel}:[/]`.padEnd(rowHeader + 4)}${nsMetrics}`);
         console.log(formatShardCounts(shards, namespaces));
         console.log(`[bold][green]${`${idxLabel}:[/]`.padEnd(rowHeader + 4)}${idxMetrics}`);
         console.log(formatShardCounts(shards, nindexes));
      } else {
         console.log(`[bold][green]${`${nsLabel}:[/] ${JSON.stringify(namespaces)}`.padEnd(rowHeader + 4)}${nsMetrics}`);
         console.log(`[bold][green]${`${idxLabel}:[/]    ${JSON.stringify(nindexes)}`.padEnd(rowHeader + 4)}${idxMetrics}`);
      }
   }

   function printCollHeader(collTotal = 0) {
      printRule('light');
      console.log(`[bold][green]Collections:[/] ${collTotal}`);
      return;
   }

   function printNSHeader(nsTotal = 0) {
      console.log('');
      printRule('heavy');
      console.log(`[bold][green]${`Namespaces:[/] ${nsTotal}`.padEnd(rowHeader + 4)}[/] [bold][green]${columnHeaders()}[/]`);
      return;
   }

   function printCollection({ name, dataSize, compression, compressor, storageSize, freeStorageSize, objects } = {}) {
      const compaction = formatCompaction('collection', storageSize, freeStorageSize, { "oplog": name == 'oplog.rs' });
      printRule('light');
      name = truncateLabel(name, 45, rowHeader - 4);
      console.log(`╰>[cyan]${(' ' + name).padEnd(rowHeader - 2)}[/] ${metricsCols({ dataSize, compression, compressor, storageSize, freeStorageSize, objects, compaction })}`);
      return;
   }

   function printNamespace({ namespace, dataSize, compression, compressor, storageSize, freeStorageSize, objects } = {}) {
      const compaction = formatCompaction('collection', storageSize, freeStorageSize, { "oplog": namespace == 'local.oplog.rs' });
      printRule('light');
      namespace = truncateLabel(namespace, 45, rowHeader - 4);
      console.log(`╰>[cyan]${(' ' + namespace).padEnd(rowHeader - 2)}[/] ${metricsCols({ dataSize, compression, compressor, storageSize, freeStorageSize, objects, compaction })}`);
      return;
   }

   function printViewHeader(viewTotal = 0) {
      printRule('light');
      console.log(`[bold][green]Views:[/] ${viewTotal}`);
      return;
   }

   function printView(viewName = 'unknown') {
      printRule('light');
      console.log(` [cyan]${viewName}[/]`);
      return;
   }

   function printIndex({ name, storageSize, freeStorageSize } = {}) {
      const indexWidth = rowHeader + columnWidth * 2;
      const compaction = formatCompaction('index', storageSize, freeStorageSize, { "idIndex": name == '_id_' });
      console.log(`  [yellow]${'━'.repeat(termWidth - 2)}[/]`);
      name = truncateLabel(name, 64, indexWidth);
      console.log(`  ╰» [red]${name.padEnd(indexWidth - 2)}[/] ${metricsCols({ storageSize, freeStorageSize, compaction, "mode": 'indexRow' })}`);
      return;
   }

   function printDbHeader({ name } = {}) {
      console.log('');
      printRule('heavy');
      console.log(`[bold][green]${`Database:[/] [cyan]${name}`.padEnd(rowHeader + 9)}[/] [bold][green]${columnHeaders()}[/]`);
      return;
   }

   function printDb({
         shards, dataSize, compression, storageSize, freeStorageSize, objects, namespaces, nindexes, totalIndexSize, totalIndexBytesReusable
      } = {}) {
      printRule('light');
      printRollupRows({
         shards, dataSize, compression, storageSize, freeStorageSize, objects,
         namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         "nsLabel": 'Namespaces subtotal',
         "idxLabel": 'Indexes subtotal',
         "nsCompactionKind": 'collection'
      });
      printRule('heavy');
      return;
   }

   function printDbPath({
         dbPath, shards, proc, hostname, compression, dataSize, storageSize, freeStorageSize, objects, namespaces, nindexes, totalIndexSize, totalIndexBytesReusable
      } = {}) {
      console.log('');
      printRule('heavy');
      console.log(`[bold][green]${'dbPath totals'.padEnd(rowHeader)} ${columnHeaders()}[/]`);
      printRule('light');
      printRollupRows({
         shards, dataSize, compression, storageSize, freeStorageSize, objects,
         namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         "nsLabel": 'All namespaces',
         "idxLabel": 'All indexes',
         "nsCompactionKind": 'dbPath'
      });
      printRule('heavy');
      console.log(`[bold][green]Hostname:[/] [cyan]${hostname}[/]   [bold][green]Type:[/] [cyan]${proc}[/]   [bold][green]Version:[/] [cyan]${db.version()}[/]   [bold][green]dbPath:[/] [cyan]${dbPath}[/]`);
      if (shards.length > 0) {
         console.log(`[bold][green]Shards:[/] ${JSON.stringify(shards)}`);
      }
      if (!freeStorageKnown(freeStorageSize) || !freeStorageKnown(totalIndexBytesReusable)) {
         console.log('[yellow][WARN] Free blocks │ reuse unavailable (WiredTiger free-space stats hidden on this tier)[/]');
      }
      printRule('heavy');
      console.log('');
      return;
   }

   dbStats = await main();
   // return dbStats;
// })(db, options);
})();

// EOF
