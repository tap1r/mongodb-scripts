/*
 *  Name: "latency.js"
 *  Version: "0.3.6"
 *  Description: "Driver and network latency telemetry PoC"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: mongosh [connection options] --quiet latency.js

(() => {
   /*
    *  main
    */
   let __script = { "name": "latency.js", "version": "0.3.6" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);

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
               // deprecated operator in v8, likely to be replaced with a future $sleep operator
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
      report, tableWidth, spacing = 1, hostLength,
      timeLength, hostname = 'unknown', procType,
      ping;

   try {
      hostname = db.hello().me;
   } catch(error) {
      console.log('\x1b[31m[WARN] failed to aquire the hostname:\x1b[0m', error);
   }

   let [{
      'tags': {
         workloadType = '-',
         availabilityZone = '-',
         diskState = '-',
         nodeType = '-',
         provider = '-',
         region = '-'
      } = {}
   }] = rs.conf().members.filter(
      ({ host, arbiterOnly, hidden, horizons: { PUBLIC } = {} } = {}) => {
         return (host == hostname || PUBLIC == hostname) && !arbiterOnly && !hidden;
   });

   try {
      procType = db.serverStatus()?.process ?? 'unknown';
   } catch(error) {
      console.log('\x1b[31m[WARN] failed to aquire the process type:\x1b[0m', error);
      procType = 'unknown';
   }

   try {
      t0 = process.hrtime();
      db.getSiblingDB('admin').aggregate(pipeline, options).toArray();
   } catch(error) {
      console.log('Synthetic slow query failed');
      throw error;
   } finally {
      t1 = process.hrtime(t0);
   }

   let { 'attr': { durationMillis } = {}
      } = db.adminCommand(
         { "getLog": "global" }
      ).log.map(
         EJSON.parse
      ).filter(
         log => log?.attr?.command?.comment == filter
      )[0];

   try {
      t2 = process.hrtime();
      ping = db.adminCommand({ "ping": 1 })?.ok ?? false;
   } catch(error) {
      console.error('SDAM ping failed');
      throw error;
   } finally {
      t3 = process.hrtime(t2);
      if (!ping) throw new Error();
   }

   timestamp = new Date().toISOString();
   totalTime = t1[0] * 1000 + (t1[1] / 1000000.0);
   rtt = t3[0] * 1000 + (t3[1] / 1000000.0);

   function fomatted(duration) {
      return Intl.NumberFormat('en', {
         "minimumIntegerDigits": 1,
         "minimumFractionDigits": 1,
         "maximumFractionDigits": 1,
         "style": "unit",
         "unit": "millisecond",
         "unitDisplay": "short"
      }).format(duration);
   }

   hostLength = 'Host:'.length + spacing + hostname.length;
   timeLength = 'Timestamp:'.length + spacing + timestamp.length;
   tableWidth = Math.max(hostLength, timeLength);
   report = `\n` +
      `\x1b[1mInternal metrics\x1b[0m\n` +
      `\x1b[33m${'━'.repeat(tableWidth)}\x1b[0m\n` +
      `\x1b[32m${'Host:'}\x1b[0m${hostname.padStart(tableWidth - 'Host:'.length)}\n` +
      `\x1b[32m${'Process type:'}\x1b[0m${procType.padStart(tableWidth - 'Process type:'.length)}\n` +
      `\x1b[32m${'Cloud provider:'}\x1b[0m${provider.padStart(tableWidth - 'Cloud provider:'.length)}\n` +
      `\x1b[32m${'Cloud region:'}\x1b[0m${region.padStart(tableWidth - 'Cloud region:'.length)}\n` +
      `\x1b[32m${'Availability zone:'}\x1b[0m${availabilityZone.padStart(tableWidth - 'Availability zone:'.length)}\n` +
      `\x1b[32m${'Disk state:'}\x1b[0m${diskState.padStart(tableWidth - 'Disk state:'.length)}\n` +
      `\x1b[32m${'Workload type:'}\x1b[0m${workloadType.padStart(tableWidth - 'Workload type:'.length)}\n` +
      `\x1b[32m${'Node type:'}\x1b[0m${nodeType.padStart(tableWidth - 'Node type:'.length)}\n` +
      `\x1b[32m${'Timestamp:'}\x1b[0m${timestamp.padStart(tableWidth - 'Timestamp:'.length)}\n` +
      `\x1b[32m${'Delay factor (slowms):'}\x1b[0m${fomatted(slowms).padStart(tableWidth - 'Delay factor (slowms):'.length)}\n` +
      `\x1b[32m${'Total measurement time:'}\x1b[0m${fomatted(totalTime).padStart(tableWidth - 'Total measurement time:'.length)}\n` +
      `\x1b[33m${'═'.repeat(tableWidth)}\x1b[0m\n` +
      `\n` +
      `\x1b[1mLatency breakdown\x1b[0m\n` +
      `\x1b[33m${'━'.repeat(tableWidth)}\x1b[0m\n` +
      `\x1b[32m${'Server execution time:'}\x1b[0m${fomatted(durationMillis - slowms).padStart(tableWidth - 'Server execution time:'.length)}\n` +
      `\x1b[32m${'Network latency (RTT):'}\x1b[0m${fomatted(rtt).padStart(tableWidth - 'Network latency (RTT):'.length)}\n` +
      `\x1b[32m${'Driver execution time:'}\x1b[0m${fomatted(totalTime - durationMillis - rtt).padStart(tableWidth - 'Driver execution time:'.length)}\n` +
      `\x1b[33m${'═'.repeat(tableWidth)}\x1b[0m\n`;
   console.log(report);
})();

// EOF
