/*
 *  Name: "dbstats.js"
 *  Version: "0.23.1"
 *  Description: "DB storage stats uber script"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.12.19). This file is mongosh-only.
 */

// Usage: mongosh [connection options] --quiet [--eval 'var options = {...};'] [-f|--file] </path/to/>dbstats.js
// load('dbstats.js') gathers quietly and returns the JSON contract (await the load() Promise).

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
 *           idxStorageSize: <1|0|-1>,
 *           idxFreeStorageSize: <1|0|-1>,
 *           reuse: <1|0|-1>,
 *           idxReuse: <1|0|-1>,
 *           compaction: <1|0|-1>,
 *           compression: <1|0|-1>,
 *           objects: <1|0|-1>
 *        },
 *        collection: {
 *           name: <1|0|-1>,
 *           dataSize: <1|0|-1>,
 *           storageSize: <1|0|-1>,
 *           freeStorageSize: <1|0|-1>,
 *           reuse: <1|0|-1>,
 *           compaction: <1|0|-1>,
 *           compression: <1|0|-1>,
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
 *           idxDataSize: <1|0|-1>,
 *           idxStorageSize: <1|0|-1>,
 *           idxFreeStorageSize: <1|0|-1>,
 *           reuse: <1|0|-1>,
 *           compaction: <1|0|-1>
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
 *        concurrency: <int>, // 0 = auto (8 mongod / 4 mongos); $collStats pool per DB
 *        topology: <'summary'|'expanded'>, // printer: summary = connecting catalog + member footer; expanded = one catalog table per materialized node
 *        verbosity: <'full'|'summary'|'summaryIdx'|'compactOnly'> // printer: full = collections+indexes+views; summary = DB rollup; summaryIdx = collections+indexes; compactOnly = compact/rebuild/wait/resync rows
 *     },
 *     topology: {
 *        discover: <true|false>, // default true; shared-tier / serverless stay one node
 *        replica: <'summary'|'expanded'>, // summary = $stats rollup per member; expanded = catalog+$collStats
 *        sharded: <'summary'|'expanded'> // summary = one snapshot per shard primary; expanded = each shard member
 *     },
 *     catalog: <'auto'|'legacy'|'listCatalog'|'listClusterCatalog'> // default auto
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
 *    mongosh --quiet --eval 'var options = { sort: { collection: { reuse: -1 }, index: { reuse: -1 } } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { sort: { collection: { compaction: -1 }, index: { compaction: -1 } } };' -f dbstats.js
 *
 *  Examples of using formatting:
 *
 *    mongosh --quiet --eval 'var options = { output: { format: "tabular" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { format: "table" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { format: "json" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { format: "html" } };' -f dbstats.js > dbstats.html
 *    mongosh --quiet --eval 'var options = { output: { verbosity: "summary" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { verbosity: "summaryIdx" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { verbosity: "compactOnly" } };' -f dbstats.js
 *
 *  Examples of catalog listing:
 *
 *    mongosh --quiet --eval 'var options = { catalog: "auto" };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { catalog: "legacy" };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { catalog: "listCatalog" };' -f dbstats.js
 *
 *  Examples of topology fan-out:
 *
 *    mongosh --quiet --eval 'var options = { topology: { discover: false } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { topology: { replica: "expanded" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { topology: { sharded: "expanded" } };' -f dbstats.js
 *    mongosh --quiet --eval 'var options = { output: { topology: "expanded" }, topology: { replica: "expanded" } };' -f dbstats.js
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 *  We overwrite options with var due to mongosh sloppy mode processing
 */

