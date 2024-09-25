/*
 *  Name: "latency.js"
 *  Version: "0.3.2"
 *  Description: "Driver and network latency telemetry PoC"
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: mongosh [connection options] --quiet latency.js

(() => {
   /*
    *  main
    */
   let __script = { "name": "latency.js", "version": "0.3.2" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);

   let slowms = 100,
      filter = `Synthetic slow operation at ${performance.now()}`;
   try {
      slowms = db.getSiblingDB('admin').getProfilingStatus().slowms;
   } catch(error) {
      console.log('\x1b[31m[WARN] failed to aquire the slowms threshold:\x1b[0m', error);
      console.log('\x1b[31m[WARN] defaulting slowms to 200ms\x1b[0m');
      slowms = 200;
   }
   let pipeline = [
         { "$currentOp": {} },
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
      rtt, t0, t1, t2, t3, totalTime, timestamp,
      report, tableWidth, spacing, hostLength, timeLength,
      hostname = db.hostInfo()?.system?.hostname ?? 'unknown',
      proc = db.serverStatus().process;

   try {
      t0 = process.hrtime();
      db.getSiblingDB('admin').aggregate(pipeline, options).toArray();
      t1 = process.hrtime(t0);
   } catch(error) {
      console.log('Synthetic slow query failed');
      throw error;
   }

   let { 'attr': { durationMillis }
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

   timestamp = new Date().toISOString();
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

   spacing = 1;
   hostLength = 'Target host:'.length + spacing + hostname.length;
   timeLength = 'Timestamp:'.length + spacing + timestamp.length;
   tableWidth = Math.max(hostLength, timeLength);
   report = `
   \x1b[1mInternal metrics\x1b[0m
   \x1b[33m${'━'.repeat(tableWidth)}\x1b[0m
   \x1b[32m${'Target host:'}\x1b[0m${hostname.padStart(tableWidth - 12)}
   \x1b[32m${'Process type:'}\x1b[0m${proc.padStart(tableWidth - 13)}
   \x1b[32m${'Timestamp:'}\x1b[0m${timestamp.padStart(tableWidth - 10)}
   \x1b[32m${'Delay factor (slowms):'}\x1b[0m${fomatted(slowms).padStart(tableWidth - 22)}
   \x1b[32m${'Total measurement time:'}\x1b[0m${fomatted(totalTime).padStart(tableWidth - 23)}
   \x1b[33m${'═'.repeat(tableWidth)}\x1b[0m

   \x1b[1mLatency breakdown\x1b[0m
   \x1b[33m${'━'.repeat(tableWidth)}\x1b[0m
   \x1b[32m${'Server execution time:'}\x1b[0m${fomatted(durationMillis - slowms).padStart(tableWidth - 22)}
   \x1b[32m${'Network latency (RTT):'}\x1b[0m${fomatted(rtt).padStart(tableWidth - 22)}
   \x1b[32m${'Driver execution time:'}\x1b[0m${fomatted(totalTime - durationMillis - rtt).padStart(tableWidth - 22)}
   \x1b[33m${'═'.repeat(tableWidth)}\x1b[0m
   `;
   console.log(report);
})();

// EOF
