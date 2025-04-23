(() => {
   /*
    *  Name: "autoCompact.js"
    *  Version: "0.1.0"
    *  Description: "autoCompact() with log monitoring"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - customise command options "freeSpaceTargetMB" and/or "runOnce" if required
    *  - mongosh only
    */

   // Syntax: mongosh [direct host connection options] [--quiet] [--eval 'const freeSpaceTargetMB = 1, runOnce = true;'] [-f|--file] autoCompact.js

   // Example:
   /*
    *  mongosh "localhost:27017" --quiet --eval 'const freeSpaceTargetMB = 64, runOnce = true;' -f autoCompact.js
    */
   const __script = { "name": "autoCompact.js", "version": "0.1.0" };

   const cmd = (freeSpaceTargetMB = 1, runOnce = true) => db.adminCommand({
      "autoCompact": true,
      "freeSpaceTargetMB": freeSpaceTargetMB,
      "runOnce": runOnce
   });
   const tailLogs = () => {
      let t = ISODate();
      let pause = 0;
      let msg = '';
      // expected to be the last namespace
      const stop = 'sizeStorer.wt: there is no useful work to do - skipping compaction';
      const getLogs = t => db.adminCommand(
         { "getLog": "global" }
      ).log.map(
         EJSON.parse
      ).filter(log => {
         return log?.attr?.message?.session_name == 'WT_SESSION.compact' && log?.t > t
      });

      do {
         const logs = getLogs(t);
         if (logs.length) {
            logs.forEach(log => {
               t = log?.t ?? ISODate();
               msg = log?.attr?.message?.msg ?? '';
               console.log(t.toJSON(), msg);
            });
            pause = 0; // reset pause when logs are found
         } else if (!pause) {
            console.log('\n-----Waiting for new logs, hit CTRL+C to break-----\n');
            pause = 1; // set pause to prevent repeated messages
         }
         sleep(100);
      } while (msg !== stop);
      console.log('\n-----autoCompaction round complete-----\n');
   }

   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${this.version()}\x1b[0m`);
   console.log(`\nautoCompact() command options freeSpaceTargetMB ${freeSpaceTargetMB ?? 1}, runOnce: ${runOnce ?? true}\n`);
   cmd(freeSpaceTargetMB ?? 1, runOnce ?? true);
   tailLogs();
})();

// EOF
