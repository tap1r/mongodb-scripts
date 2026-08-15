(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.1.4"
    *  Description: "autoCompact() with log monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise command options "freeSpaceTargetMB" and/or "runOnce" if required
    *  - mongosh only
    */

   // Usage: mongosh [direct host connection options] [--quiet] [--eval 'const freeSpaceTargetMB = 1, runOnce = true;'] [-f|--file] </path/to/>autoCompact.js

   /*
    *  Example of basic direct localhost usage:
    *
    *    mongosh "localhost:27017" autoCompact.js
    *
    *  Example using custom autoCompact command options:
    *
    *    mongosh "localhost:27017" --quiet --eval 'const freeSpaceTargetMB = 64, runOnce = true;' -f autoCompact.js
    */

   const __script = { "name": "autoCompact.js", "version": "0.1.4" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);

   const autoCompact = (freeSpaceTargetMB = 1, runOnce = true) => db.adminCommand({
      "autoCompact": true,
      "freeSpaceTargetMB": freeSpaceTargetMB,
      "runOnce": runOnce
   });
   const getLogs = ts => db.adminCommand(
      { "getLog": "global" }
   ).log.map(
      EJSON.parse
   ).filter(({ c, t }) => {
      // return only new compaction activity log entries
      return c === 'WTCMPCT' && t > ts
   });
   const tailLogs = ts => {
      let pause = false;
      let message = '';
      // expected to be the last namespace
      const stop = 'sizeStorer.wt: there is no useful work to do - skipping compaction';

      do {
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
         sleep(100);
      } while (message !== stop);
      console.log('\n\t══════ autoCompaction round complete ══════');
   }

   freeSpaceTargetMB = typeof freeSpaceTargetMB !== 'undefined' ? freeSpaceTargetMB ?? 1 : 1;
   runOnce = typeof runOnce !== 'undefined' ? runOnce ?? true : true;
   console.log(`\nExecuting command:\n`);
   console.log(`db.adminCommand({
      "autoCompact": true,
      "freeSpaceTargetMB": ${freeSpaceTargetMB},
      "runOnce": ${runOnce} }
   );\n`);
   const ts = ISODate();
   autoCompact(freeSpaceTargetMB, runOnce);
   tailLogs(ts);
})();

// EOF
