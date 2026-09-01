/*
 *  Name: "compact.js"
 *  Version: "0.2.15"
 *  Description: schrödinger's page reproduction
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Legacy archive line: v0.2.15 is the snapshot for this script. Parses under
 *  legacy mongo and mongosh (uninitialized `const reportLog` dropped). Runtime
 *  is mongosh-first (`console.log` before any mdblib load). Further feature
 *  work (dbstats module/JSON contract, discovery fan-out) targets mongosh;
 *  see ROADMAP.md → Legacy mongo shell retirement.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>compact.js

/*
 *  User defined parameters
 */

const options = {
   "dbName": "database",
   "collName": "collection",
   // "n": 25, // = % chance of being matched
   // "pattern": "random",
   "rounds": 1, // iterations of entropy
   "compactions": 1 // iterations of compact
};

(({ dbName, collName, n = 25, rounds = 5, compactions = 1 } = options) => {
   /*
    *  ...
    */
   const __script = { "name": "compact.js", "version": "0.2.15" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);

   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   if (!namespace.exists()) {
      throw `\x1b[31m[ERROR] namespace "${dbName}.${collName}" does not exist\x1b[0m`;
   }

   const randFilter = { "$expr": { "$gt": [n/100, { "$rand": {} }] } };
   // let update = { "$set": { "x": Math.random() } };

   for (let i = 1; i <= rounds; i++) {
      /*
       *  generate dataset with increased entropy
       */
      console.log(`\nRound ${i} of ${rounds}:\tGenerating data`);
      load('fuzzer.js');
      console.log('Pruning data');
      // delete n% of existing documents
      try { namespace.deleteMany(randFilter) }
      catch(e) { console.log(e) }
      /* console.log('\tUpdating data');
      try { namespace.updateMany(randFilter, update) }
      catch(e) { console.log(e) } */
   }

   // Report initial dbStats
   console.log('Gathering initial dbStats');
   load('dbstats.js');

   // Report dbStats pre-compaction
   console.log('Gathering pre-compaction dbStats');
   load('dbstats.js');

   // compact()
   const dbContext = db.getSiblingDB(dbName);
   const compactCmd = { "compact": collName };
   const compactCmdOptions = { "readPreference": "secondary" };
   for (let i = 1; i <= compactions; i++) {
      console.log(`Compacting collection ${i} of ${compactions}`);
      const { bytesFreed } = (shellVer(2.0) && isMongosh())
                           ? dbContext.runCommand(compactCmd, compactCmdOptions)
                           : dbContext.runCommand(compactCmd);

      /*
         db.getSiblingDB('admin').aggregate([
            { "$currentOp": {} },
            { "$match": {
               "active": true,
               "op": "command",
               "command.compact": { "$exists": true }
            } }
         ]).forEach(op =>
            console.log(`\nCurrently compacting namespace: ${op.command['$db']}.${op.command.compact}`)
         );

         const watchCursor = db.getMongo().watch([{ "$match": {} }]);
         while (!watchCursor.isClosed()) {
            let next = watchCursor.tryNext();
            while (next !== null) {
            printjson(next);
            next = watchCursor.tryNext();
            }
         }
      */
      console.log(`bytesFreed: ${bytesFreed}`);
   }

   // Report final dbStats post-compaction
   console.log('Gathering post-compaction dbStats');
   load('dbstats.js');
})();

// EOF
