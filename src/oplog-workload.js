/*
 *  Name: "oplog-workload.js"
 *  Version: "0.1.9"
 *  Description: oplog "workload" analysis script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet oplog-workload.js"

(() => {
   /*
    *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
    *  Save libs to the $MDBLIB or valid search path
    */
   let __script = { "name": "oplog-workload.js", "version": "0.1.9" };
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
         print(`\u001b[31m[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory\u001b[0m`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
   }
   let __comment = `# Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.clear();
   console.log(`\n\u001b[33m${__comment}\u001b[0m`);

   /*
    *  User defined parameters
    */

   if (typeof hrs === 'undefined') {
      // set interval in hours
      (hrs = 1);
   }

   if (typeof scale === 'undefined') {
      // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
      ({ unit, factor } = new ScaleFactor('MB'));
   }

   /*
    *  Global defaults
    */

   // formatting preferences
   if (typeof termWidth === 'undefined') (termWidth = 80);
   if (typeof columnWidth === 'undefined') (columnWidth = 45);
   if (typeof rowHeader === 'undefined') (rowHeader = 34);

   if (typeof readPref === 'undefined') (readPref = (hello().secondary == false) ? 'primaryPreferred' : 'secondaryPreferred');

   function main() {
      /*
       *  main
       */
      let size = 0,
         docs = 0,
         date = new Date(),
         t2 = (date.getTime() / 1000.0)|0, // end timestamp
         d2 = date.toISOString(), // end datetime
         t1 = (date.setHours(date.getHours() - hrs) / 1000.0)|0, // start timestamp
         d1 = date.toISOString(), // start datetime
         $match = (typeof process !== 'undefined') // MONGOSH-930
                ? { "$match": { "ts": {
                     "$gt": Timestamp({ "t": t1, "i": 0 }),
                     "$lte": Timestamp({ "t": t2, "i": 0 })
                  } } }
                : { "$match": { "ts": {
                     "$gt": Timestamp(t1, 0),
                     "$lte": Timestamp(t2, 0)
                  } } },
         $project = serverVer(4.2)
                  ? { "$unset": "_id" }
                  : { "$addFields": { "_id": "$$REMOVE" } },
         pipeline = [$match, $project],
         options = {
            "allowDiskUse": true,
            "cursor": { "batchSize": 0 },
            "comment": `Performing oplog analysis with ${__comment}`
         };

      // Measure interval statistics
      db.getMongo().setReadPref(readPref);
      let oplog = db.getSiblingDB('local').getCollection('oplog.rs');

      if (serverVer(4.4)) {
         // Using the v4.4 $bsonSize aggregation operator
         pipeline.push({
            "$group": {
               "_id": null,
               "__bsonDataSize": { "$sum": { "$bsonSize": "$$ROOT" } },
               "__documentCount": { "$sum": 1 }
            }
         });
         // console.log(pipeline);
         ({ '__bsonDataSize': size, '__documentCount': docs } = oplog.aggregate(pipeline, options).toArray()[0]);
      } else {
         console.log('\n');
         console.log('\u001b[31m[WARN] Using the legacy client side calculation technique\u001b[0m');
         oplog.aggregate(pipeline, options).forEach(op => {
            size += bsonsize(op);
            ++docs;
         });
      }

      // Get host info
      let host = db.hostInfo().system.hostname,
         dbPath = db.serverCmdLineOpts().parsed.storage.dbPath,
         // Get oplog stats
         stats = oplog.stats(),
         blocksFree = stats.wiredTiger['block-manager']['file bytes available for reuse'],
         ratio = +((stats.size / (stats.storageSize - blocksFree)).toFixed(2)),
         intervalDataSize = size / factor,
         intervalStorageSize = size / (factor * ratio),
         oplogChurn = size / (factor * ratio * hrs);

      // Print results
      console.log(`\n\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log('Host:'.padEnd(rowHeader), host.padStart(columnWidth));
      console.log(`dbPath: ${dbPath.padStart(termWidth - 'dbPath: '.length)}`);
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log('Start time:'.padEnd(rowHeader), d1.padStart(columnWidth));
      console.log('End time:'.padEnd(rowHeader), d2.padStart(columnWidth));
      console.log('Interval duration:'.padEnd(rowHeader),
         (hrs + ' hr' + ((hrs === 1) ? '' : 's')).padStart(columnWidth)
      );
      console.log('Average oplog compression ratio:'.padEnd(rowHeader),
         (ratio + ':1').padStart(columnWidth)
      );
      console.log('Interval document count:'.padEnd(rowHeader),
         docs.toString().padStart(columnWidth)
      );
      console.log('Interval data size:'.padEnd(rowHeader),
         (intervalDataSize.toFixed(2) + ' ' +
         unit).padStart(columnWidth)
      );
      console.log('Estimated interval storage size:'.padEnd(rowHeader),
         (intervalStorageSize.toFixed(2) + ' ' +
         unit).padStart(columnWidth)
      );
      console.log(`\u001b[33m${'-'.repeat(termWidth)}\u001b[0m`);
      console.log('Estimated current oplog churn:'.padEnd(rowHeader),
         (oplogChurn.toFixed(2) + ' ' + unit +
         '/hr').padStart(columnWidth)
      );
      console.log(`\u001b[33m${'='.repeat(termWidth)}\u001b[0m`);
      console.log('\n');
   }

   if (!isReplSet())
      console.log('\n\u001b[31m[ERROR] Host is not a replica set member....exiting!\u001b[0m\n')
   else
      main()

})();

// EOF
