/*
 *  Name: "dbstats.js"
 *  Version: "0.9.2"
 *  Description: DB storage stats uber script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet [--eval "let options = {...};"] [-f|--file] dbstats.js"

/*
 *  options = {
 *     filter: {
 *        db: <null|<string>|/<regex>/>,
 *        collection: <null|<string>|/<regex>/>
 *     },
 *     sort: {
 *        db: {
 *           name: <1|0|-1>,
 *           dataSize: <1|0|-1>,
 *           storageSize: <1|0|-1>,
 *           freeStorageSize: <1|0|-1>,
 *           idxStorageSize: <1|0|-1>, // TBA
 *           freeStorageSize: <1|0|-1>,
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
 *        namespace: { // TBA
 *           name: <1|0|-1>,
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
 *     "minThreshold": { // TBA
 *        "dataSize": <int>,
 *        "storageSize": <int>,
 *        "freeStorageSize": <int>,
 *        "reuse": <int>,
 *        "compression": <int>,
 *        "objects": <int>
 *     },
 *     output: { // TBA
 *        format: <'table'|'json'|'html'>,
 *        topology: <'summary'|'expanded'>,
 *        colour: <true|false>,
 *        verbosity: <'full'|'summary'|'summaryIdx'|'compactOnly'/>
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
 *    mongosh --quiet --eval "let options = { filter: { db: 'database' };" -f dbstats.js
 *    mongosh --quiet --eval "let options = { filter: { collection: '^c.+' };" -f dbstats.js
 *    mongosh --quiet --eval "let options = { filter: { db: /(^(?!(d.+)).+)/i, collection: /collection/i };" -f dbstats.js
 *
 *  Examples of using sorting:
 *
 *    mongosh --quiet --eval "let options = { sort: { collection: { dataSize: -1 }, index: { idxStorageSize: -1 } };" -f dbstats.js
 *    mongosh --quiet --eval "let options = { sort: { collection: { freeStorageSize: -1 }, index: { idxFreeStorageSize: -1 } };" -f dbstats.js
 */

