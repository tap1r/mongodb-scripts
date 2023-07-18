/*
 *  Name: "dbstats.js"
 *  Version: "0.5.2"
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
   }
   let { 'authInfo': { authenticatedUsers, authenticatedUserRoles } } = db.adminCommand({ "connectionStatus": 1 }),
      adminRoles = ['clusterAdmin', 'atlasAdmin', 'backup', 'root', '__system'];
      authzRoles = ['readAnyDatabase', 'readWriteAnyDatabase', 'dbAdminAnyDatabase'],
      adminRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => role == adminRoles.includes(role) && authDb == 'admin'),
      monitorRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => authDb == role == 'clusterMonitor' && authDb == 'admin'),
      dbRoles = authenticatedUserRoles.filter(({ role, 'db': authDb }) => authzRoles.includes(role) && authDb == 'admin');
   if (!(!(!!authenticatedUsers.length) || !!adminRoles.length || !!monitorRoles.length && !!dbRoles.length)) {
      print('\u001b[31m[WARN] authz privileges may be inadequate and results may vary\u001b[0m');
      print('\u001b[31m[WARN] consider inheriting built-in roles \u001b[33mclusterMonitor@admin\u001b[31m and \u001b[33mreadAnyDatabase@admin\u001b[0m');
   }
})();

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(async() => {
   let __script = { "name": "dbstats.js", "version": "0.5.2" };
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
         print(`\u001b[31m[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory\u001b[0m`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
   }
   let __comment = `\n Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.clear();
   console.log(`\u001b[32m${__comment}\u001b[0m`);
   if (shellVer() < serverVer() && typeof process === 'undefined') console.log(`\u001b[31m[WARN] Possible incompatible shell version detected: ${shellVer()}\u001b[0m`);
   if (serverVer() < 4.2) console.log(`\u001b[31m[ERROR] Unsupported mongod/s version detected: ${serverVer()}\u001b[0m`);

   /*
    *  User defined parameters
    */

   // scaler unit B, KB, MB, GB, TB, PB, EB, ZB, YB
   let scale = new ScaleFactor('MB');

   /*
    *  Global defaults
    */

   // scaler unit B, KB, MB, GB, TB, PB, EB, ZB, YB
   typeof scale === 'undefined' && (scale = new ScaleFactor('MB'));

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 134);
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
      db.getMongo().getDBNames().map(dbName => {
         let database = new MetaStats($stats(dbName));
         database.init();
         printDbHeader(database);
         let collections = db.getSiblingDB(dbName).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": /(?:^(?!(system\..+|replset\..+)$).+)/
            }, true, true
         );
         //
         printCollHeader(collections.length);
         collections.map(({ 'name': collName }) => {
            let collection = new MetaStats($collStats(dbName, collName));
            collection.init();
            printCollection(collection);
            collection.indexes.forEach(printIndex);
            database.freeStorageSize += collection.freeStorageSize;
            database.totalIndexBytesReusable += collection.totalIndexBytesReusable;
         });
         //
         let views = db.getSiblingDB(dbName).getCollectionInfos({
               "type": "view",
               // "name": /(?:^(?!(system\..+|replset\..+)$).+)/
            }, true, true
         );
         printViewHeader(views.length);
         views.map(({ name }) => printView(name));
         //
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
      return `${Math.round((metric / scale.factor) * 100) / 100} ${scale.unit}`;
   }

   function formatPct(numerator = 0, denominator = 1) {
      /*
       *  Pretty format percentage
       */
      return `${Math.round((numerator / denominator) * 1000) / 10}%`;
   }

   function formatRatio(metric) {
      /*
       *  Pretty format ratio
       */
      return `${Math.round(metric * 100) / 100}:1`;
   }

   function printCollHeader(collTotal = 0) {
      /*
       *  Print collection table header
       */
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32mCollections (visible):\u001b[0m${' '.repeat(1)}${collTotal}`);
   }

   function printCollection({ name, dataSize, compression, compressor, storageSize, freeStorageSize, objects, orphans }) {
      /*
       *  Print collection level stats
       */
      console.log(` \u001b[33m${'-'.repeat(termWidth - 1)}\u001b[0m`);
      console.log(`\u001b[36m${(' ' + name).padEnd(rowHeader)}\u001b[0m ${formatUnit(dataSize).padStart(columnWidth)} ${(formatRatio(compression) + (compressor).padStart(compressor.length + 1)).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ('(' + formatPct(freeStorageSize, storageSize) + ')').padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${orphans.toString().padStart(columnWidth - 5)}`);
   }

   function printViewHeader(viewTotal = 0) {
      /*
       *  Print view table header
       */
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32mViews (visible):\u001b[0m${' '.repeat(7)}${viewTotal}`);
   }

   function printView(viewName = 'unknown') {
      /*
       *  Print view name
       */
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(` \u001b[36m${viewName}\u001b[0m`);
   }

   function printIndex({ name, 'file size in bytes': storageSize, 'file bytes available for reuse': freeStorageSize } = {}) {
      /*
       *  Print index level stats
       */
      console.log(`  \u001b[33m${'-'.repeat(termWidth - 2)}\u001b[0m`);
      console.log(`  \u001b[31m${name.padEnd(rowHeader + 1 + columnWidth * 2)}\u001b[0m ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ('(' + formatPct(freeStorageSize, storageSize) + ')').padStart(8)).padStart(columnWidth + 8)}`);
   }

   function printDbHeader({ name } = {}) {
      /*
       *  Print DB table header
       */
      console.log(`\n`);
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32m${`Database:\u001b[0m \u001b[36m${name}`.padEnd(rowHeader + 9)}\u001b[0m \u001b[1m\u001b[32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks (reuse)'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Orphans'.padStart(columnWidth - 4)}\u001b[0m`);
   }

   function printDb({
         dataSize, compression, storageSize, freeStorageSize, objects, orphans, ncollections, nindexes, totalIndexSize, totalIndexBytesReusable
      }) {
      /*
       *  Print DB level rollup stats
       */
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32m${`Namespaces subtotal:\u001b[0m   ${ncollections}`.padEnd(rowHeader + 5)}${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize).padStart(columnWidth) + `(${formatPct(freeStorageSize, storageSize)})`.padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${orphans.toString().padStart(columnWidth - 5)}`);
      console.log(`\u001b[1m\u001b[32m${`Indexes subtotal:\u001b[0m      ${nindexes}`.padEnd(rowHeader + 5)}${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(totalIndexSize).padStart(columnWidth)} ${`${formatUnit(totalIndexBytesReusable).padStart(columnWidth)}${`(${formatPct(totalIndexBytesReusable, totalIndexSize)})`.padStart(8)}`.padStart(columnWidth + 8)}`);
      // console.log(`\u001b[1m\u001b[32mShards:\u001b[0m ${shards}`);
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
   }

   function printDbPath({
         dbPath, proc, hostname, compression, dataSize, storageSize, freeStorageSize, objects, orphans, ncollections, nindexes, totalIndexSize, totalIndexBytesReusable
      }) {
      /*
       *  Print total dbPath rollup stats
       */
      console.log(`\n`);
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32m${'dbPath totals'.padEnd(rowHeader)} \u001b[32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks (reuse)'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Orphans'.padStart(columnWidth - 4)}\u001b[0m`);
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32m${`All namespaces:\u001b[0m        ${ncollections}`.padEnd(rowHeader + 5)}${formatUnit(dataSize).padStart(columnWidth)} ${formatRatio(compression).padStart(columnWidth + 1)} ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ('(' + formatPct(freeStorageSize, storageSize) + ')').padStart(8)).padStart(columnWidth + 8)} ${objects.toString().padStart(columnWidth)} ${orphans.toString().padStart(columnWidth - 5)}`);
      console.log(`\u001b[1m\u001b[32m${`All indexes:\u001b[0m           ${nindexes}`.padEnd(rowHeader + 5)}${''.padStart(columnWidth)} ${''.padStart(columnWidth + 1)} ${formatUnit(totalIndexSize).padStart(columnWidth)} ${(formatUnit(totalIndexBytesReusable) + ('(' + formatPct(totalIndexBytesReusable, totalIndexSize) + ')').padStart(8)).padStart(columnWidth + 8)}`);
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\u001b[1m\u001b[32mHost:\u001b[0m \u001b[36m${hostname}\u001b[0m\t\u001b[1m\u001b[32mType:\u001b[0m \u001b[36m${proc}\u001b[0m\t\u001b[1m\u001b[32mVersion:\u001b[0m \u001b[36m${db.version()}\u001b[0m\t\u001b[1m\u001b[32mdbPath:\u001b[0m \u001b[36m${dbPath}\u001b[0m`);
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`\n`);
   }

   await main();
})();

// EOF
