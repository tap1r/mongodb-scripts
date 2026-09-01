/*
 *  Name: "compact.js"
 *  Version: "0.2.16"
 *  Description: schrödinger's page reproduction
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Dual-shell snapshot: legacy/mongo-shell (v0.2.15). This file is mongosh-only.
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>compact.js

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "compact.js", "version": "0.2.16" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
      __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      load(__lib.path);
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   console.log(`\n\n[yellow]${__comment}[/]`);
})();

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
      const { bytesFreed } = shellVer(2.0)
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
