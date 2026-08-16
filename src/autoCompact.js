(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.2.2"
    *  Description: "autoCompact() with log and serverStatus monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise command options "freeSpaceTargetMB", "runOnce", and/or "timeoutMS" if required
    *  - waits for the WTCMPCT sizeStorer skip line, or serverStatus background compact idle
    *  - timeoutMS aborts the wait (0/omitted = no timeout)
    *  - log poll interval follows getProfilingStatus().slowms (re-read each poll); 100ms without enableProfiler
    *  - mongosh only
    */

   // Usage: mongosh [direct host connection options] [--quiet] [--eval 'const freeSpaceTargetMB = 1, runOnce = true, timeoutMS = 0;'] [-f|--file] </path/to/>autoCompact.js

   /*
    *  Example of basic direct localhost usage:
    *
    *    mongosh "localhost:27017" autoCompact.js
    *
    *  Example using custom autoCompact command options:
    *
    *    mongosh "localhost:27017" --quiet --eval 'const freeSpaceTargetMB = 64, runOnce = true, timeoutMS = 3600000;' -f autoCompact.js
    */

   const __script = { "name": "autoCompact.js", "version": "0.2.2" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);

   const autoCompact = (freeSpaceTargetMB = 1, runOnce = true) => db.adminCommand({
      "autoCompact": true,
      "freeSpaceTargetMB": freeSpaceTargetMB,
      "runOnce": runOnce
   });
   const getAutoCompactRunning = () => {
      // WiredTiger background-compact.running is the authoritative idle/active flag
      let running;
      try {
         ({ 'wiredTiger': {
               'background-compact': {
                  'background compact running': running
               } = {}
            } = {}
         } = db.adminCommand({
            "serverStatus": 1,
            "locks": false,
            "metrics": false,
            "repl": false,
            "tcmalloc": false,
            "wiredTiger": true
         }));
      } catch (error) {
         return null;
      }
      if (running === undefined) return null;
      return running > 0 || running === true;
   };
   const getSlowms = () => {
      // Atlas may change the effective threshold at runtime; profile status is the live value
      try {
         const { slowms } = db.getSiblingDB('admin').getProfilingStatus();
         if (Number.isFinite(+slowms) && +slowms > 0) return +slowms;
      } catch (error) {
         return null; // enableProfiler required
      }
      return null;
   };
   const getLogs = ts => db.adminCommand(
      { "getLog": "global" }
   ).log.map(
      EJSON.parse
   ).filter(({ c, t }) => {
      // return only new compaction activity log entries
      return c === 'WTCMPCT' && t > ts
   });
   const tailLogs = (ts, timeoutMS = 0) => {
      let pause = false;
      let message = '';
      let seenRunning = false;
      let fallbackWarned = false;
      const fallbackMS = 100;
      const started = Date.now();
      // expected to be the last namespace
      const stop = 'sizeStorer.wt: there is no useful work to do - skipping compaction';

      do {
         if (timeoutMS > 0 && Date.now() - started >= timeoutMS) {
            console.log(`\x1b[31m[ERROR] timed out after ${timeoutMS}ms waiting for autoCompact\x1b[0m`);
            return;
         }
         const logs = getLogs(ts);
         if (logs.length > 0) {
            logs.forEach(({ t = ISODate(), 'attr': { 'message': { msg = '' } = {} } = {} } = {}) => {
               ts = t;
               message = msg;
               console.log(t.toJSON(), msg);
            });
            pause = false; // reset pause when new log entries are present
         } else if (!pause) {
            console.log('\t══════ Compaction work in progress, waiting for new logs ══════');
            pause = true; // set pause to prevent repeated messages
         }
         // serverStatus 1→0 overrides the log stop line (log text/verbosity is version-fragile)
         const running = getAutoCompactRunning();
         if (running === true) seenRunning = true;
         if (seenRunning && running === false) {
            console.log('\n\t══════ serverStatus: background compact idle ══════');
            break;
         }
         const slowms = getSlowms();
         if (slowms == null && !fallbackWarned) {
            console.log(`\x1b[31m[WARN] getProfilingStatus() unavailable, polling every ${fallbackMS}ms\x1b[0m`);
            fallbackWarned = true;
         }
         sleep(slowms ?? fallbackMS);
      } while (message !== stop);
      console.log('\n\t══════ autoCompaction round complete ══════');
   };

   // --eval may bind these with const; never reassign, resolve into locals
   const timeoutMSOpt = typeof timeoutMS === 'undefined' ? 0 : timeoutMS ?? 0;
   const options = {
      "freeSpaceTargetMB": typeof freeSpaceTargetMB === 'undefined' ? 1 : freeSpaceTargetMB ?? 1,
      "runOnce": typeof runOnce === 'undefined' ? true : runOnce ?? true,
      "timeoutMS": Number.isFinite(+timeoutMSOpt) && +timeoutMSOpt > 0 ? +timeoutMSOpt : 0
   };
   console.log(`\nExecuting command:\n`);
   console.log(`db.adminCommand({
      "autoCompact": true,
      "freeSpaceTargetMB": ${options.freeSpaceTargetMB},
      "runOnce": ${options.runOnce} }
   );\n`);
   const ts = ISODate();
   let result;
   try {
      result = autoCompact(options.freeSpaceTargetMB, options.runOnce);
   } catch (error) {
      console.log('\x1b[31m[ERROR] autoCompact failed:\x1b[0m', error);
      return;
   }
   if (result?.ok !== 1) {
      console.log('\x1b[31m[ERROR] autoCompact failed:\x1b[0m', result);
      return;
   }
   tailLogs(ts, options.timeoutMS);
})();

// EOF