(() => {
   const __script = { "name": "dbstats.js", "version": "0.23.1" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
      __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      load(__lib.path);
      // Fix: Namespace the library. Instead of global.$stats = ..., use global.mdblib = { $stats: ..., CollectionStats: ... } and access via mdblib.$stats
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   // console.clear();
   function isDbstatsCliFile() {
      /*
       *  mongosh --file/-f (or positional *.js) targeting this script.
       *  load() from a REPL or another --file is module mode.
       */
      const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
      const files = [];
      for (let i = 2; i < argv.length; i++) {
         const a = String(argv[i]);
         if (a === '-f' || a === '--file') {
            if (i + 1 < argv.length) files.push(argv[++i]);
            continue;
         }
         if (a.startsWith('--file=')) {
            files.push(a.slice(7));
            continue;
         }
         if (a === '--eval') { i++; continue; }
         if (a.startsWith('--eval=') || a.startsWith('-')) continue;
         if (/\.(js|mongodb)$/i.test(a)) files.push(a);
      }
      return files.some(f => /(^|[\\/])dbstats\.js$/i.test(String(f)));
   }
   __dbstatsCliFile = isDbstatsCliFile();
   const __dbstatsOutFmt = (typeof options !== 'undefined' && options && options.output) ? options.output.format : '';
   const jsonCli = __dbstatsOutFmt === 'json' || __dbstatsOutFmt === 'html';
   if (__dbstatsCliFile && !jsonCli) {
      if (typeof __mdblibShellIncompatible !== 'undefined' && __mdblibShellIncompatible) {
         console.log(`\n[red][WARN] Possible incompatible non-GA shell version detected: ${__mdblibShellIncompatible}[/]`);
      }
      if (typeof __mdblibServerUnsupported !== 'undefined' && __mdblibServerUnsupported) {
         console.log(`\n[red][ERROR] Unsupported mongod/s version detected: ${__mdblibServerUnsupported}[/]`);
      }
      console.log(`\n\n[yellow]${__comment}[/]`);
   }
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
         __dbstatsAuthRequired = true;
         const outFmt = (typeof options !== 'undefined' && options && options.output) ? options.output.format : '';
         const jsonCli = outFmt === 'json' || outFmt === 'html';
         if (__dbstatsCliFile && !jsonCli) console.log('[red][ERR] MongoServerError: Unauthorized user requires authentication[/]');
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
   const jsonCli = (typeof options !== 'undefined' && options && options.output
      && (options.output.format === 'json' || options.output.format === 'html'));
   __dbstatsAuthzInadequate = !authzAdequate;

   if (!authzAdequate && __dbstatsCliFile && !jsonCli) {
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
            "idxStorageSize": 0,
            "freeStorageSize": 0,
            "idxFreeStorageSize": 0,
            "reuse": 0,
            "idxReuse": 0,
            "compression": 0,
            "objects": 0,
            "compaction": 0
         },
         "collection": {
            "name": 0,
            "dataSize": 0,
            "storageSize": 0,
            "freeStorageSize": 0,
            "reuse": 0,
            "compression": 0,
            "objects": 0,
            "compaction": 0
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
            "reuse": 0,
            "compression": 0,
            "objects": 0,
            "compaction": 0
         },
         "index": {
            "name": 0,
            "idxDataSize": 0,
            "idxStorageSize": 0,
            "idxFreeStorageSize": 0,
            "reuse": 0,
            "compaction": 0
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
         "concurrency": 0, // 0 = auto (8 mongod / 4 mongos); per-DB $collStats pool
         "topology": "summary", // ['summary'|'expanded'] printer; gather stays topology.replica / topology.sharded
         "verbosity": "full" // ['full'|'summary'|'summaryIdx'|'compactOnly'] printer; JSON stays the full contract
      },
      "topology": {
         "discover": true, // [true|false]
         "replica": "summary", // ['summary'|'expanded']
         "sharded": "summary" // ['summary'|'expanded']
      },
      "catalog": "auto" // ['auto'|'legacy'|'listCatalog'|'listClusterCatalog']
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
   const catalogMode = (options.catalog != null) ? options.catalog : optionsDefaults.catalog;
   // const limitOptions = { ...optionsDefaults.limit, ...(options.limit || {}) };
   const topologyOptions = { ...optionsDefaults.topology, ...(options.topology || {}) };

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

      const dbStats = await getStats();
      if (!__dbstatsCliFile && formatOutput !== 'json') return toJsonContract(dbStats);

      switch (formatOutput) {
         case 'json':
            return jsonOut(dbStats);
         case 'html':
            return htmlOut(dbStats);
         case 'nsTable':
            nsTableOut(dbStats);
            break;
         case 'tabular':
         default:
            tableOut(dbStats);
      }

      return toJsonContract(dbStats);
   }

   async function getStats() {
      /*
       *  Connecting-session gather, then optional per-node fan-out.
       */
      const topology = TopologySnapshot.fromSession();
      const jsonCli = outputOptions.format === 'json' || outputOptions.format === 'html';
      const hud = new MiniHud({
         "enabled": __dbstatsCliFile && !jsonCli
      });

      if (__dbstatsCliFile && !jsonCli && !hud.enabled) console.log('');

      try {
         const dbPath = await gatherDbPath({
            "host": topology.connecting || HostNode.discover(),
            hud,
            "depth": 'expanded'
         });
         dbPath.topology = topology;
         topology.aggregate = dbPath;
         if (topology.connecting) topology.connecting.stats = dbPath;

         if (topologyOptions.discover !== false) {
            await topology.materializeNodes({
               "replica": topologyOptions.replica,
               "sharded": topologyOptions.sharded,
               "gather": (node, { depth } = {}) => gatherDbPath({
                  "host": node,
                  hud,
                  "depth": depth || 'summary',
                  "hudLabel": node && node.instance
               }),
               "onProgress": ({ node, index, total }) => {
                  hud.render(
                     `[cyan]topology[/]  ${index + 1}/${total}  ${node && node.instance || ''}`,
                     { "force": true }
                  );
               }
            });
         }
         return dbPath;
      } finally {
         hud.clear();
      }
   }

   async function gatherDbPath({ host, hud, depth = 'expanded', hudLabel } = {}) {
      /*
       *  One session: $stats all DBs; expanded also catalogs and $collStats.
       *  Same filters as the connecting gather. hud may be a no-op MiniHud.
       */
      const dbPath = new DbPathStats({
         "host": host || HostNode.discover()
      });
      let { 'db': dbFilter, 'collection': collFilter, 'system': systemOpt = true } = filterOptions;
      collFilter = new RegExp(collFilter);
      const acceptCollName = systemCollectionFilter(systemOpt);
      const concurrency = statsConcurrency();
      const prefix = hudLabel ? `[cyan]node[/] ${hudLabel}  ` : '';
      const paint = (line, opts) => { if (hud && typeof hud.render === 'function') hud.render(line, opts); };
      const bar = (frac) => (hud && typeof hud.bar === 'function') ? hud.bar(frac) : '';

      const dbNames = stableSort(getDBNames(dbFilter), compareBy(v => v, 1));
      const dbTotal = dbNames.length;
      dbPath.databases = [];
      for (let i = 0; i < dbNames.length; i++) {
         paint(`${prefix}[cyan]dbStats[/]  ${i + 1}/${dbTotal}  ${dbNames[i]}`, { "force": i === 0 || i + 1 === dbTotal });
         dbPath.databases.push(buildDatabaseMeta(dbNames[i], dbPath.shards));
      }
      rollupDbPath(dbPath, dbPath.databases);

      if (depth !== 'expanded') {
         rollupDbPathFree(dbPath);
         dbPath.gatherWarnings = collectGatherWarnings(dbPath);
         return dbPath;
      }

      paint(`${prefix}[cyan]catalog[/]  listing`, { "force": true });
      const catalogSnapshot = await listCatalogSnapshot(catalogMode);
      for (let i = 0; i < dbPath.databases.length; i++) {
         const database = dbPath.databases[i];
         paint(`${prefix}[cyan]catalog[/]  ${i + 1}/${dbTotal}  ${database.name}`, { "force": i === 0 || i + 1 === dbTotal });
         await listDatabaseCatalog(database, collFilter, acceptCollName, catalogSnapshot);
      }
      const usedStage = dbPath.databases.some(
         d => d.catalogSource === 'listCatalog' || d.catalogSource === 'listClusterCatalog'
      );
      dbPath.catalogBuilder = usedStage ? catalogSnapshot.builder : 'legacy';
      dbPath.catalogFallback = catalogSnapshot.fallback === true
         || (catalogSnapshot.builder !== 'legacy' && !usedStage);
      if (catalogSnapshot.fallbackError) dbPath.catalogFallbackError = catalogSnapshot.fallbackError;

      const collTotal = dbPath.databases.reduce((n, d) => n + (d.collections || []).length, 0);
      const collStarted = Date.now();
      let collDone = 0;

      await dbPath.materialize({
         concurrency,
         "onProgress": ({ database, done, inFlight, queued }) => {
            const finished = collDone + done;
            const elapsed = (Date.now() - collStarted) / 1000;
            const frac = collTotal ? finished / collTotal : 1;
            const eta = (finished > 0 && finished < collTotal)
               ? formatHudTime((elapsed / finished) * (collTotal - finished))
               : '--';
            const pct = collTotal ? (frac * 100).toFixed(0) : '100';
            paint(
               `${prefix}[cyan]collStats[/] ${bar(frac)} ${finished}/${collTotal} ${pct}%  db=${database.name}  run=${inFlight} q=${queued}  ETA ${eta}`,
               { "force": done === 0 || finished === collTotal }
            );
         },
         "onDatabase": database => {
            collDone += (database.collections || []).length;
            database.collections = stableSort(database.collections || [], sortBy('collection'));
            for (const collection of database.collections) {
               collection.indexes = stableSort(collection.indexes || [], sortBy('index'));
            }
            rollupDatabase(database);
         }
      });

      paint(
         `${prefix}[cyan]collStats[/] ${bar(1)} ${collTotal}/${collTotal} 100%`,
         { "force": true }
      );

      dbPath.databases = stableSort(dbPath.databases, sortBy('db'));
      rollupDbPath(dbPath, dbPath.databases);
      rollupDbPathFree(dbPath);
      dbPath.gatherWarnings = collectGatherWarnings(dbPath);
      return dbPath;
   }

   function statsConcurrency() {
      const n = +outputOptions.concurrency;
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      return isSharded() ? 4 : 8;
   }

   function catalogSliceNeedsLegacy(database, slice) {
      /*
       *  Empty or collection-less slice while $stats reports collections/views:
       *  $listCatalog missed the DB (8.0 redaction of local/config, authz, or
       *  timeseries name without system.buckets). Fall back to listCollections.
       */
      const rows = Array.isArray(slice) ? slice : [];
      const hasCollection = rows.some(e => e && e.type === 'collection');
      const hasView = rows.some(e => e && e.type === 'view');
      const ncoll = database.ncollections;
      const nviews = database.nviews;
      const expectsColl = (typeof ncoll === 'number' && ncoll > 0)
         || (isShardCountArray(ncoll) && ncoll.some(n => +n > 0));
      const expectsView = (typeof nviews === 'number' && nviews > 0)
         || (isShardCountArray(nviews) && nviews.some(n => +n > 0));
      if (expectsColl && !hasCollection) return true;
      if (expectsView && !hasView && !hasCollection) return true;
      return false;
   }

   function catalogCollectionShell(database, info = {}) {
      return CollectionStats.catalogEntry({
         "name": info.name,
         "type": info.type,
         "dbName": database.name
      });
   }

   function applyCatalogSlice(database, slice, collFilter, acceptCollName, builder) {
      const rows = (slice || []).filter(
         e => e && e.name && collFilter.test(e.name) && acceptCollName(e)
      );
      const collections = rows
         .filter(e => e.type === 'collection' || e.type === 'timeseries')
         .map(e => catalogCollectionShell(database, e));
      const views = rows.filter(e => e.type === 'view');
      database.collections = stableSort(collections, compareBy('name', 1));
      database.listedCollectionCount = countListedCollections(database.collections);
      database.views = stableSort(views.map(v => new ViewRef(v)), sortBy('view'));
      database.catalogSource = builder;
   }

   async function mergeSystemCollectionInfos(database, collFilter, acceptCollName) {
      /*
       *  8.0+ collectionless $listCatalog hides system.* (except system.js /
       *  system.buckets.*) from non-internal users. Merge those names from
       *  listCollections so listedCollectionCount still matches $stats.
       */
      const systemName = /^(system\.|replset\.)/;
      try {
         let collections = db.getSiblingDB(database.name).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": systemName
            },
            { "nameOnly": true, "authorizedCollections": true }
         );
         collections = await Promise.resolve(collections);
         const extra = (collections || []).filter(
            c => c && c.name && collFilter.test(c.name) && acceptCollName(c)
         );
         const byName = new Map((database.collections || []).map(c => [c.name, c]));
         for (const c of extra) {
            if (!byName.has(c.name)) byName.set(c.name, catalogCollectionShell(database, c));
         }
         database.collections = stableSort([...byName.values()], compareBy('name', 1));
         database.listedCollectionCount = countListedCollections(database.collections);
      } catch(_) { /* keep snapshot collections */ }
      try {
         let views = db.getSiblingDB(database.name).getCollectionInfos({
               "type": "view",
               "name": systemName
            },
            { "nameOnly": true, "authorizedCollections": true }
         );
         views = await Promise.resolve(views);
         const extra = (views || []).filter(
            v => v && v.name && collFilter.test(v.name) && acceptCollName(v)
         );
         const byName = new Map((database.views || []).map(v => [v.name, v]));
         for (const v of extra) {
            if (!byName.has(v.name)) byName.set(v.name, new ViewRef(v));
         }
         database.views = stableSort([...byName.values()], sortBy('view'));
      } catch(_) { /* keep snapshot views */ }
   }

   async function listDatabaseCatalogLegacy(database, collFilter, acceptCollName) {
      try {
         let collections = db.getSiblingDB(database.name).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": collFilter
            },
            { "nameOnly": true, "authorizedCollections": true }
         );
         collections = await Promise.resolve(collections);
         database.collections = stableSort(
            (collections || []).filter(acceptCollName).map(c => catalogCollectionShell(database, c)),
            compareBy('name', 1)
         );
         database.listedCollectionCount = countListedCollections(database.collections);
      } catch(e) {
         database.collections = [];
         database.listedCollectionCount = 0;
         database.catalogError = commandErrorMessage(e);
      }
      try {
         let views = db.getSiblingDB(database.name).getCollectionInfos({
               "type": "view",
               "name": collFilter
            },
            { "nameOnly": true, "authorizedCollections": true }
         );
         views = await Promise.resolve(views);
         database.views = stableSort(
            (views || []).filter(acceptCollName).map(v => new ViewRef(v)),
            sortBy('view')
         );
      } catch(e) {
         database.views = [];
         if (!database.catalogError) database.catalogError = commandErrorMessage(e);
      }
      database.catalogSource = 'legacy';
   }

   async function listDatabaseCatalog(database, collFilter, acceptCollName, catalogSnapshot) {
      const builder = (catalogSnapshot && catalogSnapshot.builder) || 'legacy';
      const slice = (builder !== 'legacy' && catalogSnapshot && catalogSnapshot.byDb)
         ? (catalogSnapshot.byDb[database.name] || [])
         : null;

      if (slice && !catalogSliceNeedsLegacy(database, slice)) {
         applyCatalogSlice(database, slice, collFilter, acceptCollName, builder);
         if (builder === 'listCatalog' && serverVer(8)) {
            await mergeSystemCollectionInfos(database, collFilter, acceptCollName);
         }
         return;
      }

      await listDatabaseCatalogLegacy(database, collFilter, acceptCollName);
   }

   function buildDatabaseMeta(dbName, shards = []) {
      /*
       *  $stats → DatabaseStats for one DB (no cluster rollup mutation)
       */
      return DatabaseStats.from($stats(dbName), { shards });
   }

   function sumNullable(values) {
      /*
       *  Sum numbers; any null/undefined → null (unknown free-space poisons the parent)
       */
      if (!values.length) return 0;
      if (values.some(v => v == null)) return null;
      return values.reduce((a, b) => a + b, 0);
   }

   function sumKnown(values) {
      /*
       *  Sum measured free-space; skip null/NaN (lower bound, not an empty free list)
       */
      const known = values.filter(v => freeStorageKnown(v)).map(v => +v);
      if (!known.length) return null;
      return known.reduce((a, b) => a + b, 0);
   }

   function isUnauthorizedCollection(collection = {}) {
      return /\(unauthorized\)\s*$/.test(collection.name || '');
   }

   function isUnavailableCollection(collection = {}) {
      return /\(unavailable\)\s*$/.test(collection.name || '');
   }

   function catalogName(collection = {}) {
      return String(collection.name || '').replace(/\s*\((unauthorized|unavailable)\)\s*$/, '');
   }

   function collectGatherWarnings(dbPath) {
      const warnings = [];
      for (const database of dbPath.databases || []) {
         if (database.statsError) {
            warnings.push({
               "code": database.unauthorized ? 'dbStatsUnauthorized' : 'dbStatsFailed',
               "db": database.name,
               "message": String(database.statsError)
            });
         }
         if (database.catalogError) {
            warnings.push({
               "code": 'catalogFailed',
               "db": database.name,
               "message": String(database.catalogError)
            });
         }
         for (const collection of database.collections || []) {
            if (!isUnavailableCollection(collection)) continue;
            warnings.push({
               "code": 'collStatsFailed',
               "ns": `${database.name}.${catalogName(collection)}`,
               "message": String(collection.statsError || 'collStats failed')
            });
         }
      }
      return warnings;
   }

   function isMatchAllNameFilter(re) {
      if (re == null) return true;
      const src = (re instanceof RegExp) ? re.source : String(re);
      return src === '.+' || src === '.*' || src === '^.+$' || src === '^.*$';
   }

   function catalogFilterRestricts() {
      if (!isMatchAllNameFilter(filterOptions.collection)) return true;
      const mode = normalizeSystemFilter(filterOptions.system);
      return mode === 'exclude' || mode === 'only';
   }

   function countListedCollections(infos = []) {
      /*
       *  $stats.collections counts type:collection (including system.buckets).
       *  listCollections of collection|timeseries also returns the timeseries
       *  name — exclude those from the coverage count.
       */
      return infos.reduce((n, c) => n + ((c && c.type) === 'timeseries' ? 0 : 1), 0);
   }

   function catalogCoverageComplete(database) {
      /*
       *  Fetched collections cover the database the table is claiming to subtotal.
       *  Sharded ncollections is a per-shard array (not unique NS) — skip the count check.
       *  Compare $stats.collections to listed type:collection, not to
       *  collections.length (timeseries names are extra list entries).
       */
      if (database.catalogError) return false;
      if (catalogFilterRestricts()) return false;
      const collections = database.collections || [];
      if (collections.some(c => isUnauthorizedCollection(c) || isUnavailableCollection(c))) return false;
      const ncoll = database.ncollections;
      const listed = Number.isFinite(+database.listedCollectionCount)
         ? +database.listedCollectionCount
         : collections.length;
      if (typeof ncoll === 'number' && Number.isFinite(ncoll) && listed !== ncoll) return false;
      return true;
   }

   function collectionIndexFreeBytes(collection) {
      if (isUnauthorizedCollection(collection) || isUnavailableCollection(collection)) return null;
      if (freeStorageKnown(collection.totalIndexBytesReusable)) return +collection.totalIndexBytesReusable;
      const indexes = collection.indexes || [];
      if (!indexes.length) return (+collection.nindexes === 0) ? 0 : null;
      return sumKnown(indexes.map(idx => idx.freeStorageSize));
   }

   function collectionIndexFreeComplete(collection) {
      if (isUnauthorizedCollection(collection) || isUnavailableCollection(collection)) return false;
      if (collection.totalIndexBytesReusableComplete === false) return false;
      if (freeStorageKnown(collection.totalIndexBytesReusable)) return true;
      const indexes = collection.indexes || [];
      if (!indexes.length) return +collection.nindexes === 0;
      return indexes.every(idx => freeStorageKnown(idx.freeStorageSize) && idx.freeStorageComplete !== false);
   }

   function tagDbStatsFree(database) {
      database.freeStorageSizeSource = freeStorageKnown(database.freeStorageSize) ? 'dbStats' : 'unknown';
      database.freeStorageComplete = database.freeStorageSizeSource === 'dbStats';
      database.totalIndexBytesReusableSource = freeStorageKnown(database.totalIndexBytesReusable) ? 'dbStats' : 'unknown';
      database.totalIndexBytesReusableComplete = database.totalIndexBytesReusableSource === 'dbStats';
   }

   function rollupDatabaseFreeFromCollStats(database) {
      /*
       *  db.stats() free-space is untrusted on this tier; sum collection WT.
       */
      const collections = database.collections || [];
      const coverage = catalogCoverageComplete(database);

      const collFree = collections.map(c => c.freeStorageSize);
      const collRolled = sumKnown(collFree);
      if (collRolled != null) {
         database.freeStorageSize = collRolled;
         database.freeStorageSizeSource = 'collStatsRollup';
         database.freeStorageComplete = coverage && collections.length > 0
            && collFree.every(freeStorageKnown)
            && collections.every(c => c.freeStorageComplete !== false);
      } else {
         database.freeStorageSize = null;
         database.freeStorageSizeSource = 'unknown';
         database.freeStorageComplete = false;
      }

      const idxFree = collections.map(collectionIndexFreeBytes);
      const idxRolled = sumKnown(idxFree);
      if (idxRolled != null) {
         database.totalIndexBytesReusable = idxRolled;
         database.totalIndexBytesReusableSource = 'collStatsRollup';
         database.totalIndexBytesReusableComplete = coverage
            && collections.length > 0
            && collections.every(collectionIndexFreeComplete)
            && collections.every(c => c.totalIndexBytesReusableComplete !== false);
      } else {
         database.totalIndexBytesReusable = null;
         database.totalIndexBytesReusableSource = 'unknown';
         database.totalIndexBytesReusableComplete = false;
      }
   }

   function collectionIndexCount(collection) {
      if (Array.isArray(collection.indexes)) return collection.indexes.length;
      return +collection.nindexes || 0;
   }

   function dbStatsSizesTrusted(database) {
      /*
       *  $stats returned a real db.stats() document. Stubs (authz / command
       *  failure) are not a size measurement — listed collections are.
       */
      return !database.statsError && database.unauthorized !== true;
   }

   function rollupDatabaseFromCollections(database) {
      /*
       *  Fallback when $stats is unusable. Listed collections are a lower
       *  bound; never G() mass.
       */
      const collections = database.collections || [];
      const views = database.views || [];
      database.dataSize = collections.reduce((s, c) => s + (+c.dataSize || 0), 0);
      database.storageSize = collections.reduce((s, c) => s + (+c.storageSize || 0), 0);
      database.objects = collections.reduce((s, c) => s + (+c.objects || 0), 0);
      database.orphans = collections.reduce((s, c) => s + (+c.orphans || 0), 0);
      database.totalIndexSize = collections.reduce((s, c) => s + (+c.totalIndexSize || 0), 0);
      database.ncollections = collections.length;
      database.nviews = views.length;
      database.namespaces = collections.length + views.length;
      const nidx = collections.reduce((s, c) => s + collectionIndexCount(c), 0);
      database.nindexes = nidx;
      rollupDatabaseFreeFromCollStats(database);
      database.freeStorageComplete = false;
      database.totalIndexBytesReusableComplete = false;
   }

   function rollupDatabase(database) {
      /*
       *  Prefer $stats sizes whenever the command succeeded — including when
       *  the collection list is incomplete (filter / authz / ncollections
       *  mismatch). M0/Flex still rolls free from $collStats (lower bound if
       *  listing holes). $stats stubs fall back to collection sums.
       */
      const coverage = catalogCoverageComplete(database);
      database.catalogCoverageComplete = coverage;

      if (!dbStatsSizesTrusted(database)) {
         rollupDatabaseFromCollections(database);
         return;
      }
      if (hidesDbStatsFreeStorage()) {
         rollupDatabaseFreeFromCollStats(database);
         if (!coverage) {
            database.freeStorageComplete = false;
            database.totalIndexBytesReusableComplete = false;
         }
         return;
      }
      tagDbStatsFree(database);
   }

   function rollupDatabaseFree(database) {
      rollupDatabase(database);
   }

   function applyFreeStorageRollup(dbPath) {
      (dbPath.databases || []).forEach(rollupDatabase);
      rollupDbPath(dbPath, dbPath.databases || []);
      return rollupDbPathFree(dbPath);
   }

   function rollupDbPathFree(dbPath) {
      /*
       *  db.stats() wins when it is a real measurement (dedicated / self-managed).
       *  Atlas M0/Flex (and serverless) hide db-level reusable bytes — roll up
       *  collection WT $collStats as a lower bound (authz / filters may omit NS).
       */
      const databases = dbPath.databases || [];
      if (!databases.length) {
         dbPath.catalogCoverageComplete = true;
         return dbPath;
      }

      const dbFrees = databases.map(d => d.freeStorageSize);
      const allDbStatsFree = databases.every(d => d.freeStorageSizeSource === 'dbStats');
      const anyCollFree = databases.some(d => d.freeStorageSizeSource === 'collStatsRollup');
      if (allDbStatsFree) {
         dbPath.freeStorageSize = dbFrees.reduce((a, b) => a + +b, 0);
         dbPath.freeStorageSizeSource = 'dbStats';
         dbPath.freeStorageComplete = true;
      } else if (dbFrees.some(freeStorageKnown)) {
         dbPath.freeStorageSize = sumKnown(dbFrees);
         dbPath.freeStorageSizeSource = anyCollFree ? 'collStatsRollup' : 'dbStats';
         dbPath.freeStorageComplete = databases.every(d => d.freeStorageComplete && freeStorageKnown(d.freeStorageSize));
      } else {
         dbPath.freeStorageSize = null;
         dbPath.freeStorageSizeSource = 'unknown';
         dbPath.freeStorageComplete = false;
      }

      const dbIdx = databases.map(d => d.totalIndexBytesReusable);
      const allDbStatsIdx = databases.every(d => d.totalIndexBytesReusableSource === 'dbStats');
      const anyCollIdx = databases.some(d => d.totalIndexBytesReusableSource === 'collStatsRollup');
      if (allDbStatsIdx) {
         dbPath.totalIndexBytesReusable = dbIdx.reduce((a, b) => a + +b, 0);
         dbPath.totalIndexBytesReusableSource = 'dbStats';
         dbPath.totalIndexBytesReusableComplete = true;
      } else if (dbIdx.some(freeStorageKnown)) {
         dbPath.totalIndexBytesReusable = sumKnown(dbIdx);
         dbPath.totalIndexBytesReusableSource = anyCollIdx ? 'collStatsRollup' : 'dbStats';
         dbPath.totalIndexBytesReusableComplete = databases.every(
            d => d.totalIndexBytesReusableComplete && freeStorageKnown(d.totalIndexBytesReusable)
         );
      } else {
         dbPath.totalIndexBytesReusable = null;
         dbPath.totalIndexBytesReusableSource = 'unknown';
         dbPath.totalIndexBytesReusableComplete = false;
      }
      dbPath.catalogCoverageComplete = databases.every(d => d.catalogCoverageComplete !== false);
      return dbPath;
   }

   function sumPerShard(arrays, nShards) {
      const zeros = Array(nShards).fill(0);
      return arrays.reduce(
         (acc, arr) => acc.map((v, i) => v + (+((arr && arr[i]) || 0))),
         zeros
      );
   }

   function countTotal(v) {
      if (Array.isArray(v)) return v.reduce((s, x) => s + (+x || 0), 0);
      return +v || 0;
   }

   function rollupDbPath(dbPath, databases = []) {
      /*
       *  Aggregate database metas into dbPath totals (sharded arrays or scalars).
       *  Empty catalog: sharded → zero-filled per-shard arrays; unsharded → leave DbPathStats defaults.
       *  freeStorageSize / totalIndexBytesReusable here follow $stats; rollupDbPathFree
       *  revises them after per-DB $collStats (M0/Flex free; collection-sum only when $stats failed).
       */
      const nShards = dbPath.shards.length;
      if (!databases.length) {
         if (nShards > 0) {
            const zeros = Array(nShards).fill(0);
            dbPath.ncollections = zeros;
            dbPath.nviews = zeros.slice();
            dbPath.namespaces = zeros.slice();
            dbPath.nindexes = zeros.slice();
         }
         return dbPath;
      }
      const shardCounts = nShards > 0 && databases.every(d =>
         Array.isArray(d.ncollections) && Array.isArray(d.nviews) && Array.isArray(d.namespaces)
            && Array.isArray(d.nindexes)
      );
      if (shardCounts) {
         dbPath.ncollections = sumPerShard(databases.map(d => d.ncollections), nShards);
         dbPath.nviews = sumPerShard(databases.map(d => d.nviews), nShards);
         dbPath.namespaces = sumPerShard(databases.map(d => d.namespaces), nShards);
         dbPath.nindexes = sumPerShard(databases.map(d => d.nindexes), nShards);
      } else {
         dbPath.ncollections = databases.reduce((s, d) => s + countTotal(d.ncollections), 0);
         dbPath.nviews = databases.reduce((s, d) => s + countTotal(d.nviews), 0);
         dbPath.namespaces = databases.reduce((s, d) => s + countTotal(d.namespaces), 0);
         dbPath.nindexes = databases.reduce(
            (s, d) => s + countTotal(d.nindexes), 0
         );
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
      if (printExpandedNodes(dbStats, printDatabaseTables)) return;
      printDatabaseTables(dbStats);
      printDbPath(dbStats);
   }

   function nsTableOut(dbStats = {}) {
      /*
       *  Print aggregated namespaces tabular report.
       */
      if (printExpandedNodes(dbStats, printNamespaceTables)) return;
      printNamespaceTables(dbStats);
      printDbPath(dbStats);
   }

   function printDatabaseTables(dbStats = {}) {
      const verb = outputVerbosity();
      (dbStats.databases || []).forEach(database => {
         const collections = database.collections || [];
         const views = database.views || [];
         if (verb === 'summary') {
            printDbHeader(database);
            printDb(database);
            return;
         }
         const listed = (verb === 'compactonly')
            ? collections.filter(collectionHasCompactable)
            : collections;
         if (verb === 'compactonly' && !listed.length) return;
         printDbHeader(database);
         printCollHeader(listed.length);
         listed.forEach(collection => {
            printCollection(collection);
            const indexes = collection.indexes || [];
            const idxRows = (verb === 'compactonly')
               ? indexes.filter(indexIsCompactable)
               : indexes;
            idxRows.forEach(printIndex);
         });
         if (verb === 'full') {
            printViewHeader(views.length);
            views.forEach(({ name }) => printView(name));
         }
         printDb(database);
      });
   }

   function printNamespaceTables(dbStats = {}) {
      /*
       *  Copy rows — do not mutate live collection objects.
       */
      const verb = outputVerbosity();
      let namespaces = (dbStats.databases || []).flatMap(database =>
         (database.collections || []).map(collection => ({
            "namespace": database.name + '.' + collection.name,
            "name": collection.name,
            "dataSize": collection.dataSize,
            "compression": collection.compression,
            "compressor": collection.compressor,
            "storageSize": collection.storageSize,
            "freeStorageSize": collection.freeStorageSize,
            "freeStorageComplete": collection.freeStorageComplete,
            "objects": collection.objects,
            "indexes": collection.indexes,
            "allocUnit": collection.allocUnit,
            "internalPageSize": collection.internalPageSize
         }))
      );
      if (verb === 'compactonly') {
         namespaces = namespaces.filter(collectionHasCompactable);
      }
      const sortedNamespaces = stableSort(namespaces, sortBy('namespace'));

      printNSHeader(sortedNamespaces.length);
      sortedNamespaces.forEach(namespace => {
         printNamespace(namespace);
         if (verb === 'summary') return;
         const indexes = namespace.indexes || [];
         const idxRows = (verb === 'compactonly')
            ? indexes.filter(indexIsCompactable)
            : indexes;
         idxRows.forEach(printIndex);
      });
   }

   function collectionCompactionExtra(collection = {}) {
      const name = collection.name || '';
      const ns = collection.namespace || '';
      return {
         "oplog": name === 'oplog.rs' || ns === 'local.oplog.rs',
         "incomplete": collection.freeStorageComplete === false
      };
   }

   function indexCompactionExtra(index = {}) {
      return {
         "idIndex": index.name === '_id_',
         "incomplete": index.freeStorageComplete === false
      };
   }

   function indexIsCompactable(index = {}) {
      return jsonCompaction('index', index.storageSize, index.freeStorageSize, indexCompactionExtra(index)) != null;
   }

   function collectionHasCompactable(collection = {}) {
      if (jsonCompaction('collection', collection.storageSize, collection.freeStorageSize, collectionCompactionExtra(collection)) != null)
         return true;
      return (collection.indexes || []).some(indexIsCompactable);
   }

   function printExpandedNodes(dbStats, printBody) {
      /*
       *  output.topology expanded: one catalog table per materialized node.
       *  Gather depth stays topology.replica / topology.sharded.
       */
      const topology = dbStats.topology;
      const nodes = (topology && topology.nodes) || [];
      if (!outputTopologyExpanded()) return false;
      if (!nodes.some(n => n && n.connecting !== true && n.stats)) return false;
      const widths = nodeIdentityWidths(nodes);
      nodes.forEach(node => {
         if (!node || (!node.stats && !node.error)) return;
         printNodeBanner(node, widths);
         if (!node.stats) return;
         printBody(node.stats);
         printDbPath(node.stats, { "hostLine": false });
      });
      if (nodes.length > 1) {
         printRule('heavy');
         printTopologyMembers(topology, widths);
         printRule('heavy');
         console.log('');
      }
      return true;
   }

   function jsonNumber(n) {
      if (n == null || n === '') return null;
      if (typeof n === 'object' && typeof n.toNumber === 'function') n = n.toNumber();
      const v = +n;
      return Number.isFinite(v) ? v : null;
   }

   function jsonCount(n) {
      if (Array.isArray(n)) return n.map(v => jsonNumber(v));
      return jsonNumber(n);
   }

   function jsonFree(n) {
      if (!freeStorageKnown(n)) return null;
      return jsonNumber(n);
   }

   function jsonReuse(freeStorageSize, storageSize) {
      if (!freeStorageKnown(freeStorageSize) || !(+storageSize > 0)) return null;
      const ratio = +freeStorageSize / +storageSize;
      return Number.isFinite(ratio) ? ratio : null;
   }

   function jsonCompression(dataSize, storageSize, freeStorageSize) {
      if (!freeStorageKnown(freeStorageSize) || !(+storageSize > 0)) return null;
      const denom = +storageSize - +freeStorageSize;
      if (!(denom > 0)) return null;
      const ratio = +dataSize / denom;
      return Number.isFinite(ratio) ? ratio : null;
   }

   function jsonCompaction(kind, storageSize, freeStorageSize, extra = {}) {
      const label = formatCompaction(kind, storageSize, freeStorageSize, extra);
      if (!label || label === 'n/a ' || label === '———— ') return null;
      return label;
   }

   function jsonIndex(index = {}) {
      const name = index.name || '';
      const storageSize = jsonNumber(index.storageSize);
      const freeStorageSize = jsonFree(index.freeStorageSize);
      return {
         "name": name,
         "kind": 'index',
         "storageSize": storageSize,
         "freeStorageSize": freeStorageSize,
         "reuse": jsonReuse(freeStorageSize, storageSize),
         "freeStorageComplete": index.freeStorageComplete !== false,
         "compaction": jsonCompaction('index', storageSize, freeStorageSize, {
            "idIndex": name === '_id_',
            "incomplete": index.freeStorageComplete === false
         })
      };
   }

   function jsonCollection(dbName, collection = {}) {
      const unauthorized = isUnauthorizedCollection(collection);
      const unavailable = isUnavailableCollection(collection);
      const name = catalogName(collection) || (collection.name || '');
      const ns = `${dbName}.${name}`;
      const storageSize = jsonNumber(collection.storageSize);
      const freeStorageSize = jsonFree(collection.freeStorageSize);
      const dataSize = jsonNumber(collection.dataSize);
      const totalIndexSize = jsonNumber(collection.totalIndexSize);
      const totalIndexBytesReusable = jsonFree(collection.totalIndexBytesReusable);
      const indexes = (collection.indexes || []).map(jsonIndex);
      return {
         ns, "db": dbName, name,
         "kind": 'collection',
         unauthorized,
         unavailable,
         dataSize, storageSize, freeStorageSize,
         "reuse": jsonReuse(freeStorageSize, storageSize),
         "objects": jsonNumber(collection.objects),
         "orphans": jsonNumber(collection.orphans),
         "compression": jsonCompression(dataSize, storageSize, freeStorageSize),
         "compressor": collection.compressor || null,
         "nindexes": jsonNumber(collection.nindexes) ?? indexes.length,
         totalIndexSize, totalIndexBytesReusable,
         "idxReuse": jsonReuse(totalIndexBytesReusable, totalIndexSize),
         "freeStorageComplete": collection.freeStorageComplete !== false,
         "totalIndexBytesReusableComplete": collection.totalIndexBytesReusableComplete !== false,
         "statsIncomplete": collection.statsIncomplete === true,
         "compaction": jsonCompaction('collection', storageSize, freeStorageSize, {
            "oplog": ns === 'local.oplog.rs',
            "incomplete": collection.freeStorageComplete === false
         }),
         indexes
      };
   }

   function jsonDatabase(database = {}) {
      const name = database.name || '';
      const collections = (database.collections || []).map(c => jsonCollection(name, c));
      const views = (database.views || []).map(v => ({
         "name": v.name,
         "ns": `${name}.${v.name}`,
         "kind": 'view'
      }));
      const storageSize = jsonNumber(database.storageSize);
      const freeStorageSize = jsonFree(database.freeStorageSize);
      const dataSize = jsonNumber(database.dataSize);
      const totalIndexSize = jsonNumber(database.totalIndexSize);
      const totalIndexBytesReusable = jsonFree(database.totalIndexBytesReusable);
      const freeIncomplete = database.freeStorageComplete === false;
      const idxIncomplete = database.totalIndexBytesReusableComplete === false;
      return {
         name,
         "unauthorized": database.unauthorized === true,
         "statsError": database.statsError || null,
         dataSize, storageSize, freeStorageSize,
         "reuse": jsonReuse(freeStorageSize, storageSize),
         "objects": jsonNumber(database.objects),
         "ncollections": jsonCount(database.ncollections),
         "nviews": jsonCount(database.nviews),
         "namespaces": jsonCount(database.namespaces),
         "nindexes": jsonCount(database.nindexes),
         totalIndexSize, totalIndexBytesReusable,
         "idxReuse": jsonReuse(totalIndexBytesReusable, totalIndexSize),
         "compression": jsonCompression(dataSize, storageSize, freeStorageSize),
         "freeStorageSizeSource": database.freeStorageSizeSource || 'unknown',
         "freeStorageComplete": database.freeStorageComplete === true,
         "totalIndexBytesReusableSource": database.totalIndexBytesReusableSource || 'unknown',
         "totalIndexBytesReusableComplete": database.totalIndexBytesReusableComplete === true,
         "catalogCoverageComplete": database.catalogCoverageComplete !== false,
         "compaction": jsonCompaction('collection', storageSize, freeStorageSize, { "incomplete": freeIncomplete }),
         "idxCompaction": jsonCompaction('index', totalIndexSize, totalIndexBytesReusable, { "incomplete": idxIncomplete }),
         collections,
         views
      };
   }

   function jsonTopology(topology) {
      if (!topology || typeof topology !== 'object') return null;
      const cluster = topology.cluster || {};
      const kind = cluster.kind || null;
      const expanded = topologyDepthExpanded(topology);
      return {
         "kind": kind,
         "setName": cluster.setName || null,
         "shardIds": Array.isArray(cluster.shardIds) ? cluster.shardIds : [],
         "nodes": (topology.nodes || []).map(node => {
            const row = {
               "instance": node.instance || null,
               "hostname": node.hostname || null,
               "proc": node.proc || null,
               "role": node.role || null,
               "connecting": node.connecting === true,
               "shards": Array.isArray(node.shards) ? node.shards : [],
               "dbPath": node.dbPath || null,
               "stats": node.stats ? jsonTotals(node.stats) : null,
               "error": node.error || null
            };
            if (expanded && node.stats && !node.connecting) {
               row.databases = (node.stats.databases || []).map(jsonDatabase);
            }
            return row;
         }),
         "errors": Array.isArray(topology.errors) ? topology.errors : []
      };
   }

   function jsonTotals(dbStats = {}) {
      const storageSize = jsonNumber(dbStats.storageSize);
      const freeStorageSize = jsonFree(dbStats.freeStorageSize);
      const dataSize = jsonNumber(dbStats.dataSize);
      const totalIndexSize = jsonNumber(dbStats.totalIndexSize);
      const totalIndexBytesReusable = jsonFree(dbStats.totalIndexBytesReusable);
      const freeIncomplete = dbStats.freeStorageComplete === false;
      const idxIncomplete = dbStats.totalIndexBytesReusableComplete === false;
      return {
         dataSize, storageSize, freeStorageSize,
         "reuse": jsonReuse(freeStorageSize, storageSize),
         "objects": jsonNumber(dbStats.objects),
         "ncollections": jsonCount(dbStats.ncollections),
         "nviews": jsonCount(dbStats.nviews),
         "namespaces": jsonCount(dbStats.namespaces),
         "nindexes": jsonCount(dbStats.nindexes),
         totalIndexSize, totalIndexBytesReusable,
         "idxReuse": jsonReuse(totalIndexBytesReusable, totalIndexSize),
         "compression": jsonCompression(dataSize, storageSize, freeStorageSize),
         "freeStorageSizeSource": dbStats.freeStorageSizeSource || 'unknown',
         "freeStorageComplete": dbStats.freeStorageComplete === true,
         "totalIndexBytesReusableSource": dbStats.totalIndexBytesReusableSource || 'unknown',
         "totalIndexBytesReusableComplete": dbStats.totalIndexBytesReusableComplete === true,
         "catalogCoverageComplete": dbStats.catalogCoverageComplete !== false,
         "compaction": jsonCompaction('dbPath', storageSize, freeStorageSize, { "incomplete": freeIncomplete }),
         "idxCompaction": jsonCompaction('index', totalIndexSize, totalIndexBytesReusable, { "incomplete": idxIncomplete })
      };
   }

   function jsonWarnings(dbStats = {}) {
      const warnings = [];
      if (typeof __dbstatsAuthRequired !== 'undefined' && __dbstatsAuthRequired) {
         warnings.push({
            "code": 'authRequired',
            "message": 'MongoServerError: Unauthorized user requires authentication.'
         });
      }
      if (typeof __mdblibShellIncompatible !== 'undefined' && __mdblibShellIncompatible) {
         warnings.push({
            "code": 'incompatibleShell',
            "message": `Possible incompatible non-GA shell version detected: ${__mdblibShellIncompatible}`
         });
      }
      if (typeof __mdblibServerUnsupported !== 'undefined' && __mdblibServerUnsupported) {
         warnings.push({
            "code": 'unsupportedServer',
            "message": `Unsupported mongod/s version detected: ${__mdblibServerUnsupported}`
         });
      }
      if (Array.isArray(dbStats.gatherWarnings) && dbStats.gatherWarnings.length) {
         warnings.push(...dbStats.gatherWarnings);
      }
      if (typeof __dbstatsAuthzInadequate !== 'undefined' && __dbstatsAuthzInadequate) {
         warnings.push({
            "code": 'authzInadequate',
            "message": "The connecting user's authz privileges may be inadequate to report all namespace statistics. Inherit clusterMonitor@admin and readAnyDatabase@admin at a minimum."
         });
      }
      const hide = hidesDbStatsFreeStorage();
      const rolled = dbStats.freeStorageSizeSource === 'collStatsRollup'
                  || dbStats.totalIndexBytesReusableSource === 'collStatsRollup';
      const incomplete = dbStats.freeStorageComplete === false
                      || dbStats.totalIndexBytesReusableComplete === false;
      const unknown = !freeStorageKnown(dbStats.freeStorageSize)
                   || !freeStorageKnown(dbStats.totalIndexBytesReusable);
      const listingIncomplete = dbStats.catalogCoverageComplete === false
         || (dbStats.databases || []).some(d => d.catalogCoverageComplete === false);
      if (hide && rolled && incomplete) {
         warnings.push({
            "code": 'freeStorageIncomplete',
            "message": 'Free blocks rolled up from collection WiredTiger stats; db.stats() omits reusable bytes on this tier. Totals may exclude unauthorized or filtered namespaces and are a lower bound.'
         });
      } else if (hide && rolled) {
         warnings.push({
            "code": 'freeStorageCollStatsRollup',
            "message": 'Free blocks rolled up from collection WiredTiger stats; db.stats() omits reusable bytes on this tier.'
         });
      } else if (hide && unknown) {
         warnings.push({
            "code": 'freeStorageUnavailable',
            "message": 'Free blocks / reuse unavailable (WiredTiger free-space stats hidden on this tier).'
         });
      } else if (incomplete) {
         warnings.push({
            "code": 'filteredNamespaceRollup',
            "message": 'Database and dbPath totals are a rollup of listed collections; they exclude filtered or unauthorized namespaces and are a lower bound.'
         });
      } else if (listingIncomplete) {
         warnings.push({
            "code": 'catalogIncomplete',
            "message": 'Listed collections may omit filtered or unauthorized namespaces; database and dbPath totals are db.stats().'
         });
      }
      if (dbStats.catalogFallback === true) {
         let message = 'Catalog listing used listCollections after $listCatalog/$listClusterCatalog was unavailable or unauthorized.';
         if (dbStats.catalogFallbackError) message += ` ${dbStats.catalogFallbackError}`;
         warnings.push({
            "code": 'catalogFallback',
            "message": message
         });
      }
      return warnings;
   }

   function toJsonContract(dbStats = {}) {
      /*
       *  Versioned snapshot: bytes as numbers, unknown free-space as null.
       *  Hierarchical rollup plus a flat namespaces list. No printer fields.
       */
      const databases = (dbStats.databases || []).map(jsonDatabase);
      return {
         "ok": 1,
         "name": 'dbstats.js',
         "version": '0.23.1',
         "generatedAt": new Date(),
         "hostname": dbStats.hostname || null,
         "proc": dbStats.proc || null,
         "instance": dbStats.instance || null,
         "mongod": db.version(),
         "dbPath": dbStats.dbPath || null,
         "shards": Array.isArray(dbStats.shards) ? dbStats.shards : [],
         "topology": jsonTopology(dbStats.topology),
         "catalog": {
            "builder": dbStats.catalogBuilder || 'legacy',
            "fallback": dbStats.catalogFallback === true
         },
         "totals": jsonTotals(dbStats),
         databases,
         "namespaces": databases.flatMap(d => d.collections),
         "warnings": jsonWarnings(dbStats)
      };
   }

   function jsonStringifyReplacer(_key, value) {
      if (value instanceof Date) return value.toISOString();
      if (value != null && typeof value === 'object' && typeof value.toNumber === 'function') return value.toNumber();
      return value;
   }

   function jsonOut(dbStats = {}) {
      /*
       *  CLI JSON: strict JSON.stringify of the versioned contract (jq-safe).
       *  Return value is the same object for load() / module callers.
       */
      const payload = toJsonContract(dbStats);
      console.log(JSON.stringify(payload, jsonStringifyReplacer, 2));
      return payload;
   }

   function jsonForScript(value) {
      return JSON.stringify(value, jsonStringifyReplacer)
         .replace(/</g, '\\u003c')
         .replace(/\u2028/g, '\\u2028')
         .replace(/\u2029/g, '\\u2029');
   }

   function htmlEsc(s) {
      return String(s == null ? '' : s)
         .replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;')
         .replace(/"/g, '&quot;');
   }

   function htmlReportBoot() {
      const pack = window.__DBSTATS || {};
      const data = pack.payload || {};
      const ui = pack.ui || {};
      const root = document.getElementById('report');
      const verbSel = document.getElementById('verbosity');

      function esc(s) {
         return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
      }

      function fmtBytes(n) {
         if (n == null || n === '' || !Number.isFinite(+n)) return 'n/a';
         const sign = +n < 0 ? '-' : '';
         let v = Math.abs(+n);
         const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
         let i = 0;
         while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
         const t = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2);
         return sign + t + ' ' + units[i];
      }

      function fmtPct(n) {
         if (n == null || !Number.isFinite(+n)) return 'n/a';
         return (100 * +n).toFixed(1) + '%';
      }

      function fmtRatio(n) {
         if (n == null || !Number.isFinite(+n)) return 'n/a';
         return Number(+n).toFixed(2) + ':1';
      }

      function fmtNum(n) {
         if (n == null || n === '' || !Number.isFinite(+n)) return 'n/a';
         return String(n);
      }

      function fmtCount(n) {
         if (!Array.isArray(n)) return fmtNum(n);
         const shards = data.shards || [];
         return n.map((v, i) => (shards[i] != null ? shards[i] : i) + ': ' + (v == null ? 'n/a' : v)).join(', ');
      }

      function fmtCompaction(label) {
         return label ? String(label) : '—';
      }

      function compactionRank(label) {
         if (label === 'resync') return 4;
         if (label === 'rebuild') return 3;
         if (label === 'compact') return 2;
         if (label === 'wait') return 1;
         return '';
      }

      function verb() {
         return (verbSel && verbSel.value) || ui.verbosity || 'full';
      }

      function td(text, sortVal, cls) {
         const v = (sortVal === undefined || sortVal === null || sortVal === '') ? '' : sortVal;
         return '<td data-v="' + esc(v) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(text) + '</td>';
      }

      function bytesTd(n) {
         return td(fmtBytes(n), n == null ? '' : n);
      }

      function makeSortable(table) {
         const heads = table.tHead && table.tHead.rows[0] ? table.tHead.rows[0].cells : [];
         for (let c = 0; c < heads.length; c++) {
            heads[c].addEventListener('click', () => {
               const tbody = table.tBodies[0];
               if (!tbody) return;
               const rows = Array.from(tbody.rows);
               const dir = table.dataset.sortCol === String(c) && table.dataset.sortDir === 'asc' ? 'desc' : 'asc';
               table.dataset.sortCol = String(c);
               table.dataset.sortDir = dir;
               for (let i = 0; i < heads.length; i++) heads[i].classList.remove('sort-asc', 'sort-desc');
               heads[c].classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
               rows.sort((a, b) => {
                  const av = a.cells[c] ? a.cells[c].getAttribute('data-v') : '';
                  const bv = b.cells[c] ? b.cells[c].getAttribute('data-v') : '';
                  const an = av === '' ? NaN : +av;
                  const bn = bv === '' ? NaN : +bv;
                  const aOk = Number.isFinite(an);
                  const bOk = Number.isFinite(bn);
                  let cmp;
                  if (aOk && bOk) cmp = an - bn;
                  else if (aOk !== bOk) cmp = aOk ? -1 : 1;
                  else cmp = String(av).localeCompare(String(bv));
                  return dir === 'asc' ? cmp : -cmp;
               });
               rows.forEach(r => tbody.appendChild(r));
            });
         }
      }

      function tableHtml(caption, headers, rowHtml, leftCols) {
         if (!rowHtml) return '';
         leftCols = leftCols == null ? 1 : leftCols;
         return '<table class="sortable"><caption>' + esc(caption) + '</caption><thead><tr>'
            + headers.map((h, i) => '<th' + (i < leftCols ? ' class="name"' : '') + '>' + esc(h) + '</th>').join('')
            + '</tr></thead><tbody>' + rowHtml + '</tbody></table>';
      }

      function collectionVisible(c) {
         if (verb() !== 'compactonly') return true;
         if (c && c.compaction) return true;
         return (c.indexes || []).some(idx => idx && idx.compaction);
      }

      function indexVisible(idx) {
         return verb() !== 'compactonly' || !!(idx && idx.compaction);
      }

      function dbVisible(db) {
         if (verb() !== 'compactonly') return true;
         return (db.collections || []).some(collectionVisible);
      }

      function metricsCells(row, kind) {
         const reuse = row.reuse;
         const free = row.freeStorageSize;
         const storage = row.storageSize;
         const compact = row.compaction;
         const compactCls = compact ? 'act' : '';
         let cells = bytesTd(row.dataSize)
            + td(fmtRatio(row.compression) + (row.compressor ? ' ' + row.compressor : ''), row.compression)
            + bytesTd(storage)
            + td(fmtBytes(free) + ' │ ' + fmtPct(reuse), reuse == null ? '' : reuse)
            + td(fmtNum(row.objects), row.objects)
            + td(fmtCompaction(compact), compactionRank(compact), compactCls);
         if (kind === 'db') {
            cells += td(fmtCount(row.ncollections), Array.isArray(row.ncollections) ? '' : row.ncollections)
               + td(fmtCount(row.nindexes), Array.isArray(row.nindexes) ? '' : row.nindexes)
               + td(fmtCompaction(row.idxCompaction), compactionRank(row.idxCompaction), row.idxCompaction ? 'act' : '');
         }
         return cells;
      }

      function totalsRow(row, label) {
         return '<tr>' + td(label, label, 'name') + metricsCells(row || {}, 'db') + '</tr>';
      }

      function dbRow(db) {
         const name = db.name || '';
         return '<tr>' + td(name, name, 'name') + metricsCells(db, 'db') + '</tr>';
      }

      function nsRow(c) {
         const ns = c.ns || ((c.db ? c.db + '.' : '') + (c.name || ''));
         const mark = c.unauthorized ? ' (unauthorized)' : (c.unavailable ? ' (unavailable)' : '');
         return '<tr>' + td(ns + mark, ns, 'name') + metricsCells(c, 'ns') + td(fmtNum(c.nindexes), c.nindexes) + '</tr>';
      }

      function idxRow(c, idx) {
         const ns = c.ns || ((c.db ? c.db + '.' : '') + (c.name || ''));
         const name = idx.name || '';
         return '<tr>' + td(ns, ns, 'name') + td(name, name, 'name') + bytesTd(idx.storageSize)
            + td(fmtBytes(idx.freeStorageSize) + ' │ ' + fmtPct(idx.reuse), idx.reuse == null ? '' : idx.reuse)
            + td(fmtCompaction(idx.compaction), compactionRank(idx.compaction), idx.compaction ? 'act' : '')
            + '</tr>';
      }

      function catalogs() {
         const topo = data.topology || {};
         const nodes = topo.nodes || [];
         if (!ui.topologyExpanded) {
            return [{ "title": null, "databases": data.databases || [], "namespaces": data.namespaces || [] }];
         }
         return nodes.map(node => {
            const dbs = node.connecting ? (data.databases || []) : (node.databases || []);
            return {
               "title": (node.connecting ? '* ' : '') + (node.instance || node.hostname || ''),
               "node": node,
               "databases": dbs,
               "namespaces": dbs.flatMap(d => d.collections || [])
            };
         }).filter(block => block.node && (block.node.connecting || (block.databases && block.databases.length) || block.node.error));
      }

      function renderBlock(block) {
         const v = verb();
         let html = '';
         if (block.title) html += '<h2>' + esc(block.title) + '</h2>';
         const dbs = (block.databases || []).filter(dbVisible);
         html += tableHtml('Databases',
            ['Database', 'Data size', 'Compression', 'Size on disk', 'Free │ reuse', 'Objects', 'Compaction', 'Collections', 'Indexes', 'Idx compaction'],
            dbs.map(dbRow).join(''));
         if (v === 'summary') return html;
         const nss = dbs.flatMap(d => d.collections || []).filter(collectionVisible);
         html += tableHtml('Namespaces',
            ['Namespace', 'Data size', 'Compression', 'Size on disk', 'Free │ reuse', 'Objects', 'Compaction', 'Indexes'],
            nss.map(nsRow).join(''));
         const idxHtml = nss.flatMap(c => (c.indexes || []).filter(indexVisible).map(idx => idxRow(c, idx))).join('');
         html += tableHtml('Indexes',
            ['Namespace', 'Index', 'Size on disk', 'Free │ reuse', 'Compaction'],
            idxHtml, 2);
         if (v === 'full') {
            const views = dbs.flatMap(d => (d.views || []).map(x => {
               const ns = x.ns || ((d.name ? d.name + '.' : '') + (x.name || ''));
               return '<tr>' + td(ns, ns, 'name') + '</tr>';
            })).join('');
            html += tableHtml('Views', ['View'], views);
         }
         return html;
      }

      function renderTopology() {
         const topo = data.topology || {};
         const nodes = topo.nodes || [];
         if (!nodes.length) return '';
         const head = (topo.kind === 'replSet')
            ? ('Replica set ' + (topo.setName || '') + ' — ' + nodes.length + ' members')
            : (topo.kind === 'sharded')
               ? ('Sharded cluster — ' + nodes.length + ' nodes' + ((topo.shardIds || []).length ? ' — shards ' + JSON.stringify(topo.shardIds) : ''))
               : ('Topology ' + (topo.kind || '') + ' — ' + nodes.length + ' nodes');
         const rows = nodes.map(node => {
            const host = node.instance || node.hostname || '';
            const mark = node.connecting ? '*' : '';
            const stats = node.stats || {};
            return '<tr>'
               + td(mark, mark, 'name')
               + td(host, host, 'name')
               + td(node.role || '', node.role || '', 'name')
               + td(node.proc || '', node.proc || '', 'name')
               + td(node.dbPath || '', node.dbPath || '', 'name')
               + bytesTd(stats.storageSize)
               + td(fmtBytes(stats.freeStorageSize) + ' │ ' + fmtPct(stats.reuse), stats.reuse == null ? '' : stats.reuse)
               + td(node.error || '', node.error || '', node.error ? 'err' : '')
               + '</tr>';
         }).join('');
         let html = tableHtml(head, ['', 'Node', 'Role', 'Type', 'dbPath', 'Size on disk', 'Free │ reuse', 'Error'], rows, 5);
         (topo.errors || []).forEach(err => {
            html += '<p class="warn">' + esc((err && (err.message || err.step)) || err) + '</p>';
         });
         return html;
      }

      function render() {
         const totals = data.totals || {};
         let html = '';
         (data.warnings || []).forEach(w => {
            html += '<p class="warn">[' + esc(w.code || 'NOTE') + '] ' + esc(w.message || '') + '</p>';
         });
         html += renderTopology();
         html += tableHtml('dbPath totals',
            ['', 'Data size', 'Compression', 'Size on disk', 'Free │ reuse', 'Objects', 'Compaction', 'Collections', 'Indexes', 'Idx compaction'],
            totalsRow(totals, 'All namespaces'));
         catalogs().forEach(block => { html += renderBlock(block); });
         root.innerHTML = html;
         root.querySelectorAll('table.sortable').forEach(makeSortable);
      }

      if (verbSel) {
         verbSel.value = ui.verbosity || 'full';
         verbSel.addEventListener('change', render);
      }
      render();
   }

   function htmlDocument(payload, ui) {
      const host = payload.hostname || payload.instance || '';
      const generated = (payload.generatedAt instanceof Date)
         ? payload.generatedAt.toISOString()
         : String(payload.generatedAt || '');
      const title = 'dbstats.js ' + (payload.version || '') + ' — ' + host;
      const boot = Function.prototype.toString.call(htmlReportBoot)
         .replace(/<\/script/gi, '<\\/script');
      const css = 'html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
         + ':root{--bg:#121212;--fg:#e8e8e8;--muted:#9aa0a6;--acc:#7dce7a;--cyan:#6ec8d4;--warn:#d4c06e;--err:#e07070;--line:#2a2a2a;--th:#1c1c1c}'
         + 'header{padding:1rem 1.25rem;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.75rem 1.5rem;align-items:baseline}'
         + 'h1{font-size:1.1rem;margin:0;color:var(--acc)}'
         + 'h2{font-size:1rem;margin:1.5rem 0 .5rem;color:var(--acc)}'
         + '.meta{color:var(--muted)} .meta b{color:var(--cyan);font-weight:600}'
         + '.controls{margin-left:auto;display:flex;gap:1rem;align-items:center}'
         + 'label{color:var(--muted)} select{background:var(--th);color:var(--fg);border:1px solid var(--line);padding:.2rem .4rem}'
         + 'main{padding:1rem 1.25rem 3rem}'
         + 'table{border-collapse:collapse;width:100%;margin:0 0 1.5rem;font-size:13px}'
         + 'caption{text-align:left;color:var(--acc);font-weight:600;padding:.4rem 0}'
         + 'th,td{border-bottom:1px solid var(--line);padding:.28rem .55rem;text-align:right;white-space:nowrap}'
         + 'th.name,td.name{text-align:left}'
         + 'th{background:var(--th);color:var(--acc);cursor:pointer;position:sticky;top:0;user-select:none}'
         + 'th.sort-asc:after{content:" \\25b2";font-size:.7em} th.sort-desc:after{content:" \\25bc";font-size:.7em}'
         + 'tr:hover td{background:#1a1a1a} td.act{color:var(--warn)} td.err{color:var(--err)}'
         + '.warn{color:var(--warn);margin:.35rem 0}';
      return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
         + '<meta name="viewport" content="width=device-width, initial-scale=1">'
         + '<title>' + htmlEsc(title) + '</title>'
         + '<style>' + css + '</style></head><body>'
         + '<header><h1>dbstats.js v' + htmlEsc(payload.version || '') + '</h1>'
         + '<div class="meta">'
         + '<b>' + htmlEsc(host) + '</b>'
         + ' · ' + htmlEsc(payload.proc || '')
         + ' · ' + htmlEsc(payload.mongod || '')
         + (payload.dbPath ? ' · ' + htmlEsc(payload.dbPath) : '')
         + (generated ? ' · ' + htmlEsc(generated) : '')
         + (payload.catalog && payload.catalog.builder ? ' · catalog ' + htmlEsc(payload.catalog.builder) : '')
         + '</div>'
         + '<div class="controls"><label>verbosity <select id="verbosity">'
         + '<option value="full">full</option>'
         + '<option value="summary">summary</option>'
         + '<option value="summaryidx">summaryIdx</option>'
         + '<option value="compactonly">compactOnly</option>'
         + '</select></label></div></header>'
         + '<main id="report"></main>'
         + '<script>window.__DBSTATS=' + jsonForScript({ "payload": payload, "ui": ui }) + ';</script>'
         + '<script>(' + boot + ')();</script>'
         + '</body></html>';
   }

   function htmlOut(dbStats = {}) {
      /*
       *  HTML from the JSON contract (embed + click-to-sort).
       *  Verbosity / topology expanded filter that payload in the page.
       *  Colour is the inline stylesheet (not an option; later a pluggable CSS).
       *  stdout.write so mdblib console.log colour tags cannot rewrite the document.
       */
      const payload = toJsonContract(dbStats);
      const ui = {
         "verbosity": outputVerbosity(),
         "topologyExpanded": outputTopologyExpanded()
      };
      process.stdout.write(htmlDocument(payload, ui) + '\n');
      return payload;
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
      return shellVer(2.0) ? arr.toSorted(cmp) : arr.slice().sort(cmp);
   }

   function sortBy(type) {
      /*
       *  Resolve options.sort[type] → comparator (first non-zero key wins).
       *  reuse / idxReuse are free/storage ratios. compaction is the
       *  compact/rebuild/resync/wait rank (n/a last).
       */
      const sortByType = sortOptions[type] || {};
      const sortKey = Object.keys(sortByType).find(key => sortByType[key] !== 0) || 'name';
      const dir = sortByType[sortKey] === -1 ? -1 : 1;
      const indexRow = type === 'index';
      const getters = {
         "name": o => o.name,
         "namespace": o => o.namespace,
         "dataSize": o => o.dataSize,
         "storageSize": o => o.storageSize,
         "freeStorageSize": o => o.freeStorageSize,
         "idxDataSize": o => {
            const free = indexRow ? o.freeStorageSize : o.totalIndexBytesReusable;
            const storage = indexRow ? o.storageSize : o.totalIndexSize;
            if (!freeStorageKnown(free)) return null;
            return +storage - +free;
         },
         "idxStorageSize": o => indexRow ? o.storageSize : o.totalIndexSize,
         "idxFreeStorageSize": o => indexRow ? o.freeStorageSize : o.totalIndexBytesReusable,
         "objects": o => o.objects,
         "reuse": o => jsonReuse(o.freeStorageSize, o.storageSize),
         "idxReuse": o => jsonReuse(o.totalIndexBytesReusable, o.totalIndexSize),
         "compression": o => o.compression,
         "compaction": o => compactionSortKey(o, type)
      };

      return compareBy(getters[sortKey] || getters.name, dir);
   }

   function formatUnit(metric) {
      /*
       *  Pretty format unit
       */
      return scaled.format(metric);
   }

   function formatStorageSize(bytes, { stub = false, allocUnit } = {}) {
      /*
       *  On-disk size. Stubs stay 0. Measured empty WT tables display the allocation
       *  unit (default 4 KiB). JSON keeps the measured number.
       */
      if (stub) return formatUnit(bytes == null ? 0 : bytes);
      if (bytes == null || Number.isNaN(+bytes)) return formatUnit(0);
      if (+bytes === 0) {
         const unit = +allocUnit;
         const floor = (Number.isFinite(unit) && unit > 0) ? unit : WIREDTIGER_MIN_ALLOC_SIZE;
         return formatUnit(floor);
      }
      return formatUnit(bytes);
   }

   function formatPct(numerator = 0, denominator = 1) {
      /*
       *  Pretty format percentage. Zero/null/NaN denominator → n/a (not Infinity%/NaN%).
       */
      const num = +numerator, den = +denominator;
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 'n/a ';
      return `${Number.parseFloat(((num / den) * 100).toFixed(1))}%`;
   }

   function freeStorageKnown(bytes) {
      return bytes != null && !Number.isNaN(+bytes);
   }

   function formatFree(bytes, storageSize, { lowerBound = false } = {}) {
      /*
       *  Free blocks │ reuse. Hidden WT free-space (Atlas M0/Flex) → n/a, not 0.
       *  lowerBound: collStats rollup may omit unauthorized/filtered NS (*).
       */
      if (!freeStorageKnown(bytes)) {
         return (`n/a │${'n/a '.padStart(6)}`).padStart(columnWidth + 8);
      }
      const unit = formatUnit(bytes) + (lowerBound ? '*' : '');
      return (unit + ' │' + formatPct(bytes, storageSize).padStart(6)).padStart(columnWidth + 8);
   }

   function formatCompaction(kind, storageSize, freeStorageSize, { oplog = false, idIndex = false, incomplete = false } = {}) {
      if (!freeStorageKnown(freeStorageSize)) return 'n/a ';
      if (kind === 'collection') {
         if (oplog && compactionHelper('collection', storageSize, freeStorageSize)) return 'wait';
         if (compactionHelper('collection', storageSize, freeStorageSize)) return 'compact';
         return incomplete ? 'n/a ' : '———— ';
      }
      if (kind === 'index') {
         if (idIndex && compactionHelper('index', storageSize, freeStorageSize)) return 'compact';
         if (compactionHelper('index', storageSize, freeStorageSize)) return 'rebuild';
         return incomplete ? 'n/a ' : '———— ';
      }
      if (kind === 'dbPath') {
         if (compactionHelper('dbPath', storageSize, freeStorageSize)) return 'resync';
         return incomplete ? 'n/a ' : '———— ';
      }
      return incomplete ? 'n/a ' : '———— ';
   }

   function rankCompactionLabel(label) {
      /*
       *  Higher = stronger recommendation. n/a and unknown sort last.
       */
      if (label === 'resync') return 4;
      if (label === 'rebuild') return 3;
      if (label === 'compact') return 2;
      if (label === 'wait') return 1;
      if (label === '———— ') return 0;
      return null;
   }

   function compactionSortKey(o = {}, type = 'collection') {
      if (type === 'db') {
         const ns = rankCompactionLabel(formatCompaction('collection', o.storageSize, o.freeStorageSize, {
            "incomplete": o.freeStorageComplete === false
         }));
         const idx = rankCompactionLabel(formatCompaction('index', o.totalIndexSize, o.totalIndexBytesReusable, {
            "incomplete": o.totalIndexBytesReusableComplete === false
         }));
         if (ns == null && idx == null) return null;
         return Math.max(ns == null ? 0 : ns, idx == null ? 0 : idx);
      }
      if (type === 'index') {
         return rankCompactionLabel(formatCompaction('index', o.storageSize, o.freeStorageSize, {
            "idIndex": o.name == '_id_',
            "incomplete": o.freeStorageComplete === false
         }));
      }
      return rankCompactionLabel(formatCompaction('collection', o.storageSize, o.freeStorageSize, {
         "oplog": o.name == 'oplog.rs' || o.namespace == 'local.oplog.rs',
         "incomplete": o.freeStorageComplete === false
      }));
   }

   function formatRatio(metric) {
      /*
       *  Pretty format compression ratio. Non-finite (÷0 from StorageMetrics.compression) → n/a.
       */
      const value = +metric;
      if (!Number.isFinite(value)) return 'n/a ';
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

   function stripMarkupTags(str) {
      return String(str == null ? '' : str).replace(/\[[a-zA-Z][a-zA-Z0-9 ]*\]|\[\/\]/g, '');
   }

   function codePointWidth(cp) {
      if (!cp) return 0;
      if (cp <= 0x1F || (cp >= 0x7F && cp <= 0x9F)) return 0;
      if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF) return 0;
      if (cp >= 0x300 && cp <= 0x36F) return 0;
      if (cp >= 0xFE00 && cp <= 0xFE0F) return 0;
      if (cp >= 0xE0100 && cp <= 0xE01EF) return 0;
      if (cp >= 0x1100 && cp <= 0x115F) return 2;
      if (cp >= 0x2329 && cp <= 0x232A) return 2;
      if (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) return 2;
      if (cp >= 0xAC00 && cp <= 0xD7A3) return 2;
      if (cp >= 0xF900 && cp <= 0xFAFF) return 2;
      if (cp >= 0xFE10 && cp <= 0xFE19) return 2;
      if (cp >= 0xFE30 && cp <= 0xFE6F) return 2;
      if (cp >= 0xFF00 && cp <= 0xFF60) return 2;
      if (cp >= 0xFFE0 && cp <= 0xFFE6) return 2;
      if (cp >= 0x1F000 && cp <= 0x1FFFF) return 2;
      if (cp >= 0x2300 && cp <= 0x23FF) return 2;
      if (cp >= 0x2600 && cp <= 0x27BF) return 2;
      if (cp >= 0x2B00 && cp <= 0x2BFF) return 2;
      return 1;
   }

   function visibleWidth(str) {
      let w = 0;
      for (const ch of stripMarkupTags(str)) w += codePointWidth(ch.codePointAt(0));
      return w;
   }

   function padVisible(str, width, fill = ' ') {
      str = String(str == null ? '' : str);
      const w = visibleWidth(str);
      if (w >= width) return str;
      return str + String(fill).repeat(width - w);
   }

   function truncateLabel(label, maxLen, cutWidth) {
      label = (label == null) ? '' : String(label);
      if (visibleWidth(label) <= maxLen) return label;
      const cut = (cutWidth != null) ? cutWidth : Math.max(0, maxLen - 1);
      let out = '';
      let w = 0;
      for (const ch of label) {
         const cw = codePointWidth(ch.codePointAt(0));
         if (w + cw > cut) break;
         out += ch;
         w += cw;
      }
      return `${out}~`;
   }

   function formatCompressionCell(compression, compressor) {
      if (compressor == null || compressor === '')
         return formatRatio(compression).padStart(columnWidth + 1);
      const abbr = (compressor == 'snappy') ? 'snpy' : compressor;
      return (formatRatio(compression) + abbr.padStart(abbr.length + 1)).padStart(columnWidth + 1);
   }

   function metricsCols({
         dataSize = 0, compression = 0, compressor, storageSize = 0, freeStorageSize = 0,
         objects, compaction = '———— ', mode = 'full', lowerBound = false,
         stub = false, allocUnit
      } = {}) {
      /*
       *  Shared metric columns: full NS row | index rollup | index detail row
       *  Leaf storage (collection/index file) may display the WT min alloc; rollups do not.
       */
      const compact = String(compaction).padStart(columnWidth - 2);
      if (mode === 'indexRow') {
         return `${formatStorageSize(storageSize, { stub, allocUnit }).padStart(columnWidth)} ${formatFree(freeStorageSize, storageSize, { lowerBound })} ${''.padStart(columnWidth)} [cyan]${compact}[/]`;
      }
      if (mode === 'indexRollup') {
         return `${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${formatFree(freeStorageSize, storageSize, { lowerBound })} ${''.padStart(columnWidth)} [cyan]${compact}[/]`;
      }
      const obj = (objects == null ? '' : objects.toString()).padStart(columnWidth);
      return `${formatUnit(dataSize).padStart(columnWidth)} ${formatCompressionCell(compression, compressor)} ${formatStorageSize(storageSize, { stub, allocUnit }).padStart(columnWidth)} ${formatFree(freeStorageSize, storageSize, { lowerBound })} ${obj} [cyan]${compact}[/]`;
   }

   function printRollupRows({
         shards = [], dataSize, compression, storageSize, freeStorageSize, objects,
         namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         nsLabel, idxLabel, nsCompactionKind = 'collection',
         freeIncomplete = false, idxIncomplete = false
      } = {}) {
      /*
       *  Shared DB / dbPath namespace + index subtotal rows (sharded or not)
       */
      const nsCompaction = formatCompaction(nsCompactionKind, storageSize, freeStorageSize, { "incomplete": freeIncomplete });
      const idxCompaction = formatCompaction('index', totalIndexSize, totalIndexBytesReusable, { "incomplete": idxIncomplete });
      const nsMetrics = metricsCols({
         dataSize, compression, storageSize, freeStorageSize, objects, "compaction": nsCompaction,
         "lowerBound": freeIncomplete
      });
      const idxMetrics = metricsCols({
         "storageSize": totalIndexSize,
         "freeStorageSize": totalIndexBytesReusable,
         "compaction": idxCompaction,
         "mode": 'indexRollup',
         "lowerBound": idxIncomplete
      });
      if (shards.length > 0 && Array.isArray(namespaces) && Array.isArray(nindexes)) {
         console.log(`[bold][green]${padVisible(`${nsLabel}:`, rowHeader)}[/] ${nsMetrics}`);
         console.log(formatShardCounts(shards, namespaces));
         console.log(`[bold][green]${padVisible(`${idxLabel}:`, rowHeader)}[/] ${idxMetrics}`);
         console.log(formatShardCounts(shards, nindexes));
      } else {
         console.log(`[bold][green]${padVisible(`${nsLabel}: ${JSON.stringify(namespaces)}`, rowHeader)}[/] ${nsMetrics}`);
         console.log(`[bold][green]${padVisible(`${idxLabel}: ${JSON.stringify(nindexes)}`, rowHeader)}[/] ${idxMetrics}`);
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
      console.log(`[bold][green]${padVisible(`Namespaces: ${nsTotal}`, rowHeader)}[/] [bold][green]${columnHeaders()}[/]`);
      return;
   }

   function printCollection({ name, dataSize, compression, compressor, storageSize, freeStorageSize, objects, allocUnit, internalPageSize, freeStorageComplete } = {}) {
      const stub = isUnauthorizedCollection({ name }) || isUnavailableCollection({ name });
      const incomplete = freeStorageComplete === false;
      const compaction = formatCompaction('collection', storageSize, freeStorageSize, { "oplog": name == 'oplog.rs', incomplete });
      printRule('light');
      name = truncateLabel(name, 45, rowHeader - 4);
      console.log(`╰>[cyan]${padVisible(' ' + name, rowHeader - 2)}[/] ${metricsCols({ dataSize, compression, compressor, storageSize, freeStorageSize, objects, compaction, stub, "allocUnit": allocUnit || internalPageSize, "lowerBound": incomplete })}`);
      return;
   }

   function printNamespace({ namespace, name, dataSize, compression, compressor, storageSize, freeStorageSize, objects, allocUnit, internalPageSize, freeStorageComplete } = {}) {
      const stub = isUnauthorizedCollection({ "name": name || namespace }) || isUnavailableCollection({ "name": name || namespace });
      const incomplete = freeStorageComplete === false;
      const compaction = formatCompaction('collection', storageSize, freeStorageSize, { "oplog": namespace == 'local.oplog.rs', incomplete });
      printRule('light');
      namespace = truncateLabel(namespace, 45, rowHeader - 4);
      console.log(`╰>[cyan]${padVisible(' ' + namespace, rowHeader - 2)}[/] ${metricsCols({ dataSize, compression, compressor, storageSize, freeStorageSize, objects, compaction, stub, "allocUnit": allocUnit || internalPageSize, "lowerBound": incomplete })}`);
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

   function printIndex({ name, storageSize, freeStorageSize, freeStorageComplete } = {}) {
      const indexWidth = rowHeader + columnWidth * 2;
      const incomplete = freeStorageComplete === false;
      const compaction = formatCompaction('index', storageSize, freeStorageSize, { "idIndex": name == '_id_', incomplete });
      console.log(`  [yellow]${'━'.repeat(termWidth - 2)}[/]`);
      name = truncateLabel(name, 64, indexWidth);
      console.log(`  ╰» [red]${padVisible(name, indexWidth - 2)}[/] ${metricsCols({ storageSize, freeStorageSize, compaction, "mode": 'indexRow', "lowerBound": incomplete })}`);
      return;
   }

   function printDbHeader({ name } = {}) {
      console.log('');
      printRule('heavy');
      console.log(`[bold][green]Database:[/] [cyan]${padVisible(String(name || ''), Math.max(0, rowHeader - 10))}[/] [bold][green]${columnHeaders()}[/]`);
      return;
   }

   function printDb({
         shards, dataSize, compression, storageSize, freeStorageSize, objects, namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         freeStorageComplete, totalIndexBytesReusableComplete
      } = {}) {
      printRule('light');
      printRollupRows({
         shards, dataSize, compression, storageSize, freeStorageSize, objects,
         namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         "nsLabel": 'Namespaces subtotal',
         "idxLabel": 'Indexes subtotal',
         "nsCompactionKind": 'collection',
         "freeIncomplete": freeStorageComplete === false,
         "idxIncomplete": totalIndexBytesReusableComplete === false
      });
      printRule('heavy');
      return;
   }

   function printFreeStorageFootnote({
         freeStorageSize, totalIndexBytesReusable,
         freeStorageSizeSource, totalIndexBytesReusableSource,
         freeStorageComplete, totalIndexBytesReusableComplete,
         catalogCoverageComplete, databases
      } = {}) {
      const hide = hidesDbStatsFreeStorage();
      const rolled = freeStorageSizeSource === 'collStatsRollup'
                  || totalIndexBytesReusableSource === 'collStatsRollup';
      const incomplete = freeStorageComplete === false || totalIndexBytesReusableComplete === false;
      const unknown = !freeStorageKnown(freeStorageSize) || !freeStorageKnown(totalIndexBytesReusable);
      const listingIncomplete = catalogCoverageComplete === false
         || (databases || []).some(d => d.catalogCoverageComplete === false);

      if (hide && rolled && incomplete) {
         console.log('[yellow][NOTE] * Free blocks rolled up from collection WiredTiger stats; db.stats() omits reusable bytes on this tier. Totals may exclude unauthorized or filtered namespaces and are a lower bound.[/]');
         return;
      }
      if (hide && rolled) {
         console.log('[yellow][NOTE] Free blocks rolled up from collection WiredTiger stats; db.stats() omits reusable bytes on this tier.[/]');
         return;
      }
      if (hide && unknown) {
         console.log('[yellow][WARN] Free blocks │ reuse unavailable (WiredTiger free-space stats hidden on this tier)[/]');
         return;
      }
      if (incomplete) {
         console.log('[yellow][NOTE] * Database and dbPath totals are a rollup of listed collections; they exclude filtered or unauthorized namespaces and are a lower bound.[/]');
         return;
      }
      if (listingIncomplete) {
         console.log('[yellow][NOTE] Listed collections may omit filtered or unauthorized namespaces; database and dbPath totals are db.stats().[/]');
      }
   }

   function topologyDepthExpanded(topology) {
      const kind = topology && topology.cluster && topology.cluster.kind;
      if (kind === 'sharded') return topologyOptions.sharded === 'expanded';
      return topologyOptions.replica === 'expanded';
   }

   function outputTopologyExpanded() {
      return String(outputOptions.topology || 'summary').toLowerCase() === 'expanded';
   }

   function outputVerbosity() {
      const v = String(outputOptions.verbosity || 'full').toLowerCase();
      if (v === 'summary' || v === 'summaryidx' || v === 'compactonly') return v;
      return 'full';
   }

   function nodeDbPath(node) {
      if (node && node.stats && node.stats.dbPath) return node.stats.dbPath;
      return (node && node.dbPath) || '';
   }

   function nodeIdentityFields(node = {}) {
      return {
         "host": String(node.instance || node.hostname || 'unknown'),
         "role": String(node.role || ''),
         "proc": String(node.proc || ''),
         "path": String(nodeDbPath(node) || ''),
         "connecting": node.connecting === true,
         "error": node.error || ''
      };
   }

   function nodeIdentityWidths(nodes = []) {
      const rows = (nodes || []).map(nodeIdentityFields);
      const maxLen = (key) => rows.reduce((n, r) => Math.max(n, visibleWidth(r[key] || '')), 0);
      return {
         "host": maxLen('host'),
         "role": maxLen('role'),
         "proc": maxLen('proc'),
         "path": maxLen('path')
      };
   }

   function formatNodeIdentity(node, widths = {}, { indent = '' } = {}) {
      const f = nodeIdentityFields(node);
      const hostW = widths.host || visibleWidth(f.host);
      const roleW = widths.role || visibleWidth(f.role);
      const procW = widths.proc || visibleWidth(f.proc);
      const pathW = widths.path || visibleWidth(f.path);
      const mark = f.connecting ? '[green]*[/] ' : '  ';
      const err = f.error ? `   [red]${f.error}[/]` : '';
      return `${indent}${mark}[cyan]${padVisible(f.host, hostW)}[/]   [bold][green]Role:[/] [cyan]${padVisible(f.role, roleW)}[/]   [bold][green]Type:[/] [cyan]${padVisible(f.proc, procW)}[/]   [bold][green]dbPath:[/] [cyan]${padVisible(f.path, pathW)}[/]${err}`;
   }

   function printNodeBanner(node = {}, widths) {
      console.log('');
      printRule('heavy');
      console.log(`[bold][green]Node:[/] ${formatNodeIdentity(node, widths)}`);
   }

   function printTopologyMembers(topology, widths) {
      const nodes = (topology && Array.isArray(topology.nodes)) ? topology.nodes : [];
      if (!nodes.length) return false;
      const cols = widths || nodeIdentityWidths(nodes);
      const cluster = topology.cluster || {};
      const kind = cluster.kind || '';
      const setName = cluster.setName;
      if (kind === 'replSet') {
         const name = setName || 'replSet';
         console.log(`[bold][green]Replica set:[/] [cyan]${name}[/]   [bold][green]Members:[/] [cyan]${nodes.length}[/]   [bold][green]Version:[/] [cyan]${db.version()}[/]`);
      } else if (kind === 'sharded') {
         const shardIds = Array.isArray(cluster.shardIds) ? cluster.shardIds : [];
         const shardsBit = shardIds.length ? `   [bold][green]Shards:[/] ${JSON.stringify(shardIds)}` : '';
         console.log(`[bold][green]Sharded cluster[/]   [bold][green]Nodes:[/] [cyan]${nodes.length}[/]   [bold][green]Version:[/] [cyan]${db.version()}[/]${shardsBit}`);
      } else if (kind) {
         console.log(`[bold][green]Topology:[/] [cyan]${kind}[/]   [bold][green]Nodes:[/] [cyan]${nodes.length}[/]   [bold][green]Version:[/] [cyan]${db.version()}[/]`);
      } else {
         console.log(`[bold][green]Nodes:[/] [cyan]${nodes.length}[/]   [bold][green]Version:[/] [cyan]${db.version()}[/]`);
      }
      nodes.forEach(node => {
         console.log(formatNodeIdentity(node, cols, { "indent": '  ' }));
      });
      return true;
   }

   function printDbPath(dbStats = {}, { hostLine = true } = {}) {
      const {
         dbPath, shards = [], proc, hostname, compression, dataSize, storageSize, freeStorageSize, objects, namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         freeStorageComplete, totalIndexBytesReusableComplete
      } = dbStats;
      console.log('');
      printRule('heavy');
      console.log(`[bold][green]${padVisible('dbPath totals', rowHeader)} ${columnHeaders()}[/]`);
      printRule('light');
      printRollupRows({
         shards, dataSize, compression, storageSize, freeStorageSize, objects,
         namespaces, nindexes, totalIndexSize, totalIndexBytesReusable,
         "nsLabel": 'All namespaces',
         "idxLabel": 'All indexes',
         "nsCompactionKind": 'dbPath',
         "freeIncomplete": freeStorageComplete === false,
         "idxIncomplete": totalIndexBytesReusableComplete === false
      });
      printRule('heavy');
      const topology = dbStats.topology;
      const nodeCount = (topology && Array.isArray(topology.nodes)) ? topology.nodes.length : 0;
      if (hostLine) {
         if (nodeCount > 1) {
            printTopologyMembers(topology);
         } else {
            console.log(`[bold][green]Hostname:[/] [cyan]${hostname}[/]   [bold][green]Type:[/] [cyan]${proc}[/]   [bold][green]Version:[/] [cyan]${db.version()}[/]   [bold][green]dbPath:[/] [cyan]${dbPath}[/]`);
            if (shards.length > 0) {
               console.log(`[bold][green]Shards:[/] ${JSON.stringify(shards)}`);
            }
         }
      }
      printFreeStorageFootnote(dbStats);
      if (dbStats.catalogFallback === true) {
         console.log('[yellow][NOTE] Catalog listing used listCollections; $listCatalog/$listClusterCatalog was unavailable or unauthorized.[/]');
      }
      printRule('heavy');
      console.log('');
      return;
   }

   dbStats = await main();
   return dbStats;
})();

// EOF
