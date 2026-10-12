/*
 *  Name: "oplogchurn.js"
 *  Version: "0.6.2"
 *  Description: "measure current oplog churn rate"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.5.22). This file is mongosh-only.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>oplogchurn.js

/*
 *  Custom parameters:
 *  mongosh [connection options] [--quiet] --eval "var intervalHrs = 1;" [-f|--file] </path/to/>oplogchurn.js
 */

(() => {
   /*
    *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
    *  Save libs to the $MDBLIB or valid search path
    */
   const __script = { "name": "oplogchurn.js", "version": "0.6.2" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
      __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      load(__lib.path);
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   function isOplogchurnCliFile() {
      /*
       *  mongosh --file/-f (or positional *.js) targeting this script.
       *  load() from a REPL or another --file is quiet. mdblib still loads.
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
      return files.some(f => /(^|[\\/])oplogchurn\.js$/i.test(String(f)));
   }
   if (isOplogchurnCliFile()) {
      if (process.stdout && process.stdout.isTTY) console.clear();
      console.log(`\n\n[yellow]${__comment}[/]`);
   }
})();

(async () => {
   /*
    *  Global defaults
    */

   // set interval in hours
   if (typeof intervalHrs === 'undefined') intervalHrs = 1;

   // formatting preferences
   if (typeof termWidth === 'undefined') termWidth = 62;
   if (typeof columnWidth === 'undefined') columnWidth = 25;
   if (typeof rowHeader === 'undefined') rowHeader = 36;

   // connection preferences
   if (typeof readPref === 'undefined') {
      readPref = (hello().secondary === false)
         ? 'primaryPreferred'
         : 'secondaryPreferred';
   }

   function tsSeconds(ts) {
      /*
       *  Extract seconds from a BSON Timestamp
       */
      if (ts == null) return null;
      if (typeof ts.t === 'number') return ts.t;
      return null;
   }

   function formatHrs(hrs) {
      const n = +Number(hrs).toFixed(2);
      return `${n} hr${n === 1 ? '' : 's'}`;
   }

   function padCol(value) {
      return String(value).padStart(columnWidth);
   }

   function oplogCompression(stats) {
      // Unknown free is N/A, not an empty free list (dbstats StorageMetrics).
      // Denom still subtracts internal page size; mixed/missing page size is 4KiB.
      const size = +stats.dataSize;
      const storageSize = +stats.storageSize;
      const free = stats.freeStorageSize;
      if (free == null || Number.isNaN(+free)) return NaN;
      const page = (typeof stats.internalPageSize === 'number' && stats.internalPageSize > 0)
         ? stats.internalPageSize
         : 4096;
      const denom = storageSize - +free - page;
      if (!(denom > 0) || !Number.isFinite(size)) return NaN;
      return +(size / denom).toFixed(2);
   }

   async function main() {
      /*
       *  main
       */
      let opSize = 0, docs = 0, firstTs = null, lastTs = null, sampleOk = true;
      const date = new Date();
      const scaled = new AutoFactor();
      const t2 = Math.floor(date.getTime() / 1000), // end timestamp
         d2 = date.toISOString(), // end datetime
         t1 = Math.floor(date.setHours(date.getHours() - intervalHrs) / 1000), // start timestamp
         d1 = date.toISOString(), // start datetime
         $match = {
            "$match": {
               "ts": {
                  "$gt": Timestamp({ "t": t1, "i": 0 }),
                  "$lte": Timestamp({ "t": t2, "i": 0 })
               }
            }
         },
         $group = {
            "$group": {
               "_id": null,
               "_bsonDataSize": { "$sum": { "$bsonSize": "$$ROOT" } },
               "_documentCount": { "$sum": 1 },
               "_firstTs": { "$min": "$ts" },
               "_lastTs": { "$max": "$ts" }
            }
         },
         // strip synthetic $group _id server-side before returning to the client
         $project = { "$unset": "_id" };
      const pipeline = serverVer(4.4)
         ? [$match, $group, $project]
         : [$match];
      const options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": "Calculating oplog size via oplogchurn.js v0.6.1"
      };
      // Per-command RP only — setReadPref reconnects mongosh and is denied on Atlas shared tiers.
      options.readPreference = { "mode": readPref };

      const oplog = db.getSiblingDB('local').getCollection('oplog.rs');
      const oplogCursor = () => oplog.aggregate(pipeline, options);

      try {
         if (serverVer(4.4)) {
            ([{
               '_bsonDataSize': opSize = 0,
               '_documentCount': docs = 0,
               '_firstTs': firstTs = null,
               '_lastTs': lastTs = null
            } = {}] = oplogCursor().toArray());
         } else {
            console.log('\n[R]Warning: Using the legacy client side calculation technique[/]');
            oplogCursor().forEach(op => {
               opSize += bsonsize(op);
               docs++;
               const sec = tsSeconds(op.ts);
               if (sec == null) return;
               if (firstTs == null || sec < tsSeconds(firstTs)) firstTs = op.ts;
               if (lastTs == null || sec > tsSeconds(lastTs)) lastTs = op.ts;
            });
         }
      } catch (e) {
         sampleOk = false;
         opSize = 0;
         docs = 0;
         firstTs = null;
         lastTs = null;
         console.log(`\n[R]oplog sample unavailable (${commandErrorMessage(e)})[/]`);
      }

      // Observed window from matched oplog entries (not the requested intervalHrs)
      const firstSec = tsSeconds(firstTs);
      const lastSec = tsSeconds(lastTs);
      const observedSecs = (sampleOk && docs > 0 && firstSec != null && lastSec != null)
         ? Math.max(lastSec - firstSec, 1) // same-second batches still count as 1s
         : 0;
      const observedHrs = observedSecs / 3600;
      const churnHrs = observedHrs > 0 ? observedHrs : intervalHrs;

      // Host info & oplog storage stats. Identity stays on the connected member.
      const { 'system': { hostname = 'unknown' } = {} } = hostInfo();
      const { 'parsed': { 'storage': { dbPath = 'unknown' } = {} } = {} } = serverCmdLineOpts();
      const stats = await $collStats('local', 'oplog.rs') || {};
      const ratio = oplogCompression(stats);
      const ratioLabel = Number.isFinite(ratio) ? `${ratio}:1` : 'N/A';
      const intervalDataSize = sampleOk ? scaled.format(opSize) : 'N/A';
      const intervalStorageSize = (sampleOk && Number.isFinite(ratio))
         ? scaled.format(opSize / ratio)
         : 'N/A';
      const oplogChurn = (sampleOk && Number.isFinite(ratio))
         ? `${scaled.format(opSize / ratio / churnHrs)}/hr`
         : 'N/A';

      // Print results
      console.log('\n');
      console.log(`[y]${'═'.repeat(termWidth)}[/]`);
      console.log(`[g]Hostname:[/] ${hostname.padStart(termWidth - 'Hostname: '.length)}`);
      console.log(`[g]dbPath:[/] ${dbPath.padStart(termWidth - 'dbPath: '.length)}`);
      console.log(`[y]${'━'.repeat(termWidth)}[/]`);
      console.log(`[g]${'Start time:'.padEnd(rowHeader)}[/] ${d1.padStart(columnWidth)}`);
      console.log(`[g]${'End time:'.padEnd(rowHeader)}[/] ${d2.padStart(columnWidth)}`);
      console.log(`[g]${'Requested interval:'.padEnd(rowHeader)}[/] ${formatHrs(intervalHrs).padStart(columnWidth)}`);
      console.log(`[g]${'Observed interval:'.padEnd(rowHeader)}[/] ${padCol(sampleOk ? formatHrs(observedHrs) : 'N/A')}`);
      console.log(`[g]${'Average oplog compression ratio:'.padEnd(rowHeader)}[/] ${padCol(ratioLabel)}`);
      console.log(`[g]${'Interval document count:'.padEnd(rowHeader)}[/] ${padCol(sampleOk ? docs : 'N/A')}`);
      console.log(`[g]${'Interval data size:'.padEnd(rowHeader)}[/] ${padCol(intervalDataSize)}`);
      console.log(`[g]${'Estimated interval storage size:'.padEnd(rowHeader)}[/] ${padCol(intervalStorageSize)}`);
      console.log(`[y]${'━'.repeat(termWidth)}[/]`);
      console.log(`[g]${'Estimated current oplog data churn:'.padEnd(rowHeader)}[/] ${padCol(oplogChurn)}`);
      console.log(`[y]${'═'.repeat(termWidth)}[/]`);
      console.log('\n');
   }

   if (!isReplSet()) {
      console.log('\n');
      console.log('\t[R]Host is not a replica set member....exiting![/]');
      console.log('\n');
   } else await main();
})();

// EOF
