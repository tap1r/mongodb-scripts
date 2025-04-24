(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.1.1"
    *  Description: "autoCompact() with log monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise command options "freeSpaceTargetMB" and/or "runOnce" if required
    *  - mongosh only
    */

   // Usage: mongosh [direct host connection options] [--quiet] [--eval 'const freeSpaceTargetMB = 1, runOnce = true;'] [-f|--file] autoCompact.js

   /*
    *  Example of basic direct localhost usage:
    *
    *    mongosh "localhost:27017" autoCompact.js
    *
    *  Example using custom autoCompact command options:
    *
    *    mongosh "localhost:27017" --quiet --eval 'const freeSpaceTargetMB = 64, runOnce = true;' -f autoCompact.js
    */

   const __script = { "name": "autoCompact.js", "version": "0.1.1" };

   const cmd = (freeSpaceTargetMB = 1, runOnce = true) => db.adminCommand({
      "autoCompact": true,
      "freeSpaceTargetMB": freeSpaceTargetMB,
      "runOnce": runOnce
   });
   const tailLogs = () => {
      let ts = ISODate();
      let pause = 0;
      let msg = '';
      // expected to be the last namespace
      const stop = 'sizeStorer.wt: there is no useful work to do - skipping compaction';
      const getLogs = ts => db.adminCommand(
         { "getLog": "global" }
      ).log.map(
         EJSON.parse
      ).filter(log => {
         return log?.attr?.message?.session_name == 'WT_SESSION.compact' && log?.t > ts
      });

      do {
         const logs = getLogs(ts);
         if (logs.length) {
            logs.forEach(log => {
               ts = log?.t ?? ISODate();
               msg = log?.attr?.message?.msg ?? '';
               console.log(ts.toJSON(), msg);
            });
            pause = 0; // reset pause when logs are found
         } else if (!pause) {
            console.log('\n-----Work in progress, waiting for new logs-----\n');
            pause = 1; // set pause to prevent repeated messages
         }
         sleep(100);
      } while (msg !== stop);
      console.log('\n-----autoCompaction round complete-----\n');
   }

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);

   freeSpaceTargetMB = typeof freeSpaceTargetMB !== 'undefined' ? freeSpaceTargetMB ?? 1 : 1;
   runOnce = typeof runOnce !== 'undefined' ? runOnce ?? true : true;
   console.log(`\nautoCompact() command options freeSpaceTargetMB ${freeSpaceTargetMB}, runOnce: ${runOnce}\n`);
   cmd(freeSpaceTargetMB, runOnce);
   tailLogs();
})();

// EOF
