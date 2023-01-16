/*
 *  Name: "compact.js"
 *  Version: "0.2.2"
 *  Description: schrödinger's page reproduction
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet compact.js"

let options = {
   "dbName": "database",
   "collName": "collection",
   // "n": 25, // = % chance of being matched
   // "rounds": 5, // iterations of entropy
   // "compactions": 1
};

(({ dbName = undefined, collName = undefined,
    n = 25, rounds = 5, compactions = 1 } = {}) => {
   /*
    *  ...
    */
   let __script = { "name": "compact.js", "version": "0.2.2" };
   console.log(`\n---> Running script ${__script.name} v${__script.version}\n`);
   try {
      if (db.getSiblingDB(dbName).getCollectionInfos({ "name": collName }, true)[0]?.name != collName)
         throw 'namespace does not exist';
   } catch(e) {
      console.log(`${dbName}.${collName} ${e}`);
   }
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   let randFilter = { "$expr": { "$gt": [n / 100, { "$rand": {} }] } };
   // let update = { "$set": { "x": Math.random() } };

   for (let i = 1; i <= rounds; ++i) {
      /*
       *  generate dataset with increased entropy
       */
      console.log(`\nRound ${i} of ${rounds}:\tGenerating data`);
      load('fuzzer.js');
      console.log('\tPruning data');
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

   // "touch" documents to force page re-writes

   /*
      console.log('Setting');
      try { namespace.updateMany(updateFilter, setOptions) }
      catch(e) { print(e) }

      console.log('Unsetting');
      try { namespace.updateMany(updateFilter, unsetOptions) }
      catch(e) { print(e) }
   */

   // Report dbStats pre-compaction

   console.log('Gathering pre-compaction dbStats');
   load('dbstats.js');

   // compact()
   for (let i = 1; i <= compactions; ++i) {    
      console.log(`Compacting collection ${i} of ${compactions}`);
      db.getSiblingDB(dbName).runCommand({ "compact": collName });

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
   }

   // Report final dbStats post-compaction

   console.log('Gathering post-compaction dbStats');
   load('dbstats.js');
})(options);

// EOF
