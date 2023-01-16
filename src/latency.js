/*
 *  Name: "latency.js"
 *  Version: "0.2.2"
 *  Description: driver and network latency telemetry PoC
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet latency.js"

console.clear();

(() => {
   /*
    *  main
    */
   let __script = { "name": "latency.js", "version": "0.2.2" };
   console.log(`\n---> Running script ${__script.name} v${__script.version}\n`);

   let { slowms } = db.getSiblingDB('admin').getProfilingStatus(),
      filter = `Synthetic slow operation at ${performance.now()}`;
   let pipeline = [
         { "$currentOp": {} },
         { "$limit": 1 },
         { "$project": {
            "_id": 0,
            "slowms": {
               "$function": {
                  "body": `function(ms) {
                     sleep(ms);
                     return ms;
                  }`,
                  // "args": ["$$delayms"],
                  "args": [slowms],
                  "lang": "js"
         } } } }
      ],
      options = {
         "comment": filter,
         "cursor": { "batchSize": 1 },
         "readConcern": { "level": "local" },
         // "let": { "delayms": slowms }
      },
      result, rtt, t0, t1, t2, t3, totalTime,
      report, tableWidth, padding, longestValue,
      columnWidth = 24, spacing = 2;

   try {
      t0 = process.hrtime();
      result = db.getSiblingDB('admin').aggregate(pipeline, options).toArray()[0];
      t1 = process.hrtime(t0);
   } catch(error) {
      throw error;
   }

   // let { t, 'attr': { 'durationMillis': durationMillis } // t is experimental
   let { 'attr': { 'durationMillis': durationMillis }
      } = db.adminCommand(
         { "getLog": "global" }
      ).log.map(logString => {
         return EJSON.parse(logString)
      }).filter(log => {
         return log?.attr?.command?.comment == filter
      })[0];

   try {
      t2 = process.hrtime();
      let { ok } = db.adminCommand({ "ping": 1 });
      t3 = process.hrtime(t2);
   } catch(error) {
      throw error;
   }

   totalTime = t1[0] * 1000 + (t1[1] / 1000000);
   rtt = t3[0] * 1000 + (t3[1] / 1000000);

   function fomatted(duration) {
      return Intl.NumberFormat('en', {
         "minimumIntegerDigits": 1,
         "minimumFractionDigits": 2,
         "maximumFractionDigits": 2,
         "style": "unit",
         "unit": "millisecond", // https://tc39.es/proposal-unified-intl-numberformat/section6/locales-currencies-tz_proposed_out.html#sec-issanctionedsimpleunitidentifier
         "unitDisplay": "short" // "narrow"
      }).format(duration);
   }

   longestValue = fomatted(totalTime).length;
   tableWidth = columnWidth + longestValue + spacing;
   padding = longestValue + spacing;
   report = `
   Measurement
   ${'-'.repeat(tableWidth)}
   ${'Delay/slowms factor:'.padEnd(columnWidth)}${fomatted(slowms).padStart(padding)}
   ${'Total measurement time:'.padEnd(columnWidth)}${fomatted(totalTime).padStart(padding)}
   ${'='.repeat(tableWidth)}

   Latency breakdown
   ${'-'.repeat(tableWidth)}
   ${'Server execution time:'.padEnd(columnWidth)}${fomatted(durationMillis - slowms).padStart(padding)}
   ${'Network latency (RTT):'.padEnd(columnWidth)}${fomatted(rtt).padStart(padding)}
   ${'Driver execution time:'.padEnd(columnWidth)}${fomatted(totalTime - durationMillis - rtt).padStart(padding)}
   ${'='.repeat(tableWidth)}
   `;
   console.log(report);
})();

// EOF