(() => {
   /*
    *  Ensure authorized users have the following minimum required roles
    *  clusterMonitor@admin && readAnyDatabase@admin
    */
   try {
      db.adminCommand({ "features": 1 });
   } catch(error) { // MongoServerError: command features requires authentication
      print('[ERR] MongoServerError: features command requires authentication');
   }
   let monitorRoles = ['clusterMonitor'],
      adminRoles = ['atlasAdmin', 'clusterAdmin', 'backup', 'root', '__system'],
      dbRoles = ['dbAdminAnyDatabase', 'readAnyDatabase', 'readWriteAnyDatabase'];
   let { 'authInfo': { authenticatedUsers, authenticatedUserRoles } } = db.adminCommand({ "connectionStatus": 1 });
   let authz = authenticatedUserRoles.filter(({ role, db }) => dbRoles.includes(role) && db == 'admin'),
      users = authenticatedUserRoles.filter(({ role, db }) => adminRoles.includes(role) && db == 'admin'),
      monitors = authenticatedUserRoles.filter(({ role, db }) => monitorRoles.includes(role) && db == 'admin');
   if (!(!(!!authenticatedUsers.length) || !!users.length || !!monitors.length && !!authz.length)) {
      print(`[WARN] The connecting user's authz privileges may be inadequate to report all namespaces statistics`);
      print(`[WARN] consider inheriting the built-in roles for 'clusterMonitor@admin' and 'readAnyDatabase@admin' at a minimum`);
   }
})();

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(async() => {
   let __script = { "name": "dbstats.js", "version": "0.9.2" };
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
         print(`\x1b[31m[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory\x1b[0m`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.log(`\n\n\x1b[33m${__comment}\x1b[0m`);
   if (shellVer() < serverVer() && typeof process === 'undefined') console.log(`\n\x1b[31m[WARN] Possibly incompatible legacy shell version detected: ${version()}\x1b[0m`);
   if (shellVer() < 1.0 && typeof process !== 'undefined') console.log(`\n\x1b[31m[WARN] Possible incompatible non-GA shell version detected: ${version()}\x1b[0m`);
   if (serverVer() < 4.2) console.log(`\n\x1b[31m[ERROR] Unsupported mongod/s version detected: ${db.version()}\x1b[0m`);

   /*
    *  User defined parameters
    */

   let optionDefaults = {
      "filter": {
         "db": /^.+/,
         "collection": /^.+/
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
         "namespace": { // TBA
            "name": 1,
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
            "idxDataSize": 0, // TBA (inferred from "storageSize - freeStorageSize")
            "idxStorageSize": 0,
            "idxFreeStorageSize": 0,
            "reuse": 0, // TBA
            "compaction": 0 // TBA
         }
      },
      "minThreshold": { // TBA
         "dataSize": 0,
         "storageSize": 0,
         "freeStorageSize": 0,
         "reuse": 0,
         "compression": 0,
         "objects": 0
      },
      "output": { // TBA
         "format": 'table', // ['table'|'json'|'html']
         "topology": 'summary', // ['summary'|'expanded']
         "colour": true, // [true|false]
         "verbosity": 'full' // ['full'|'summary'|'summaryIdx'|'compactOnly']
      },
      "topology": { // TBA
         "discover": true, // [true|false]
         "replica": 'summary', // ['summary'|'expanded']
         "sharded": 'summary' // ['summary'|'expanded']
      }
   };

   typeof options === 'undefined' && (options = { filter: {}, sort: {} }) || options;

   /*
    *  Global defaults
    */

   // scaler unit B, KiB, MiB, GiB, TiB, PiB
   let scaled = new AutoFactor();

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 137) || termWidth;
   typeof columnWidth === 'undefined' && (columnWidth = 14) || columnWidth;
   typeof rowHeader === 'undefined' && (rowHeader = 40) || rowHeader;

   // connection preferences
   typeof readPref === 'undefined' && (readPref = (hello().secondary) ? 'primaryPreferred' : 'secondaryPreferred');

   async function main() {
      /*
       *  main
       */
      slaveOk(readPref);
      // printDbPath(await getStats());
      let dbStats = await getStats();
      printStats(dbStats);
      // jsonOut(dbStats);
      // htmlOut(dbStats);

      return;
   }

   async function getStats() {
      /*
       *  Gather DB stats
       */
      let { 'db': dbFilter = /^.+/, 'collection': collFilter = /^.+/ } = { ...optionDefaults.filter, ...options.filter };
      let dbPath = new MetaStats();
      dbPath.init();
      // let dbNames = getDBNames(dbFilter).toSorted(sortAsc); // mongosh only
      let dbNames = getDBNames(dbFilter).sort(sortAsc);
      dbPath.databases = dbNames.map(dbName => {
         let database = new MetaStats($stats(dbName));
         database.init();
         let systemFilter = /(?:^(?!(system\..+|replset\..+)$).+)/;
         let collNames = db.getSiblingDB(dbName).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": new RegExp(collFilter)
            }, true, true
         // ).filter(({ 'name': collName }) => collName.match(systemFilter)).toSorted(sortNameAsc); // mongosh only
         ).filter(({ 'name': collName }) => collName.match(systemFilter)).sort(sortNameAsc);
         database.collections = collNames.map(({ 'name': collName }) => {
            let collection = new MetaStats($collStats(dbName, collName));
            collection.init();
            collection.indexes.sort(sortBy('index'));
            // database.freeStorageSize += collection.freeStorageSize;
            // database.totalIndexBytesReusable += collection.totalIndexBytesReusable;
            return collection;
         }).sort(sortBy('collection'));
         database.views = db.getSiblingDB(dbName).getCollectionInfos({
               "type": "view",
               "name": new RegExp(collFilter)
            }, true, true
         ).sort(sortBy('view'));
         dbPath.ncollections += database.ncollections;
         dbPath.nindexes += database.nindexes;
         dbPath.dataSize += database.dataSize;
         dbPath.storageSize += database.storageSize;
         dbPath.freeStorageSize += database.freeStorageSize;
         dbPath.objects += database.objects;
         dbPath.orphans += database.orphans;
         dbPath.totalIndexSize += database.totalIndexSize;
         dbPath.totalIndexBytesReusable += database.totalIndexBytesReusable;

         return database;
      // }).toSorted(sortBy('db')); // mongosh only
      }).sort(sortBy('db'));

      return dbPath;
   }

   function printStats(dbStats = {}) {
      /*
       *  Print DB stats report
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

   function jsonOut(dbStats = {}) {
      /*
       *  JSON out
       */
      console.log(util.inspect(dbStats, { "depth": null, "colors": true }));

      return;
   }

   function htmlOut(dbStats = {}) {
      /*
       *  HTML out
       */
      console.log('HTML support TBA');

      return;
   }

   function sortBy(type) {
      /*
       *  sortBy value
       */
      // console.log(`options:`, options);
      let sortOptions = { ...optionDefaults.sort[type], ...options.sort[type] };
      // console.log(`sortOptions:`, sortOptions);
      let sortKey = Object.keys(sortOptions).find(key => sortOptions[key] !== 0) || 'name';
      let sortValue = sortOptions[sortKey];
      // console.log(`sortKey:`, sortKey, `sortValue:`, sortValue);
      switch (sortValue) {
         case -1:
            sortValue = 'desc';
            break;
         default:
            sortValue = 'asc';
      }

      let sortFns = {
         "sort": {
            "asc": sortAsc,
            "desc": sortDesc
         },
         "name": {
            "asc": sortNameAsc,
            "desc": sortNameDesc
         },
         "dataSize": {
            "asc": sortDataSizeAsc,
            "desc": sortDataSizeDesc
         },
         "storageSize": {
            "asc": storageSizeAsc,
            "desc": storageSizeDesc
         },
         "freeStorageSize": {
            "asc": sortFreeStorageSizeAsc,
            "desc": sortFreeStorageSizeDesc
         },
         "idxDataSize": {
            "asc": sortIdxDataSizeAsc,
            "desc": sortIdxDataSizeDesc
         },
         "idxStorageSize": {
            "asc": sortIdxStorageSizeAsc,
            "desc": sortIdxStorageSizeDesc
         },
         "idxFreeStorageSize": {
            "asc": sortIdxFreeStorageSizeAsc,
            "desc": sortIdxFreeStorageSizeDesc
         },
         "reuse": { // TBA
            "asc": sortAsc,
            "desc": sortDesc
         },
         "compression": { // TBA
            "asc": sortAsc,
            "desc": sortDesc
         },
         "objects": {
            "asc": sortObjectsAsc,
            "desc": sortObjectsDesc
         },
         "compaction": { // TBA
            "asc": sortAsc,
            "desc": sortDesc
         }
      };

      // console.log(`sortFn:`, sortFns[sortKey][sortValue]);
      return sortFns[sortKey][sortValue];
   }

   function sortAsc(x, y) {
      /*
       *  sort by value ascending
       */
      return x.localeCompare(y);
   }

   function sortDesc(x, y) {
      /*
       *  sort by value descending
       */
      return y.localeCompare(x);
   }

   function sortNameAsc(x, y) {
      /*
       *  sort by name ascending
       */
      return x.name.localeCompare(y.name);
   }

   function sortNameDesc(x, y) {
      /*
       *  sort by name descending
       */
      return y.name.localeCompare(x.name);
   }

   function sortDataSizeAsc(x, y) {
      /*
       *  sort by dataSize ascending
       */
      return x.dataSize - y.dataSize;
   }

   function sortDataSizeDesc(x, y) {
      /*
       *  sort by dataSize descending
       */
      return y.dataSize - x.dataSize;
   }

   function sortIdxStorageSizeAsc(x, y) {
      /*
       *  sort by index dataSize ascending
       */
      return x['file size in bytes'] - y['file size in bytes'];
   }

   function sortIdxStorageSizeDesc(x, y) {
      /*
       *  sort by index dataSize descending
       */
      return y['file size in bytes'] - x['file size in bytes'];
   }

   function sortIdxDataSizeAsc(x, y) {
      /*
       *  sort by index "dataSize" ascending
       */
      return (x['file size in bytes'] - x['file bytes available for reuse']) - (y['file bytes available for reuse'] - y['file size in bytes']);
   }

   function sortIdxDataSizeDesc(x, y) {
      /*
       *  sort by index "dataSize" descending
       */
      return (y['file size in bytes'] - y['file bytes available for reuse']) - (x['file bytes available for reuse'] - x['file size in bytes']);
   }

   function sortIdxFreeStorageSizeAsc(x, y) {
      /*
       *  sort by index freeStorageSize ascending
       */
      return x['file bytes available for reuse'] - y['file bytes available for reuse'];
   }

   function sortIdxFreeStorageSizeDesc(x, y) {
      /*
       *  sort by index freeStorageSize descending
       */
      return y['file bytes available for reuse'] - x['file bytes available for reuse'];
   }

   function storageSizeAsc(x, y) {
      /*
       *  sort by 'file size in bytes' ascending
       */
      return x.storageSize - y.storageSize;
   }

   function storageSizeDesc(x, y) {
      /*
       *  sort by 'file size in bytes' descending
       */
      return y.storageSize - x.storageSize;
   }

   function sortFreeStorageSizeAsc(x, y) {
      /*
       *  sort by 'file bytes available for reuse' ascending
       */
      return x.freeStorageSize - y.freeStorageSize;
   }

   function sortFreeStorageSizeDesc(x, y) {
      /*
       *  sort by 'file bytes available for reuse' descending
       */
      return y.freeStorageSize - x.freeStorageSize;
   }

   function sortObjectsAsc(x, y) {
      /*
       *  sort by objects/document count ascending
       */
      return x.objects - y.objects;
   }

   function sortObjectsDesc(x, y) {
      /*
       *  sort by objects/document count descending
       */
      return y.objects - x.objects;
   }

   function formatUnit(metric) {
      /*
       *  Pretty format unit
       */
      // return `${+(metric / scale.factor).toFixed(2)} ${scale.unit}`;
      return scaled.format(metric);
   }

   function formatPct(numerator = 0, denominator = 1) {
      /*
       *  Pretty format percentage
       */
      return `${+((numerator / denominator) * 100).toFixed(1)}%`;
   }

   function formatRatio(metric) {
      /*
       *  Pretty format ratio
       */
      return `${+metric.toFixed(2)}:1`;
   }

   function printCollHeader(collTotal = 0) {
      /*
       *  Print collection table header
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32mCollections (visible):\x1b[0m${' '.repeat(1)}${collTotal}`);

      return;
   }

   function printCollection({ name, dataSize, compression, compressor, storageSize, freeStorageSize, objects } = {}) {
      /*
       *  Print collection level stats
       */
      compressor = (compressor == 'snappy') ? 'snpy' : compressor;
      let collWidth = rowHeader - 3;
      let compaction = (name == 'oplog.rs' && compactionHelper('collection', storageSize, freeStorageSize)) ? 'wait'
                     : compactionHelper('collection', storageSize, freeStorageSize) ? 'compact'
                     : '-';
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      if (name.length > 45) name = `${name.substring(0, collWidth)}~`;
      console.log(`└\x1b[36m${(' ' + name).padEnd(rowHeader - 1)}\x1b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${(formatRatio(compression) + (compressor).padStart(compressor.length + 1)).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} \x1b[36m${compaction.padStart(columnWidth - 2)}\x1b[0m`);

      return;
   }

   function printViewHeader(viewTotal = 0) {
      /*
       *  Print view table header
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32mViews (visible):\x1b[0m${' '.repeat(7)}${viewTotal}`);

      return;
   }

   function printView(viewName = 'unknown') {
      /*
       *  Print view name
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(` \x1b[36m${viewName}\x1b[0m`);

      return;
   }

   function printIndex({ name, 'file size in bytes': storageSize, 'file bytes available for reuse': freeStorageSize } = {}) {
      /*
       *  Print index level stats
       */
      let indexWidth = rowHeader + columnWidth * 2;
      let compaction = (name == '_id_' && compactionHelper('index', storageSize, freeStorageSize)) ? 'compact()'
                     : compactionHelper('index', storageSize, freeStorageSize) ? 'rebuild'
                     : '';
      console.log(`  \x1b[33m${'━'.repeat(termWidth - 2)}\x1b[0m`);
      if (name.length > 64) name = `${name.substring(0, indexWidth)}~`;
      console.log(`   \x1b[31m${name.padEnd(indexWidth)}\x1b[0m ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${''.toString().padStart(columnWidth)} \x1b[36m${compaction.padStart(columnWidth - 2)}\x1b[0m`);

      return;
   }

   function printDbHeader({ name } = {}) {
      /*
       *  Print DB table header
       */
      console.log('\n');
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32m${`Database:\x1b[0m \x1b[36m${name}`.padEnd(rowHeader + 9)}\x1b[0m \x1b[1;32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks | reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Compaction'.padStart(columnWidth - 1)}\x1b[0m`);

      return;
   }

   function printDb({
         dataSize, compression, storageSize, freeStorageSize, objects, ncollections, nindexes, totalIndexSize, totalIndexBytesReusable
      }) {
      /*
       *  Print DB level rollup stats
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32m${`Namespaces subtotal:\x1b[0m   ${ncollections}`.padEnd(rowHeader + 5)}${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize).padStart(columnWidth) + ' |' + `${formatPct(freeStorageSize, storageSize)}`.padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${''.padStart(columnWidth - 2)}`);
      console.log(`\x1b[1;32m${`Indexes subtotal:\x1b[0m      ${nindexes}`.padEnd(rowHeader + 5)}${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(totalIndexSize).padStart(columnWidth)} ${`${formatUnit(totalIndexBytesReusable).padStart(columnWidth)} |${`${formatPct(totalIndexBytesReusable, totalIndexSize)}`.padStart(6)}`.padStart(columnWidth + 8)}`);
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);

      return;
   }

   function printDbPath({
         dbPath, proc, hostname, compression, dataSize, storageSize, freeStorageSize, objects, ncollections, nindexes, totalIndexSize, totalIndexBytesReusable
      }) {
      /*
       *  Print total dbPath rollup stats
       */
      let compaction = compactionHelper('dbPath', storageSize + totalIndexSize, freeStorageSize + totalIndexBytesReusable) ? 'resync' : '';
      console.log('\n');
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32m${'dbPath totals'.padEnd(rowHeader)} ${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks | reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Compaction'.padStart(columnWidth - 1)}\x1b[0m`);
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32m${`All namespaces:\x1b[0m        ${ncollections}`.padEnd(rowHeader + 5)}${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} \x1b[36m${compaction.padStart(columnWidth - 2)}\x1b[0m`);
      console.log(`\x1b[1;32m${`All indexes:\x1b[0m           ${nindexes}`.padEnd(rowHeader + 5)}${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(totalIndexSize).padStart(columnWidth)} ${(formatUnit(totalIndexBytesReusable) + ' |' + (formatPct(totalIndexBytesReusable, totalIndexSize)).padStart(6)).padStart(columnWidth + 8)}`);
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32mHost:\x1b[0m \x1b[36m${hostname}\x1b[0m   \x1b[1;32mType:\x1b[0m \x1b[36m${proc}\x1b[0m   \x1b[1;32mVersion:\x1b[0m \x1b[36m${db.version()}\x1b[0m   \x1b[1;32mdbPath:\x1b[0m \x1b[36m${dbPath}\x1b[0m`);
      // console.log(`\x1b[1;32mShards:\x1b[0m ${shards}`);
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log('\n');

      return;
   }

   await main();
})();

// EOF
