/*
 *  Name: "dbstats.js"
 *  Version: "0.11.6"
 *  Description: "DB storage stats uber script"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: [mongo|mongosh] [connection options] --quiet [--eval 'let options = {...};'] [-f|--file] dbstats.js

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
 *     "limit": { // TBA
 *        "dataSize": <int>,
 *        "storageSize": <int>,
 *        "freeStorageSize": <int>,
 *        "reuse": <int>,
 *        "compression": <int>,
 *        "objects": <int>
 *     },
 *     output: {
 *        format: <'table'|'nsTable'|'json'|'html'>,
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
 *    mongosh --quiet --eval 'let options = { filter: { db: "^database$" } };' -f dbstats.js
 *    mongosh --quiet --eval 'let options = { filter: { collection: "^c.+" } };' -f dbstats.js
 *    mongosh --quiet --eval 'let options = { filter: { db: /(^(?!(d.+)).+)/i, collection: /collection/i } };' -f dbstats.js
 *
 *  Examples of using sorting:
 *
 *    mongosh --quiet --eval 'let options = { sort: { collection: { dataSize: -1 }, index: { idxStorageSize: -1 } } };' -f dbstats.js
 *    mongosh --quiet --eval 'let options = { sort: { collection: { freeStorageSize: -1 }, index: { idxFreeStorageSize: -1 } } };' -f dbstats.js
 * 
 *  Examples of using formatting:
 *
 *    mongosh --quiet --eval 'let options = { output: { format: "tabular" } };' -f dbstats.js
 *    mongosh --quiet --eval 'let options = { output: { format: "json" } };' -f dbstats.js
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
   let __script = { "name": "dbstats.js", "version": "0.11.6" };
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

   let optionsDefaults = {
      "filter": {
         "db": new RegExp(/^.+/),
         "collection": new RegExp(/^.+/)
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
         "format": "tabular", // ['tabular'|'nsTable'|'json'|'html']
         "topology": "summary", // ['summary'|'expanded'] // TBA
         "colour": true, // [true|false] // TBA
         "verbosity": "full" // ['full'|'summary'|'summaryIdx'|'compactOnly'] // TBA
      },
      "topology": { // TBA
         "discover": true, // [true|false]
         "replica": 'summary', // ['summary'|'expanded']
         "sharded": 'summary' // ['summary'|'expanded']
      }
   };
   typeof options === 'undefined' && (options = optionsDefaults);
   let filterOptions = { ...optionsDefaults.filter, ...options.filter };
   let sortOptions = { ...optionsDefaults.sort, ...options.sort };
   let outputOptions = { ...optionsDefaults.output, ...options.output };
   let limitOptions = { ...optionsDefaults.limit, ...options.limit };
   let topologyOptions = { ...optionsDefaults.topology, ...options.topology };

   /*
    *  Global defaults
    */

   // scalar unit B, KiB, MiB, GiB, TiB, PiB
   let scaled = new AutoFactor();

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

      slaveOk(readPref);
      let dbStats = await getStats();

      switch (formatOutput) {
         case 'json':
            // jsonOut(dbStats);
            return dbStats;
            // dbStats
            // break;
         case 'html':
            htmlOut(dbStats);
            break;
         case 'nsTable':
            nsTableOut(dbStats);
            break;
         default: // tabular
            tableOut(dbStats);
      }

      return;
   }

   async function getStats() {
      /*
       *  Gather DB stats
       */
      let { 'db': dbFilter, 'collection': collFilter } = filterOptions;
      collFilter = new RegExp(collFilter);
      let systemFilter = /(?:^(?!(system\..+|replset\..+)$).+)/; // required for less privileged users
      // let systemFilter = /(?:^(?!(system\..+|replset\..+)&&(system\.profile|system\.sessions|system\.views)$).+)/;
      // let systemFilter = /.+/;
      let dbPath = new MetaStats();
      dbPath.init();
      delete dbPath.name;
      delete dbPath.collections;
      delete dbPath.views;
      delete dbPath.indexes;
      delete dbPath.compressor;

      let dbNames = (shellVer() >= 2.0 && typeof process !== 'undefined')
         ? getDBNames(dbFilter).toSorted(sortAsc) // mongosh v2 optimised
         : getDBNames(dbFilter).sort(sortAsc);    // legacy shell(s) method
      console.log('\n');
      console.log('Discovered', dbNames.length, 'distinct databases');
      // let dbFetchTasks = dbNames.map(async dbName => {
      dbPath.databases = dbNames.map(dbName => {
         let database = new MetaStats($stats(dbName));
         delete database.databases;
         delete database.instance;
         delete database.hostname;
         delete database.proc;
         delete database.dbPath;
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
      });
      // dbPath.databases = await Promise.all(dbFetchTasks);
      //
      console.log('Discovered', dbPath.ncollections, 'distinct namespaces');
      console.log('Discovered', dbPath.nindexes, 'distinct indexes');
      //
      let collNamesTasks = dbPath.databases.map(async database => {
         database.collections = (shellVer() >= 2.0 && typeof process !== 'undefined')
            ? db.getSiblingDB(database.name).getCollectionInfos({ // mongosh v2 optimised
                  "type": /^(collection|timeseries)$/,
                  "name": collFilter
               },
               { "nameOnly": true }, true
              ).filter(({ 'name': collName }) => collName.match(systemFilter)).toSorted(sortNameAsc)
            : db.getSiblingDB(database.name).getCollectionInfos({ // legacy shell(s) method
                  "type": /^(collection|timeseries)$/,
                  "name": collFilter
               },
               (typeof process !== 'undefined') ? { "nameOnly": true } : true,
               true
              ).filter(({ 'name': collName }) => collName.match(systemFilter)).sort(sortNameAsc);
         //
         database.views = (shellVer() >= 2.0 && typeof process !== 'undefined')
            ? db.getSiblingDB(database.name).getCollectionInfos({ // mongosh v2 optimised
                  "type": "view",
                  "name": collFilter
               },
               { "nameOnly": true }, true
              ).toSorted(sortBy('view'))
            : db.getSiblingDB(database.name).getCollectionInfos({ // legacy shell(s) method
                  "type": "view",
                  "name": collFilter
               },
               (typeof process !== 'undefined') ? { "nameOnly": true } : true,
               true
              ).sort(sortBy('view'));

         return database;
      });
      dbPath.databases = await Promise.all(collNamesTasks);

      let collFetchTasks = dbPath.databases.map(async database => {
         let collFetchTasks = database.collections.map(async({ 'name': collName }) => {
            let collection = await new MetaStats($collStats(database.name, collName));
            delete collection.databases;
            delete collection.collections;
            delete collection.views;
            delete collection.ncollections;
            delete collection.instance;
            delete collection.hostname;
            delete collection.proc;
            delete collection.dbPath;

            collection.indexes.sort(sortBy('index'));

            return collection;
         });
         database.collections = await Promise.all(collFetchTasks);
         database.collections.sort(sortBy('collection'));
         database.views = db.getSiblingDB(database.name).getCollectionInfos({
               "type": "view",
               "name": collFilter
            },
            (typeof process !== 'undefined') ? { "nameOnly": true } : true,
            true
         ).sort(sortBy('view'));

         return database;
      });
      dbPath.databases = await Promise.all(collFetchTasks);
      dbPath.databases.sort(sortBy('db'));

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
      let namespaces = dbStats.databases.flatMap(database => {
         return database.collections.reduce((collections, collection) => {
            let namespace = database.name + '.' + collection.name;
            delete collection.name;
            let updatedCollection = { ...{ "namespace": namespace }, ...collection, ...{ compression: 0 }
            // , ...{ get compression() {
            //    return this.dataSize / (this.storageSize - this.freeStorageSize);
            // } }
            };
            collections.push(updatedCollection);
            return collections;
         }, []);
      }).sort(sortBy('namespace'));

      printNSHeader(namespaces.length);
      namespaces.forEach(namespace => {
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
      console.log('\n');
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

   function sortBy(type) {
      /*
       *  sortBy value
       */
      let sortByType = sortOptions[type];
      let sortKey = Object.keys(sortByType).find(key => sortByType[key] !== 0) || 'name';
      let sortValue = sortByType[sortKey];
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
         "namespace": {
            "asc": sortNamespaceAsc,
            "desc": sortNamespaceDesc
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

   function sortNamespaceAsc(x, y) {
      /*
       *  sort by namespace ascending
       */
      return x.namespace.localeCompare(y.namespace);
   }

   function sortNamespaceDesc(x, y) {
      /*
       *  sort by namespace descending
       */
      return y.namespace.localeCompare(x.namespace);
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
      return x.storageSize - y.storageSize;
   }

   function sortIdxStorageSizeDesc(x, y) {
      /*
       *  sort by index dataSize descending
       */
      return y.storageSize - x.storageSize;
   }

   function sortIdxDataSizeAsc(x, y) {
      /*
       *  sort by index "dataSize" ascending
       */
      return x.storageSize - x.freeStorageSize - y.storageSize - y.freeStorageSize;
   }

   function sortIdxDataSizeDesc(x, y) {
      /*
       *  sort by index "dataSize" descending
       */
      return y.storageSize - y.freeStorageSize - x.storageSize - x.freeStorageSize;
   }

   function sortIdxFreeStorageSizeAsc(x, y) {
      /*
       *  sort by index freeStorageSize ascending
       */
      return x.freeStorageSize - y.freeStorageSize;
   }

   function sortIdxFreeStorageSizeDesc(x, y) {
      /*
       *  sort by index freeStorageSize descending
       */
      return y.freeStorageSize - x.freeStorageSize;
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
      return scaled.format(metric);
   }

   function formatPct(numerator = 0, denominator = 1) {
      /*
       *  Pretty format percentage
       */
      return `${Number.parseFloat(((numerator / denominator) * 100).toFixed(1))}%`;
   }

   function formatRatio(metric) {
      /*
       *  Pretty format ratio
       */
      return `${Number.parseFloat(metric.toFixed(2))}:1`;
   }

   function printCollHeader(collTotal = 0) {
      /*
       *  Print collection table header
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32mCollections (visible):\x1b[0m${' '.repeat(1)}${collTotal}`);

      return;
   }

   function printNSHeader(nsTotal = 0) {
      /*
       *  Print namespace table header
       */
      console.log('\n');
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32m${`Namespaces (visible):\x1b[0m${' '.repeat(1)}${nsTotal}`.padEnd(rowHeader + 4)}\x1b[0m \x1b[1;32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks | reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Compaction'.padStart(columnWidth - 1)}\x1b[0m`);

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

   function printNamespace({ namespace, dataSize, compression, compressor, storageSize, freeStorageSize, objects } = {}) {
      /*
       *  Print namespace level stats
       */
      compressor = (compressor == 'snappy') ? 'snpy' : compressor;
      let collWidth = rowHeader - 3;
      let compaction = (namespace == 'local.oplog.rs' && compactionHelper('collection', storageSize, freeStorageSize)) ? 'wait'
                     : compactionHelper('collection', storageSize, freeStorageSize) ? 'compact'
                     : '-';
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      if (namespace.length > 45) namespace = `${namespace.substring(0, collWidth)}~`;
      console.log(`└\x1b[36m${(' ' + namespace).padEnd(rowHeader - 1)}\x1b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${(formatRatio(compression) + (compressor).padStart(compressor.length + 1)).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} \x1b[36m${compaction.padStart(columnWidth - 2)}\x1b[0m`);

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

   function printIndex({ name, storageSize, freeStorageSize } = {}) {
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
      } = {}) {
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
      } = {}) {
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

   dbStats = await main();
   // return dbStats;
})(dbStats = {});

// EOF
