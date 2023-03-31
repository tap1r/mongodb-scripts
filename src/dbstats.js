/*
 *  Name: "dbstats.js"
 *  Version: "0.4.0"
 *  Description: DB storage stats uber script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet dbstats.js"

(() => {
   /*
    *  Ensure authorized users have the following minimum required roles
    *  clusterMonitor@admin and readAnyDatabase@admin
    */
   let { 'authInfo': { authenticatedUsers, authenticatedUserRoles } } = db.adminCommand({ "connectionStatus": 1 }),
      adminRoles = ['clusterAdmin', 'atlasAdmin', 'backup', 'root', '__system'];
      authzRoles = ['readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase'],
      adminRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => role == adminRoles.includes(role) && authDb == 'admin'),
      monitorRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => authDb == role == 'clusterMonitor' && authDb == 'admin'),
      dbRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => authzRoles.includes(role) && authDb == 'admin');
   if (!(!(!!authenticatedUsers.length) || !!adminRoles.length || !!monitorRoles.length && !!dbRoles.length))
      print('\u001b[31mWARN: authz privileges may be inadequate and results may vary\u001b[0m');
      print('\u001b[31mWARN: consider inheriting built-in roles \u001b[33mclusterMonitor@admin\u001b[31m and \u001b[33mreadAnyDatabase@admin\u001b[0m');
})();

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(async() => {
   let __script = { "name": "dbstats.js", "version": "0.4.0" },
      __comment = `\n Running script ${__script.name} v${__script.version}`;
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
         __lib.paths = [_getEnv('MDBLIB'), _getEnv('HOME') + '/.mongodb', '.'];
         __lib.path = __lib.paths.find(path => fileExists(path + '/' + __lib.name)) + '/' + __lib.name;
      } else if (typeof process !== 'undefined') { // mongosh process.env[] method
         __lib.paths = [process.env.MDBLIB, process.env.HOME + '/.mongodb', '.'];
         __lib.path = __lib.paths.find(path => fs.existsSync(path + '/' + __lib.name)) + '/' + __lib.name;
      } else {
         print(`[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
   }
   __comment += ` with ${__lib.name} v${__lib.version}`;
   console.clear();
   console.log(`\u001b[32m${__comment}\u001b[0m`);

   /*
    *  User defined parameters
    */

   // Set scaler unit B, KB, MB, GB, TB, PB, EB, ZB, YB
   typeof scale === 'undefined' && (scale = new ScaleFactor('MB'));

   /*
    *  Global defaults
    */

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 124);
   typeof columnWidth === 'undefined' && (columnWidth = 14);
   typeof rowHeader === 'undefined' && (rowHeader = 40);

   // connection preferences
   typeof readPref === 'undefined' && (readPref = (hello().secondary == false) ? 'primaryPreferred' : 'secondaryPreferred');

   async function main() {
      /*
       *  main
       */
      slaveOk(readPref);
      printDbPath(await getStats());
   }

   async function getStats() {
      /*
       *  Gather DB stats (and print)
       */
      let dbPath = new MetaStats();
      dbPath.init();
      // db.getMongo().getDBNames().map(async dbName => {
      db.getMongo().getDBNames().map(dbName => {
         let dbStats = db.getSiblingDB(dbName).stats({ "freeStorage": 1, "scale": 1 }); // max precision due to SERVER-69036
         if (typeof dbStats.raw !== 'undefined') {
            dbStats.db = dbStats.raw[db.getSiblingDB('config').getCollection('shards').findOne().host].db;
         }
         let database = new MetaStats(dbStats.db, dbStats.dataSize, dbStats.storageSize, dbStats.objects, 0, '', dbStats.indexSize);
         database.init();
         printDbHeader(database.name);
         let collections = db.getSiblingDB(dbName).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": /(?:^(?!(system\..+|replset\..+)$).+)/
            }, true, true
         );
         printCollHeader(collections.length);
         // collections.map(async collInfo => {
         collections.map(({ 'name': collName }) => {
            // let collStats = db.getSiblingDB(dbName).getCollection(collName).stats({ "scale": 1, "indexDetails": true });
            let collStats = $collStats(dbName, collName);
            // let compressor = collStats.wiredTiger.creationString.match(/block_compressor=(\w+)/);
            let compressor = collStats.compressor;
            let collection = new MetaStats(
               collName, collStats.size, collStats.wiredTiger['block-manager']['file size in bytes'],
               collStats.count, collStats.wiredTiger['block-manager']['file bytes available for reuse'],
               // collStats.wiredTiger.creationString.match(/block_compressor=(?<compressor>\w+)/)?.groups?.compressor
               (compressor != null) ? compressor[1] : 'none'
            );
            collection.init();
            // Object.keys(collStats.indexDetails).map(indexName => {
            //    collection.indexFree += collStats.indexDetails[indexName]['block-manager']['file bytes available for reuse'];
            //    collection.indexSize += collStats.indexDetails[indexName]['block-manager']['file size in bytes'];
            // });
            collection.indexFree = collStats.indexes.totalIndexBytesReusable;
            collection.indexSize = collStats.indexes.totalIndexSize;
            printCollection(collection);
            database.blocksFree += collection.blocksFree;
            database.indexFree += collection.indexFree;
         });
         let views = db.getSiblingDB(dbName).getCollectionInfos({
            "type": "view",
            // "name": /(?:^(?!(system\..+|replset\..+)$).+)/
         }, true, true
      );
         printViewHeader(views.length);
         views.map(({ name }) => printView(name));
         printDb(database);
         dbPath.dataSize += database.dataSize;
         dbPath.storageSize += database.storageSize;
         dbPath.objects += database.objects;
         dbPath.indexSize += database.indexSize;
         dbPath.indexFree += database.indexFree;
         dbPath.blocksFree += database.blocksFree;
      });

      return dbPath;
   }

   function formatUnit(metric) {
      /*
       *  Pretty format unit
       */
      return `${(metric / scale.factor).toFixed(scale.precision)} ${scale.unit}`;
   }

   function formatPct(numerator, denominator) {
      /*
       *  Pretty format percentage
       */
      return `${(100 * numerator / denominator).toFixed(scale.pctPoint)}%`;
   }

   function formatRatio(metric) {
      /*
       *  Pretty format ratio
       */
      return `${metric.toFixed(scale.precision)}:1`;
   }

   function printCollHeader(collTotal = 0) {
      /*
       *  Print collection table header
       */
      // console.log('-'.repeat(termWidth));
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      // console.log(`Collections:\t${collTotal}`.padEnd(rowHeader));
      console.log(`\u001b[35mCollections:\u001b[0m${collTotal.toString().padStart(2)}`);
   }

   function printCollection({ name, dataSize, compression, compressor = 'none', storageSize, blocksFree, objects }) {
      /*
       *  Print collection level stats
       */
      // console.log(` ${'-'.repeat(termWidth - 1)}`);
      console.log(` \u001b[33m${'-'.repeat(termWidth - 1)}\u001b[0m`);
      // console.log(`\u001b[34m${(' ' + name).padEnd(rowHeader)}\u001b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${(formatRatio(compression) + (compressor).padStart(7)).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(blocksFree) + ('(' + formatPct(blocksFree, storageSize) + ')').padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)}`);
      console.log(`\u001b[34m${(' ' + name).padEnd(rowHeader)}\u001b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${(formatRatio(compression) + (compressor).padStart(compressor.length + 1)).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(blocksFree) + ('(' + formatPct(blocksFree, storageSize) + ')').padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)}`);
   }

   function printViewHeader(viewTotal = 0) {
      /*
       *  Print view table header
       */
      // console.log('-'.repeat(termWidth));
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[35mViews:\u001b[0m${viewTotal.toString().padStart(8)}`);
   }

   function printView(viewName) {
      /*
       *  Print view name
       */
      // console.log('-'.repeat(termWidth));
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(` \u001b[34m${viewName.padEnd(rowHeader)}\u001b[0m`);
   }

   function printDbHeader(dbName) {
      /*
       *  Print DB table header
       */
      console.log(`\n`);
      // console.log('='.repeat(termWidth));
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[35m${`Database:\u001b[0m \u001b[34m${dbName}`.padEnd(rowHeader + 9)}\u001b[0m \u001b[35m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks (reuse)'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}\u001b[0m`);
   }

   function printDb({
         dataSize, compression, storageSize, blocksFree, objects, indexSize, indexFree
      }) {
      /*
       *  Print DB level rollup stats
       */
      // console.log('-'.repeat(termWidth));
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[35m${'Collections subtotal:'.padEnd(rowHeader)}\u001b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(blocksFree).padStart(columnWidth) + `(${formatPct(blocksFree, storageSize)})`.padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)}`);
      console.log(`\u001b[35m${'Indexes subtotal:'.padEnd(rowHeader)}\u001b[0m ${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(indexSize).padStart(columnWidth)} ${`${formatUnit(indexFree).padStart(columnWidth)}${`(${formatPct(indexFree, indexSize)})`.padStart(8)}`.padStart(columnWidth + 8)}`);
      // console.log('='.repeat(termWidth));
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
   }

   function printDbPath({
         dbPath, proc, hostname, dataSize, storageSize, blocksFree, compression, objects, indexSize, indexFree
      }) {
      /*
       *  Print total dbPath rollup stats
       */
      console.log(`\n`);
      // console.log('='.repeat(termWidth));
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[35m${'dbPath totals'.padEnd(rowHeader)} ${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks (reuse)'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}\u001b[0m`);
      // console.log('-'.repeat(termWidth));
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[35m${'All DBs:'.padEnd(rowHeader)}\u001b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(blocksFree) + ('(' + formatPct(blocksFree, storageSize) + ')').padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)}`);
      console.log(`\u001b[35m${'All indexes:'.padEnd(rowHeader)}\u001b[0m ${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(indexSize).padStart(columnWidth)} ${(formatUnit(indexFree) + ('(' + formatPct(indexFree, indexSize) + ')').padStart(8)).padStart(columnWidth + 8)}`);
      // console.log('='.repeat(termWidth));
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[35mHost:\u001b[0m ${hostname}\t\u001b[35mType:\u001b[0m ${proc}\t\u001b[35mdbPath:\u001b[0m ${dbPath}`);
      // console.log('='.repeat(termWidth));
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\n`);
   }

   await main();
})();

// EOF
