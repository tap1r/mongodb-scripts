/*
 *  Name: "oplogchurn.js"
 *  Version: "0.3.7"
 *  Description: measure oplog churn rate script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet oplogchurn.js"

/*
 *  User defined parameters
 */

// let intervalHrs = 1; // set interval in hours
// let scale = new ScaleFactor('MB'); // B, KB, MB, GB, TB, PB, EB, ZB, YB

(() => {
   /*
    *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
    *  Save libs to the $MDBLIB or valid search path
    */

   let __script = { "name": "oplogchurn.js", "version": "0.3.7" };
   let __comment = `\n Running script ${__script.name} v${__script.version}`;
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
    *  Global defaults
    */

   // set interval in hours
   typeof intervalHrs === 'undefined' && !!(intervalHrs = 1);

   if (typeof scale === 'undefined') {
      // B, KB, MB, GB, TB, PB, EB, ZB, YB
      ({ unit, factor } = new ScaleFactor('MB'));
   }

   // formatting preferences
   typeof termWidth === 'undefined' && !!(termWidth = 62);
   typeof columnWidth === 'undefined' && !!(columnWidth = 25);
   typeof rowHeader === 'undefined' && !!(rowHeader = 36);

   // connection preferences
   (typeof readPref === 'undefined') && !!(readPref = (hello().secondary == false) ? 'primaryPreferred' : 'secondaryPreferred');

   function main() {
      /*
       *  main
       */
      let opSize = 0, docs = 0, date = new Date();
      let t2 = Math.floor(date.getTime() / 1000.0), // end timestamp
         d2 = date.toISOString(), // end datetime
         t1 = Math.floor(date.setHours(date.getHours() - intervalHrs) / 1000.0), // start timestamp
         d1 = date.toISOString(), // start datetime
         $match = (typeof process !== 'undefined') // MONGOSH-930
                ? { "$match": {
                     "ts": {
                        "$gt": Timestamp({ "t": t1, "i": 0 }),
                        "$lte": Timestamp({ "t": t2, "i": 0 })
                  } } }
                : { "$match": {
                     "ts": {
                        "$gt": Timestamp(t1, 0),
                        "$lte": Timestamp(t2, 0)
                  } } },
         $project = serverVer(4.2)
                  ? { "$unset": "_id" }
                  : { "$addFields": { "_id": "$$REMOVE" } };
      let pipeline = [$match, $project],
         options = {
            "allowDiskUse": true,
            "cursor": { "batchSize": 0 },
            "comment": `Performing oplog churn analysis with ${__script.name} v${__script.version}`
         };

      // Measure interval statistics
      slaveOk(readPref); // not supported on shared tiers
      let oplog = db.getSiblingDB('local').getCollection('oplog.rs');

      if (serverVer(4.4)) {
         // Using the v4.4+ $bsonSize aggregation operator
         pipeline.push({
            "$group": {
               "_id": null,
               "_bsonDataSize": { "$sum": { "$bsonSize": "$$ROOT" } },
               "_documentCount": { "$sum": 1 }
         } });
         ({ '_bsonDataSize': opSize, '_documentCount': docs } = oplog.aggregate(pipeline, options).toArray()[0]);
      } else {
         console.log('\nWarning: Using the legacy client side calculation technique');
         oplog.aggregate(pipeline, options).forEach(op => {
            opSize += bsonsize(op);
            ++docs;
         });
      }

      // Get host info
      let { 'system': { hostname } } = db.hostInfo(),
         { 'parsed': { 'storage': { dbPath } } } = db.serverCmdLineOpts(),
         // Get oplog stats
         { 'wiredTiger': {
            creationString,
            'block-manager': {
               'file bytes available for reuse': blocksFree,
               'file size in bytes': storageSize,
            } },
            size,
            internalPageSize = (creationString.match(/internal_page_max=(\d+)/)[1] * 1024)
         } = oplog.stats();
      let overhead = internalPageSize;
      let ratio = +((size / (storageSize - blocksFree - overhead)).toFixed(2)),
         intervalDataSize = opSize / factor;
      let intervalStorageSize = intervalDataSize / ratio;
      let oplogChurn = intervalStorageSize / intervalHrs;

      // Print results
      console.log(`\n\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log(`Hostname: ${hostname.padStart(termWidth - 'Hostname: '.length)}`);
      console.log(`dbPath: ${dbPath.padStart(termWidth - 'dbPath: '.length)}`);
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`${'Start time:'.padEnd(rowHeader)} ${d1.padStart(columnWidth)}`);
      console.log(`${'End time:'.padEnd(rowHeader)} ${d2.padStart(columnWidth)}`);
      console.log(`${'Interval duration:'.padEnd(rowHeader)} ${`${intervalHrs} hr${(intervalHrs == 1) ? '' : 's'}`.padStart(columnWidth)}`);
      console.log(`${'Average oplog compression ratio:'.padEnd(rowHeader)} ${`${ratio}:1`.padStart(columnWidth)}`);
      console.log(`${'Interval document count:'.padEnd(rowHeader)} ${docs.toString().padStart(columnWidth)}`);
      console.log(`${'Interval data size:'.padEnd(rowHeader)} ${`${intervalDataSize.toFixed(2)} ${unit}`.padStart(columnWidth)}`);
      console.log(`${'Estimated interval storage size:'.padEnd(rowHeader)} ${`${intervalStorageSize.toFixed(2)} ${unit}`.padStart(columnWidth)}`);
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log(`${'Estimated current oplog data churn:'.padEnd(rowHeader)} ${`${oplogChurn.toFixed(2)} ${unit}/hr`.padStart(columnWidth)}`);
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log('\n');
   }

   if (!isReplSet()) {
      console.log(`\n\t\u001b[31mHost is not a replica set member....exiting!\u001b[0m`);
      console.log('\n');
   } else main();
})();

// EOF
