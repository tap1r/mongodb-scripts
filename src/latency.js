/*
 *  Name: "latency.js"
 *  Version: "0.2.8"
 *  Description: driver and network latency telemetry PoC
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet latency.js"

console.clear();

(() => {
   /*
    *  main
    */
   let __script = { "name": "latency.js", "version": "0.2.8" };
   console.log(`\n\x1b[33m# Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);

   let slowms = 100,
      filter = `Synthetic slow operation at ${performance.now()}`;
   try {
      slowms = db.getSiblingDB('admin').getProfilingStatus().slowms;
   } catch(error) {
      console.log('\x1b[31m[WARN] failed to aquire the slowms threshold:\x1b[0m', error);
      console.log('\x1b[31m[WARN] defaulting slowms to 200ms\x1b[0m');
      slowms = 200;
   }
   // let { slowms = 100 } = db.getSiblingDB('admin').getProfilingStatus();
   let pipeline = [
         { "$currentOp": { } },
         { "$limit": 1 },
         { "$project": {
            "_id": 0,
            "slowms": {
               "$function": {
                  "body": `function(ms) { sleep(ms) }`,
                  "args": [slowms],
                  "lang": "js"
         } } } }
      ],
      options = {
         "comment": filter,
         "cursor": { "batchSize": 1 },
         "readConcern": { "level": "local" }
      },
      rtt, t0, t1, t2, t3, totalTime,
      report, tableWidth, padding, longestValue,
      columnWidth = 24, spacing = 2;

   try {
      t0 = process.hrtime();
      db.getSiblingDB('admin').aggregate(pipeline, options).toArray();
      t1 = process.hrtime(t0);
   } catch(error) {
      console.log('Synthetic slow query failed');
      throw error;
   }

   let { 'attr': { 'durationMillis': durationMillis }
      } = db.adminCommand(
         { "getLog": "global" }
      ).log.map(
         EJSON.parse
      ).filter(
         log => log?.attr?.command?.comment == filter
      )[0];

   try {
      t2 = process.hrtime();
      let { ok } = db.adminCommand({ "ping": 1 });
      t3 = process.hrtime(t2);
      if (!ok) throw new Error();
   } catch(error) {
      console.error('SDAM ping failed');
      throw error;
   }

   totalTime = t1[0] * 1000 + (t1[1] / 1000000.0);
   rtt = t3[0] * 1000 + (t3[1] / 1000000.0);

   function fomatted(duration) {
      return Intl.NumberFormat('en', {
         "minimumIntegerDigits": 1,
         "minimumFractionDigits": 2,
         "maximumFractionDigits": 2,
         "style": "unit",
         "unit": "millisecond",
         "unitDisplay": "short"
      }).format(duration);
   }

   longestValue = fomatted(totalTime).length;
   tableWidth = columnWidth + longestValue + spacing;
   padding = longestValue + spacing;
   report = `
   \x1b[1mMeasurement\x1b[0m
   \x1b[33m${'━'.repeat(tableWidth)}\x1b[0m
   \x1b[32m${'Delay/slowms factor:'.padEnd(columnWidth)}\x1b[0m${fomatted(slowms).padStart(padding)}
   \x1b[32m${'Total measurement time:'.padEnd(columnWidth)}\x1b[0m${fomatted(totalTime).padStart(padding)}
   \x1b[33m${'═'.repeat(tableWidth)}\x1b[0m

   \x1b[1mLatency breakdown\x1b[0m
   \x1b[33m${'━'.repeat(tableWidth)}\x1b[0m
   \x1b[32m${'Server execution time:'.padEnd(columnWidth)}\x1b[0m${fomatted(durationMillis - slowms).padStart(padding)}
   \x1b[32m${'Network latency (RTT):'.padEnd(columnWidth)}\x1b[0m${fomatted(rtt).padStart(padding)}
   \x1b[32m${'Driver execution time:'.padEnd(columnWidth)}\x1b[0m${fomatted(totalTime - durationMillis - rtt).padStart(padding)}
   \x1b[33m${'═'.repeat(tableWidth)}\x1b[0m
   `;
   console.log(report);
})();

// EOF
