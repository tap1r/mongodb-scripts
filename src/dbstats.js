/*
 *  Name: "dbstats.js"
 *  Version: "0.7.1"
 *  Description: DB storage stats uber script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet dbstats.js"

(() => {
   /*
    *  Ensure authorized users have the following minimum required roles
    *  clusterMonitor@admin and readAnyDatabase@admin
    */
   try {
      db.adminCommand({ "features": 1 });
   } catch(error) {
      // MongoServerError: command features requires authentication
      print('\x1b[31m[ERR] MongoServerError: features command requires authentication\x1b[0m');
   }
   let { 'authInfo': { authenticatedUsers, authenticatedUserRoles } } = db.adminCommand({ "connectionStatus": 1 }),
      adminRoles = ['clusterAdmin', 'atlasAdmin', 'backup', 'root', '__system'];
      authzRoles = ['readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase'],
      adminRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => role == adminRoles.includes(role) && authDb == 'admin'),
      monitorRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => authDb == role == 'clusterMonitor' && authDb == 'admin'),
      dbRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => authzRoles.includes(role) && authDb == 'admin');
   if (!(!(!!authenticatedUsers.length) || !!adminRoles.length || !!monitorRoles.length && !!dbRoles.length)) {
      print('\x1b[31m[WARN] authz privileges may be inadequate and results may vary\x1b[0m');
      print('\x1b[31m[WARN] consider inheriting built-in roles \x1b[33mclusterMonitor@admin\x1b[31m and \x1b[33mreadAnyDatabase@admin\x1b[0m');
   }
})();

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(async(dbFilter, collFilter) => {
   let __script = { "name": "dbstats.js", "version": "0.7.1" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
         __lib.paths = [_getEnv('MDBLIB'), `${_getEnv('HOME')}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fileExists(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else if (typeof process !== 'undefined') { // mongosh process.env[] method
         __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else {
         print(`\x1b[31m[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory\x1b[0m`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
   }
   let __comment = `# Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.clear();
   console.log(`\n\x1b[33m${__comment}\x1b[0m`);
   if (shellVer() < serverVer() && typeof process === 'undefined') console.log(`\n\x1b[31m[WARN] Possible incompatible shell version detected: ${shellVer()}\x1b[0m`);
   if (shellVer() < 1.0 && typeof process !== 'undefined') console.log(`\n\x1b[31m[WARN] Possible incompatible non-GA shell version detected: ${shellVer()}\x1b[0m`);
   if (serverVer() < 4.2) console.log(`\n\x1b[31m[ERROR] Unsupported mongod/s version detected: ${serverVer()}\x1b[0m`);

   /*
    *  User defined parameters
    */

   // scaler unit B, KiB, MiB, GiB, TiB, PiB
   // let scale = new ScaleFactor('MiB');
   // let scaled = new AutoFactor();

   /*
    *  Global defaults
    */

   // scaler unit B, KiB, MiB, GiB, TiB, PiB
   // typeof scale === 'undefined' && (scale = new ScaleFactor('MiB'));
   typeof scaled === 'undefined' && (scaled = new AutoFactor());

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 134);
   typeof columnWidth === 'undefined' && (columnWidth = 14);
   typeof rowHeader === 'undefined' && (rowHeader = 40);

   // connection preferences
   typeof readPref === 'undefined' && (readPref = (hello().secondary) ? 'secondaryPreferred' : 'primaryPreferred');

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
      getDBNames(dbFilter).map(dbName => {
         let database = new MetaStats($stats(dbName));
         database.init();
         printDbHeader(database);
         let systemFilter = /(?:^(?!(system\..+|replset\..+)$).+)/;
         collFilter = new RegExp(collFilter);
         let collections = db.getSiblingDB(dbName).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": collFilter
            }, true, true
         ).filter(({ 'name': collName }) => collName.match(systemFilter));
         printCollHeader(collections.length);
         collections.map(({ 'name': collName }) => {
            let collection = new MetaStats($collStats(dbName, collName));
            collection.init();
            printCollection(collection);
            collection.indexes.forEach(printIndex);
            database.freeStorageSize += collection.freeStorageSize;
            database.totalIndexBytesReusable += collection.totalIndexBytesReusable;
         });
         let views = db.getSiblingDB(dbName).getCollectionInfos({
               "type": "view",
               // "name": /(?:^(?!(system\..+|replset\..+)$).+)/
               "name": collFilter
            }, true, true
         );
         printViewHeader(views.length);
         views.map(({ name }) => printView(name));
         printDb(database);
         dbPath.ncollections += database.ncollections;
         dbPath.nindexes += database.nindexes;
         dbPath.dataSize += database.dataSize;
         dbPath.storageSize += database.storageSize;
         dbPath.freeStorageSize += database.freeStorageSize;
         dbPath.objects += database.objects;
         dbPath.orphans += database.orphans;
         dbPath.totalIndexSize += database.totalIndexSize;
         dbPath.totalIndexBytesReusable += database.totalIndexBytesReusable;
      });

      return dbPath;
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
      console.log(`\x1b[1m\x1b[32mCollections (visible):\x1b[0m${' '.repeat(1)}${collTotal}`);
   }

   function printCollection({ name, dataSize, compression, compressor, storageSize, freeStorageSize, objects, orphans }) {
      /*
       *  Print collection level stats
       */
      compressor = compressor == 'snappy' ? 'snpy' : compressor;
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`└\x1b[36m${(' ' + name).padEnd(rowHeader - 1)}\x1b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${(formatRatio(compression) + (compressor).padStart(compressor.length + 1)).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${orphans.toString().padStart(columnWidth - 5)}`);
   }

   function printViewHeader(viewTotal = 0) {
      /*
       *  Print view table header
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1m\x1b[32mViews (visible):\x1b[0m${' '.repeat(7)}${viewTotal}`);
   }

   function printView(viewName = 'unknown') {
      /*
       *  Print view name
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(` \x1b[36m${viewName}\x1b[0m`);
   }

   function printIndex({ name, 'file size in bytes': storageSize, 'file bytes available for reuse': freeStorageSize } = {}) {
      /*
       *  Print index level stats
       */
      console.log(`  \x1b[33m${'━'.repeat(termWidth - 2)}\x1b[0m`);
      console.log(`   \x1b[31m${name.padEnd(rowHeader + columnWidth * 2)}\x1b[0m ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)}`);
   }

   function printDbHeader({ name } = {}) {
      /*
       *  Print DB table header
       */
      console.log('\n');
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1m\x1b[32m${`Database:\x1b[0m \x1b[36m${name}`.padEnd(rowHeader + 9)}\x1b[0m \x1b[1m\x1b[32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks | reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Orphans'.padStart(columnWidth - 4)}\x1b[0m`);
   }

   function printDb({
         dataSize, compression, storageSize, freeStorageSize, objects, orphans, ncollections, nindexes, totalIndexSize, totalIndexBytesReusable
      }) {
      /*
       *  Print DB level rollup stats
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1m\x1b[32m${`Namespaces subtotal:\x1b[0m   ${ncollections}`.padEnd(rowHeader + 5)}${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize).padStart(columnWidth) + ' |' + `${formatPct(freeStorageSize, storageSize)}`.padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${orphans.toString().padStart(columnWidth - 5)}`);
      console.log(`\x1b[1m\x1b[32m${`Indexes subtotal:\x1b[0m      ${nindexes}`.padEnd(rowHeader + 5)}${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(totalIndexSize).padStart(columnWidth)} ${`${formatUnit(totalIndexBytesReusable).padStart(columnWidth)} |${`${formatPct(totalIndexBytesReusable, totalIndexSize)}`.padStart(6)}`.padStart(columnWidth + 8)}`);
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
   }

   function printDbPath({
         dbPath, proc, hostname, compression, dataSize, storageSize, freeStorageSize, objects, orphans, ncollections, nindexes, totalIndexSize, totalIndexBytesReusable
      }) {
      /*
       *  Print total dbPath rollup stats
       */
      console.log('\n');
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1m\x1b[32m${'dbPath totals'.padEnd(rowHeader)} \x1b[32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks | reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Orphans'.padStart(columnWidth - 4)}\x1b[0m`);
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1m\x1b[32m${`All namespaces:\x1b[0m        ${ncollections}`.padEnd(rowHeader + 5)}${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${orphans.toString().padStart(columnWidth - 5)}`);
      console.log(`\x1b[1m\x1b[32m${`All indexes:\x1b[0m           ${nindexes}`.padEnd(rowHeader + 5)}${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(totalIndexSize).padStart(columnWidth)} ${(formatUnit(totalIndexBytesReusable) + ' |' + (formatPct(totalIndexBytesReusable, totalIndexSize)).padStart(6)).padStart(columnWidth + 8)}`);
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1m\x1b[32mHost:\x1b[0m \x1b[36m${hostname}\x1b[0m   \x1b[1m\x1b[32mType:\x1b[0m \x1b[36m${proc}\x1b[0m   \x1b[1m\x1b[32mVersion:\x1b[0m \x1b[36m${db.version()}\x1b[0m   \x1b[1m\x1b[32mdbPath:\x1b[0m \x1b[36m${dbPath}\x1b[0m`);
      // console.log(`\x1b[1m\x1b[32mShards:\x1b[0m ${shards}`);
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log('\n');
   }

   await main();
})(
   typeof dbFilter === 'undefined' && (dbFilter = /^.+/) || dbFilter,
   typeof collFilter === 'undefined' && (collFilter = /^.+/) || collFilter
);

// EOF
