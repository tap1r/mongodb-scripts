/*
 *  Name: "latency.js"
 *  Version: "0.4.0"
 *  Description: "Driver and network latency telemetry PoC"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: [mongo|mongosh] [connection options] --quiet [-f|--file] latency.js

// Example: mongosh --host "replset/localhost" --quiet latency.js

(() => {
   /*
    *  main
    */
   const __script = { "name": "latency.js", "version": "0.4.0" };
   if (typeof console === 'undefined') {
      /*
       *  legacy mongo detected
       */
      (console = {});
      console.log = print;
      console.clear = () => _runMongoProgram('clear');
      console.error = tojson;
      console.debug = tojson;
      console.dir = tojson;
      (EJSON = {});
      EJSON.parse = JSON.parse;
   }
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);

   // const formatted = duration =>
   //    Intl.NumberFormat('en', {
   //       "minimumIntegerDigits": 1,
   //       // "minimumFractionDigits": 1,
   //       "minimumFractionDigits": 0,
   //       // "maximumFractionDigits": 1,
   //       "maximumFractionDigits": 0,
   //       "style": "unit",
   //       "unit": "millisecond",
   //       "unitDisplay": "short"
   //    }).format(duration);

   const spacing = 1;
   let t0, t1, t2, t3, ping;

   const filter = `Synthetic slow operation at ${Date.now()}`;
   const options = {
      "comment": filter,
      "cursor": { "batchSize": 1 },
      "readConcern": { "level": "local" }
   };
   let slowms = 100;
   try {
      ({ slowms } = db.getSiblingDB('admin').getProfilingStatus());
   } catch(error) {
      slowms = 200;
      console.log('\x1b[31m[WARN] failed to aquire the slowms threshold:\x1b[0m', error);
      console.log(`\x1b[31m[WARN] defaulting slowms to ${slowms}ms\x1b[0m`);
   }
   const pipeline = [
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
   ];

   let hostname = 'unknown';
   try {
      hostname = db.hello().me;
   } catch(error) {
      console.log('\x1b[31m[WARN] failed to aquire the hostname:\x1b[0m', error);
   }

   const [
      { 'tags': {
         workloadType = '-',
         availabilityZone = '-',
         diskState = '-',
         nodeType = '-',
         provider = '-',
         region = '-'
      } = {} } = {}
   ] = rs.conf().members.filter(
      ({ host, arbiterOnly, hidden, 'horizons': { PUBLIC } = {} } = {}) => {
         return (host == hostname || PUBLIC == hostname) && !arbiterOnly && !hidden;
   });

   let procType;
   try {
      ({ 'process': procType = 'unknown' } = db.serverStatus());
   } catch(error) {
      procType = 'unknown';
      console.log('\x1b[31m[WARN] failed to aquire the process type:\x1b[0m', error);
   }

   try {
      // t0 = process.hrtime();
      t0 = Date.now();
      db.getSiblingDB('admin').aggregate(pipeline, options).toArray();
   } catch(error) {
      console.log('Synthetic slow query failed');
      throw error;
   } finally {
      // t1 = process.hrtime(t0);
      t1 = Date.now();
   }

   const [{ 'attr': { durationMillis = 0 } = {} } = {}] = db.adminCommand(
      { "getLog": "global" }
   ).log.map(
      EJSON.parse
   ).filter(
      // log => log?.attr?.command?.comment == filter
      ({ 'attr': { 'command': { comment = '' } = {} } = {} } = {}) => comment == filter
   );

   try {
      // t2 = process.hrtime();
      t2 = Date.now();
      // ping = db.adminCommand({ "ping": 1 })?.ok ?? false);
      ({ 'ok': ping = false } = db.adminCommand({ "ping": 1 }));
   } catch(error) {
      console.error('SDAM ping failed');
      throw error;
   } finally {
      // t3 = process.hrtime(t2);
      t3 = Date.now();
      if (!ping) throw new Error();
   }

   const timestamp = new Date().toISOString();
   // totalTime = t1[0] * 1000 + (t1[1] / 1000000.0);
   const totalTime = t1 - t0;
   // rtt = t3[0] * 1000 + (t3[1] / 1000000.0);
   const rtt = t3 - t2;
   const hostLength = 'Host:'.length + spacing + hostname.length;
   const timeLength = 'Timestamp:'.length + spacing + timestamp.length;
   const tableWidth = Math.max(hostLength, timeLength);
   const serverTime = durationMillis - slowms;
   const driverTime = totalTime - durationMillis - rtt;
   const report = `\n` +
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
      // `\x1b[32m${'Delay factor (slowms):'}\x1b[0m${formatted(slowms).padStart(tableWidth - 'Delay factor (slowms):'.length)}\n` +
      `\x1b[32m${'Delay factor (slowms):'}\x1b[0m${`${slowms} ms`.padStart(tableWidth - 'Delay factor (slowms):'.length)}\n` +
      // `\x1b[32m${'Total measurement time:'}\x1b[0m${formatted(totalTime).padStart(tableWidth - 'Total measurement time:'.length)}\n` +
      `\x1b[32m${'Total measurement time:'}\x1b[0m${`${totalTime} ms`.padStart(tableWidth - 'Total measurement time:'.length)}\n` +
      `\x1b[33m${'═'.repeat(tableWidth)}\x1b[0m\n` +
      `\n` +
      `\x1b[1mLatency breakdown\x1b[0m\n` +
      `\x1b[33m${'━'.repeat(tableWidth)}\x1b[0m\n` +
      // `\x1b[32m${'Server execution time:'}\x1b[0m${formatted(serverTime).padStart(tableWidth - 'Server execution time:'.length)}\n` +
      `\x1b[32m${'Server execution time:'}\x1b[0m${`${serverTime} ms`.padStart(tableWidth - 'Server execution time:'.length)}\n` +
      // `\x1b[32m${'Network latency (RTT):'}\x1b[0m${formatted(rtt).padStart(tableWidth - 'Network latency (RTT):'.length)}\n` +
      `\x1b[32m${'Network latency (RTT):'}\x1b[0m${`${rtt} ms`.padStart(tableWidth - 'Network latency (RTT):'.length)}\n` +
      // `\x1b[32m${'Driver execution time:'}\x1b[0m${formatted(driverTime).padStart(tableWidth - 'Driver execution time:'.length)}\n` +
      `\x1b[32m${'Driver execution time:'}\x1b[0m${`${driverTime} ms`.padStart(tableWidth - 'Driver execution time:'.length)}\n` +
      `\x1b[33m${'═'.repeat(tableWidth)}\x1b[0m\n`;
   console.log(report);
})();

// EOF
