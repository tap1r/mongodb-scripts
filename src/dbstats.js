/*
 *  Name: "dbstats.js"
 *  Version: "0.8.11"
 *  Description: DB storage stats uber script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet dbstats.js"

/*
 *  Examples of using namespace filters:
 *
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbFilter = 'database'" dbstats.js
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbFilter = '^d.+'" dbstats.js
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbFilter = /^d.+/i" dbstats.js
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbFilter = /(^(?!(d.+)).+)/" dbstats.js
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbFilter = 'database', collFilter = 'collection'" dbstats.js
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbFilter = 'database', collFilter = /collection/i" dbstats.js
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
   let __script = { "name": "dbstats.js", "version": "0.8.11" };
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
   // console.clear();
   console.log(`\n\n\x1b[33m${__comment}\x1b[0m`);
   if (shellVer() < serverVer() && typeof process === 'undefined') console.log(`\n\x1b[31m[WARN] Possible incompatible shell version detected: ${shellVer()}\x1b[0m`);
   if (shellVer() < 1.0 && typeof process !== 'undefined') console.log(`\n\x1b[31m[WARN] Possible incompatible non-GA shell version detected: ${shellVer()}\x1b[0m`);
   if (serverVer() < 4.2) console.log(`\n\x1b[31m[ERROR] Unsupported mongod/s version detected: ${serverVer()}\x1b[0m`);

   /*
    *  User defined parameters
    */

   typeof dbFilter === 'undefined' && (dbFilter = /^.+/) || dbFilter;
   typeof collFilter === 'undefined' && (collFilter = /^.+/) || collFilter;

   /*
    *  Global defaults
    */

   // scaler unit B, KiB, MiB, GiB, TiB, PiB
   let scaled = new AutoFactor();

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 137);
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
      let dbNames = getDBNames(dbFilter);
      dbNames.sort((x, y) => x.localeCompare(y)); // ASC
      // dbNames.sort((x, y) => y.localeCompare(x)); // DESC
      dbNames.map(dbName => {
         let database = new MetaStats($stats(dbName));
         database.init();
         printDbHeader(database);
         let systemFilter = /(?:^(?!(system\..+|replset\..+)$).+)/;
         let collections = db.getSiblingDB(dbName).getCollectionInfos({
               "type": /^(collection|timeseries)$/,
               "name": new RegExp(collFilter)
            }, true, true
         ).filter(({ 'name': collName }) => collName.match(systemFilter));
         collections.sort((x, y) => x.name.localeCompare(y.name)); // ASC
         // collections.sort((x, y) => y.name.localeCompare(x.name)); // DESC
         printCollHeader(collections.length);
         collections.map(({ 'name': collName }) => {
            let collection = new MetaStats($collStats(dbName, collName));
            collection.init();
            printCollection(collection);
            collection.indexes.sort((x, y) => x.name.localeCompare(y.name)); // ASC
            // collection.indexes.sort((x, y) => y.name.localeCompare(x.name)); // DESC
            // collection.indexes.sort((x, y) => x['file size in bytes'] - y['file size in bytes']); // ASC
            // collection.indexes.sort((x, y) => y['file size in bytes'] - x['file size in bytes']); // DESC
            // collection.indexes.sort((x, y) => x['file bytes available for reuse'] - y['file bytes available for reuse']); // ASC
            // collection.indexes.sort((x, y) => y['file bytes available for reuse'] - x['file bytes available for reuse']); // DESC
            collection.indexes.forEach(printIndex);
            // database.freeStorageSize += collection.freeStorageSize;
            // database.totalIndexBytesReusable += collection.totalIndexBytesReusable;
         });
         let views = db.getSiblingDB(dbName).getCollectionInfos({
               "type": "view",
               "name": new RegExp(collFilter)
            }, true, true
         );
         views.sort((x, y) => x.name.localeCompare(y.name)); // ASC
         // views.sort((x, y) => y.name.localeCompare(x.name)); // DESC
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
      console.log(`\x1b[1;32mCollections (visible):\x1b[0m${' '.repeat(1)}${collTotal}`);
   }

   function printCollection({ name, dataSize, compression, compressor, storageSize, freeStorageSize, objects }) {
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
   }

   function printViewHeader(viewTotal = 0) {
      /*
       *  Print view table header
       */
      console.log(`\x1b[33m${'━'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32mViews (visible):\x1b[0m${' '.repeat(7)}${viewTotal}`);
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
      let indexWidth = rowHeader + columnWidth * 2;
      let compaction = (name == '_id_' && compactionHelper('index', storageSize, freeStorageSize)) ? 'compact()'
                     : compactionHelper('index', storageSize, freeStorageSize) ? 'rebuild'
                     : '';
      console.log(`  \x1b[33m${'━'.repeat(termWidth - 2)}\x1b[0m`);
      if (name.length > 64) name = `${name.substring(0, indexWidth)}~`;
      console.log(`   \x1b[31m${name.padEnd(indexWidth)}\x1b[0m ${formatUnit(storageSize).padStart(columnWidth)} ${(formatUnit(freeStorageSize) + ' |' + (formatPct(freeStorageSize, storageSize)).padStart(6)).padStart(columnWidth + 8)} ${''.toString().padStart(columnWidth)} \x1b[36m${compaction.padStart(columnWidth - 2)}\x1b[0m`);
   }

   function printDbHeader({ name } = {}) {
      /*
       *  Print DB table header
       */
      console.log('\n');
      console.log(`\x1b[33m${'═'.repeat(termWidth)}\x1b[0m`);
      console.log(`\x1b[1;32m${`Database:\x1b[0m \x1b[36m${name}`.padEnd(rowHeader + 9)}\x1b[0m \x1b[1;32m${'Data size'.padStart(columnWidth)} ${'Compression'.padStart(columnWidth + 1)} ${'Size on disk'.padStart(columnWidth)} ${'Free blocks | reuse'.padStart(columnWidth + 8)} ${'Object count'.padStart(columnWidth)}${'Compaction'.padStart(columnWidth - 1)}\x1b[0m`);
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
   }

   await main();
})();

// EOF
