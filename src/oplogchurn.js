/*
 *  Name: "oplogchurn.js"
 *  Version: "0.5.7"
 *  Description: "measure current oplog churn rate"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet oplogchurn.js"

/*
 *  Custom parameters:
 *  [mongo|mongosh] [connection options] --quiet --eval "let intervalHrs = 1;" [-f|--file] oplogchurn.js
 */

(() => {
   /*
    *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
    *  Save libs to the $MDBLIB or valid search path
    */
   const __script = { "name": "oplogchurn.js", "version": "0.5.7" };
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
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.clear();
   console.log(`\n\n[yellow]${__comment}[/]`);
   if (shellVer() < serverVer() && typeof process === 'undefined') console.log(`\n[red][WARN] Possibly incompatible legacy shell version detected: ${version()}[/]`);
   if (shellVer() < 1.0 && typeof process !== 'undefined') console.log(`\n[red][WARN] Possible incompatible non-GA shell version detected: ${version()}[/]`);
   if (serverVer() < 4.2) console.log(`\n[red][ERROR] Unsupported mongod/s version detected: ${db.version()}[/]`);
})();

(() => {
   /*
    *  Global defaults
    */

   // set interval in hours
   typeof intervalHrs === 'undefined' && (intervalHrs = 1) || intervalHrs;

   // formatting preferences
   typeof termWidth === 'undefined' && (termWidth = 62) || termWidth;
   typeof columnWidth === 'undefined' && (columnWidth = 25) || columnWidth;
   typeof rowHeader === 'undefined' && (rowHeader = 36) || rowHeader;

   // connection preferences
   (typeof readPref === 'undefined') && !!(readPref = (hello().secondary == false) ? 'primaryPreferred' : 'secondaryPreferred');

   function main() {
      /*
       *  main
       */
      let opSize = 0, docs = 0, date = new Date();
      const scaled = new AutoFactor();
      const t2 = Math.floor(date.getTime() / 1000.0), // end timestamp
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
      let pipeline = [$match, $project];
      const options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "comment": "Calculating oplog size via oplogchurn.js"
      };

      // Measure interval statistics
      slaveOk(readPref); // not supported on shared tiers
      const oplog = db.getSiblingDB('local').getCollection('oplog.rs');

      if (serverVer(4.4)) {
         // Using the v4.4+ $bsonSize aggregation operator
         pipeline.push({
            "$group": {
               "_id": null,
               "_bsonDataSize": { "$sum": { "$bsonSize": "$$ROOT" } },
               "_documentCount": { "$sum": 1 }
         } });
         ([{ '_bsonDataSize': opSize, '_documentCount': docs }] = oplog.aggregate(pipeline, options).toArray());
      } else {
         console.log('\n[red]Warning: Using the legacy client side calculation technique[/]');
         oplog.aggregate(pipeline, options).forEach(op => {
            opSize += bsonsize(op);
            ++docs;
         });
      }

      // Get host info & oplog stats
      const { 'system': { hostname } } = hostInfo(),
         { 'parsed': { 'storage': { dbPath } } } = db.serverCmdLineOpts(),
         // Get oplog collection stats
         { 'wiredTiger': {
            creationString,
            'block-manager': {
               'file bytes available for reuse': blocksFree,
               'file size in bytes': storageSize
            } },
            size,
            internalPageSize = (creationString.match(/internal_page_max=(\d+)/)[1] * 1024)
         } = oplog.stats();
      const overhead = internalPageSize;
      const ratio = +((size / (storageSize - blocksFree - overhead)).toFixed(2)),
         intervalDataSize = scaled.format(opSize);
      const intervalStorageSize = scaled.format(opSize / ratio);
      const oplogChurn = scaled.format(opSize / ratio / intervalHrs);

      // Print results
      console.log('\n');
      console.log(`[yellow]${'═'.repeat(termWidth)}[/]`);
      console.log(`[green]Hostname:[/] ${hostname.padStart(termWidth - 'Hostname: '.length)}`);
      console.log(`[green]dbPath:[/] ${dbPath.padStart(termWidth - 'dbPath: '.length)}`);
      console.log(`[yellow]${'━'.repeat(termWidth)}[/]`);
      console.log(`[green]${'Start time:'.padEnd(rowHeader)}[/] ${d1.padStart(columnWidth)}`);
      console.log(`[green]${'End time:'.padEnd(rowHeader)}[/] ${d2.padStart(columnWidth)}`);
      console.log(`[green]${'Interval duration:'.padEnd(rowHeader)}[/] ${`${intervalHrs} hr${(intervalHrs == 1) ? '' : 's'}`.padStart(columnWidth)}`);
      console.log(`[green]${'Average oplog compression ratio:'.padEnd(rowHeader)}[/] ${`${ratio}:1`.padStart(columnWidth)}`);
      console.log(`[green]${'Interval document count:'.padEnd(rowHeader)}[/] ${docs.toString().padStart(columnWidth)}`);
      console.log(`[green]${'Interval data size:'.padEnd(rowHeader)}[/] ${`${intervalDataSize}`.padStart(columnWidth)}`);
      console.log(`[green]${'Estimated interval storage size:'.padEnd(rowHeader)}[/] ${`${intervalStorageSize}`.padStart(columnWidth)}`);
      console.log(`[yellow]${'━'.repeat(termWidth)}[/]`);
      console.log(`[green]${'Estimated current oplog data churn:'.padEnd(rowHeader)}[/] ${`${oplogChurn}/hr`.padStart(columnWidth)}`);
      console.log(`[yellow]${'═'.repeat(termWidth)}[/]`);
      console.log('\n');
   }

   if (!isReplSet()) {
      console.log('\n');
      console.log('\t[red]Host is not a replica set member....exiting![/]');
      console.log('\n');
   } else main();
})();

// EOF
