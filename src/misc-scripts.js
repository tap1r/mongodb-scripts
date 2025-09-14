/*
 *  miscellaneous unsorted scripts
 */

(() => {
   /*
    * $sample expression testing
    */
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName),
      sampleSize = 4.9, // percentage
      options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": "$sample expression testing",
         "let": { // Added in MongoDB v5.0
            "sampleN": Math.floor((sampleSize / 100) * namespace.estimatedDocumentCount())
      } },
      pipeline = [
         // { "$addFields": { "_sampleSize": "$$sampleN" } }, // fails
         // { "$sample": { "size": "$_sampleSize" } } // fails
         { "$sample": { "size": 1000 } } // factory default works as expected
         // { "$sample": { "size": "$$sampleN" } } // fails
         // { "$sample": { "size": { "$expr": "$$sampleN" } } } // fails
      ];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => {
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName),
      sampleCap = 50000, // 50K
      collSize = namespace.estimatedDocumentCount(),
      collCap = 2000000, // 2M
      rndCursorLimit = 0.049, // 4.9%
      sampleSize = (collSize <= sampleCap) ? collSize
                 : (collSize <= collCap) ? collSize * rndCursorLimit
                 : sampleCap;

   const options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" }
      },
      pipeline = [
         { "$sample": { "size": sampleSize } }
      ];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => { // collmod validators
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName),
      validatorLevel = 'moderate',
      validatorActions = 'warn',
      validator = { "$jsonSchema": {} };

   console.log(namespace.runCommand({
      "collMod": collName,
      "validator": validator,
      "validationLevel": validatorLevel,
      "validationAction": validatorActions
   }));

   console.log(namespace.getCollectionInfos({ "name": collName })[0]['options']);
   // console.log(namespace.getCollectionInfos({ "name": collName })[0]['options']['validator']);
   // console.log(namespace.getCollectionInfos({ "name": collName })[0]['options']['validationLevel']);
   // console.log(namespace.getCollectionInfos({ "name": collName })[0]['options']['validationAction']);
})();

(() => { // stringify $function
   const dbName = 'database', collName = 'collection';
   const dbHandle = db.getSiblingDB(dbName);
   const namespace = db.getCollection(collName);
   const options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": "Stringification aggregation query"
      },
      pipeline = [{
         "$project": {
            "_id": 0,
            "stringified": {
               "$function": {
                  "body": `function(document) { return JSON.stringify(document) }`,
                  "args": ["$$ROOT"],
                  "lang": "js"
      } } } }];

   namespace.aggregate(pipeline, options).forEach(printjson);

   const view = 'view';
   dbHandle.createView(view, collName, pipeline);
})();

(() => { // JSON parser $function
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName),
      options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": "JSON parser aggregation query"
      },
      pipeline = [{
         "$project": {
            "_id": 0,
            "stringified": {
               "$function": {
                  "body": `function(document) { return JSON.parse(document) }`,
                  "args": ["$$ROOT"],
                  "lang": "js"
      } } } }];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => { // localtime date match on ObjectID
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
      options = {
         "comment": "Aggregation pipeline to match localtime",
         "let": {
            "today": ObjectId(
               (Date.parse(
                  new Date().toLocaleString("en-US", {
                     "year": "numeric",
                     "month": "long",
                     "day": "numeric",
                     "timeZone": "Australia/Sydney"
                  }) + ' 00:00:00 UTC+10'
               )/1000.0|0).toString(16) + '0000000000000000')
      } },
      pipeline = [
         { "$match": { "$expr": { "$gte": ["$_id", "$$today"] } } },
         { "$project": { "_id": 1 } }
      ];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => { // Validate namespace concurrently (sync script)
   db.getMongo().getDBNames().filter(dbs => dbs.match(/^(?!(admin|config|local)$)/)).map(dbName =>
      db.getSiblingDB(dbName).getCollectionNames().filter(collections => collections.match(/^(?!(system\.))/)).map(collName =>
         printjson(db.getCollection(collName).validate())));
})();

(async() => { // Validate namespace concurrently (async script)
   db.getMongo().getDBNames().filter(dbs => dbs.match(/^(?!(admin|config|local)$)/)).map(dbName =>
      db.getSiblingDB(dbName).getCollectionNames().filter(collections => collections.match(/^(?!(system\.))/)).map(async collName => {
         print('\nDB:', dbName, 'Collection:', collName);
         let result;
         try { result = db.getSiblingDB(dbName).getCollection(collName).validate(); }
         catch(e) { result = e; }
         return printjson(result);
   }));
})();

(() => { // op monitoring script
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {} },
      { "$match": {
         "active": true,
         "op": "command",
         "command.validate": { "$exists": true }
      } }
   ]).forEach(op =>
      print('\nCurrently validating namespace:',
         op.command['$db'] + '.' +
         op.command.validate, 'for',
         +op.secs_running, 'seconds')
   );
})();

(async() => { // op monitoring script, refactored async script - testing w/concurrency
   const cores = (typeof db.hostInfo().system.numCores !== 'undefined') ? db.hostInfo().system.numCores : 16; // else max 16 is probably a good default

   db.getMongo().getDBNames().filter(dbs => dbs.match(/^(?!(admin|config|local)$)/)).map(dbName =>
      db.getSiblingDB(dbName).getCollectionNames().filter(collections => collections.match(/^(?!(system\.))/)).map(async collName => {
         console.log(`\n\tDB: ${dbName}\tCollection: ${collName}`);
         let result;
         try { result = db.getSiblingDB(dbName).getCollection(collName).validate() }
         catch(e) { result = e }
         return printjson(result);
   }));
})();

exports = function() { // Sample trigger to update a materialised view
   // console.log('Start of function');
   const isSystemUser = context.runningAsSystem();
   if (isSystemUser) {
      // console.log('Running function in system context');
      const cluster = 'cluster', dbName = 'database', collName = 'collection', mergedColl = 'hash_count';
      const offset = 1 * (24 * 3600 * 1000); // 1 day (in milliseconds),
         collection = context.services.get(cluster).db(dbName).collection(collName),
         pipeline = [
            { "$match": { "$expr": { "$gte": ["$creation_date", { "$subtract": ["$$NOW", offset] }] } } },
            { "$merge": { "into": mergedColl } }
         ];
      // console.log('Running the $merge pipeline...');
      return collection.aggregate(pipeline).toArray()
         .then(result => {
            if (result.length > 0) {
               console.log('Merged with result:', result);
               return result.length;
            } else {
               console.log('Successfully merged');
               return true;
            }
         })
         .catch(err => console.error('$merge failed:', err));
   } else {
      throw Error('This user is not allowed to execute the system function');
   }
};

(() => { // reproduction for javascript BSON types 13 & 15
   const batch = [
      { "name": "Javascript type 13", "js": Code(function(){}) },
      { "name": "Javascript type 13", "js": Code(() => {}) },
      { "name": "Javascript type 13", "js": Code("function(){}") },
      { "name": "Javascript type 13", "js": Code("() => {}") },
      { "name": "Javascript type 15", "js": Code(function(){}, { "scope": true }) },
      { "name": "Javascript type 15", "js": Code(() => {}, { "scope": false }) },
      { "name": "Javascript type 15", "js": Code("function(){}", { "scope": true }) },
      { "name": "Javascript type 15", "js": Code("() => {}", { "scope": false }) },
      { "name": "Javascript type 15", "js": Code(function(){}, {}) },
      { "name": "Javascript type 15", "js": Code(() => {}, {}) },
      { "name": "Javascript type 15", "js": Code("function(){}", {}) },
      { "name": "Javascript type 15", "js": Code("() => {}", {}) },
      { "name": "Javascript type unknown?", "js": Code("function(){}", undefined) },
      { "name": "Javascript type unknown?", "js": Code("() => {}", { }) },
      { "name": "Javascript type unknown?", "js": Code("() => {}", null) },
      { "name": "Javascript type unknown?", "js": Code("() => {}", []) }
   ];

   const dbName = 'database', collName = 'jsTypes';
   const namespace = db.getSiblingDB(dbName).getCollection(collName),
      options = {
         "readConcern": { "level": "local" },
         "comment": "reproduction for javascript BSON types 13 & 15"
      },
      pipeline = [
         { "$project": {
            "_id": 0,
            "name": 1,
            "type": { "$type": "$js" },
            "js": 1
         } }
      ];

   db.getMongo().setReadPref('primary');

   namespace.drop();
   namespace.insertMany(batch);
   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => { // replset config changes, rename replset hosts
   const hosts = ["host1:27017", "host2:27018", "host3:27019"];
   rs.reconfig({
      ...rs.conf(),
      "members": rs.conf().members.map(member => ({
         ...member,
         "host": hosts[member._id]
      }))
   });
})();

(() => { // replset config changes, set split-horizon mappings
   const horizons = [
      { "external": "external:37017" },
      { "external": "external:37018" },
      { "external": "external:37019" }
   ];
   rs.reconfig({
      ...rs.conf(),
      "members": rs.conf().members.map(member => ({
         ...member,
         "horizons": horizons[member._id]
      }))
   });
})();

// new stuff

(() => { // IIFE template
   // 
})();

// currentOp usage examples

(() => { // template
   const dbName = 'database';
   db.adminCommand({
      "currentOp": true,
      // "$ownOps": true,
      "active": true,
      "ns": { "$regex": `^${dbName}\.` },
      "$or": [
         { "op": "command", "command.createIndexes": { "$exists": true } },
         { "op": "none", "msg": /^Index Build/ }
      ]
   }).inprog.forEach(({ msg = '' }) =>
      printjson({ "message": msg })
   );
})();

(() => {
   /*
    * connectionStatus to show auth'd user with roles
    */
   console.log(db.adminCommand({ "connectionStatus": 1, "showPrivileges": true }));
})();

(() => { // legacy currentOp cmd template
   db.adminCommand({
      "currentOp": true,
      "active": true,
      "ns": { "$regex": `^${dbName}\.` },
      "command.validate": { "$exists": true }
   }).inprog.forEach(op => 
      print("Currently validating:", op.command['$db'], op.command.validate, "for", op.secs_running, "seconds")
   );
})();

(() => { // $currentOp cmd template
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {} },
      { "$match": {
         "active": true,
         "op": "command",
         "command.validate": { "$exists": true }
      } }
   ]).forEach(op =>
      print('\nCurrently validating namespace:',
         op.command['$db'] + '.' +
         op.command.validate, 'for',
         +op.secs_running, 'seconds')
   );
})();

// cross shard transaction op monitoring script

(() => { // template
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {} },
      { "$match": { "active": true } }
   ]).forEach(op =>
      print('\nCurrent multi-document transactions:',
         'TXN:', op.transaction.parameters.txnNumber,
         'Participating shards', printjson(op.transaction.participants)
   ));
})();

// indexing build

(() => { // monitor index builds
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {
         "allUsers": true,
         "idleSessions": true
      } },
      { "$match": {
         "$or": [{
            "op": "command",
            "command.createIndexes": { "$exists": true }
         },{
            "op": "none",
            "msg": /^Index Build/
         }]
      } }
   ]);
})();

// change stream monitoring script 

(() => {
   const dbName = 'database', collName = 'collection';
   let changeStream = db.getSiblingDB(dbName).getCollection(collName).watch();

   while (!changeStream.isClosed()) {
      if (changeStream.tryNext()) {
         printjson(changeStream.next());
         // printjson(changeStream);
   } }

   let watchCursor = db.getMongo().watch([{ "$match": {} }]);
   while (!watchCursor.isClosed()) {
      let next = watchCursor.tryNext();
      while (next !== null) {
         printjson(next);
         next = watchCursor.tryNext();
   } }
})();

(async() => {
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   let watchCursor; // scope the watcher

   async function main() {
      /*
       *  main
       */
      namespace.deleteOne({ "a": 1 }); // clear any existing document
      changeStream(); // create changeStream cursor
      watcher(); // changeStream event watcher
      workload(); // generate some interesting ops
   }

   function changeStream() {
      /*
       *  open the changeStream cursor and attach it
       */
      watchCursor = namespace.watch(
         [
            { "$match": {
               "operationType": {
                  "$in": ["insert", "update"]
            } } }
         ],
         { "fullDocument": "updateLookup" }
      );
   }

   async function watcher() {
      /*
       *  async monitor for change events
       */
      while (!watchCursor.isClosed()) {
         let next = watchCursor.tryNext();
         while (next !== null) {
            console.log(util.inspect(
               {
                  "operationType": next?.operationType ?? null,
                  "fullDocument": next?.fullDocument ?? null,
               },
               { "depth": null, "colors": true, "compact": false }
            ));
            next = watchCursor.tryNext();
         }
      }
   }

   function workload() {
      /*
       *  generate some ops
       */
      namespace.insertOne({ "a": 1, "b": 0 });
      namespace.updateOne({ "a": 1 }, [{ "$set": { "b": 1 } }]);
   }

   await main();
})();

// Running and monitoring compact()

(() => { // template
   const dbName = 'database', collName = 'collection';
   db.getSiblingDB(dbName).runCommand({ "compact": collName });

   db.adminCommand({ "getLog": "global" }).log.filter(line => line.match(/[Cc]ompact/)).forEach(console.log);

   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {} },
      { "$match": {
         "active": true,
         "op": "command",
         "command.compact": { "$exists": true }
      } }
   ]).forEach(({ command }) =>
      print('\nCurrently compacting namespace:',
         command['$db'] + '.' +
         command.compact)
   );
})();

// monitoring $sample

(() => { // monitor mongoslqd sampling
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {} },
      { "$match": {
         "active": true,
         "appName": "mongosqld",
         "command.pipeline.$sample": { "$exists": true }
      } }
   ]).forEach(({ ns, secs_running }) =>
      print(`\nmongosqld currently sampling namespace: ${ns} for ${+secs_running} seconds`)
   );
})();

// clean orphans shard connecting script
(() => {
   if (db.serverStatus().process !== 'mongos') {
      print('\n\tMust be connected via a mongos!\n');
   } else {
      const shardedNamespaces = db.getSiblingDB('config')
                                  .getCollection('collections')
                                  .find({
                                       "_id": /^(?!(config\.))/,
                                       "dropped": { "$ne": true }
                                    },
                                    { "_id": 1 }
                                 ).toArray(),
         { shards } = db.adminCommand({ "listShards": 1 }),
         sleepInterval = 2000; // ms
      let result;
      print('\nSharded collections:');
      shardedNamespaces.forEach(namespace => print(`\t${namespace._id}`));
      print('\nShards:');
      shards.forEach(shard => print(`\nID: ${shard._id} with: ${shard.host}`));
      shards.forEach(shard => {
         print(`\nConnecting to: ${shard._id}`);
         // let { setName, seedList } = shard.host.match(/(?<setName>\w+)\/(?<seedList>.+)/).groups,
         const [, setName, seedList] = shard.host.match(/(\w+)\/(.+)/),
            uri = `mongodb://${seedList}/?replicaSet=${setName}&readPreference=primary`,
            shardPrimary = new Mongo(uri).getDB('admin');
         shardedNamespaces.forEach(namespace => {
            print(`\nExecuting cleanupOrphaned on:\t${namespace._id}\n`);
            let nextKey = {}, runCmd = {};
            while (typeof nextKey !== 'undefined') {
               runCmd = { "cleanupOrphaned": namespace._id, "startingFromKey": nextKey };
               try {
                  result = shardPrimary.runCommand(runCmd);
               } catch(error) {
                  throw error;
               } finally {
                  printjson(result);
               }

               nextKey = result.stoppedAtKey;
               if (typeof nextKey !== 'undefined') {
                  print(`\nShard cleaning complete, now waiting for ${sleepInterval}ms...\n`);
                  sleep(sleepInterval);
               } else {
                  print('\nShard cleaning complete, moving on to the next shard...\n');
               }
            }
         });
      });
      print('\n...complete!\n');
   }
})();

// Index usage management

(() => {
   /*
    *  cache pre-warming script
    */
   const dbName = 'database';
   const collName = 'collection';
   const idxName = '_id';

   let initialCacheSize, delta;
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const cacheSizeBytes = () => db.serverStatus().wiredTiger.cache['bytes belonging to page images in the cache'];

   // cache pre-warming for collection
   initialCacheSize = cacheSizeBytes.call();
   const { documentsScanned, objectSizeBytes } = namespace.aggregate(
      { "$match": {} },
      { "$group": {
         "_id": null,
         "documentsScanned": { "$sum": 1 },
         "objectSizeBytes": { "$sum": { "$bsonSize": "$$ROOT" } }
      } },
      { "$project": { "_id": 0 } }
   ).toArray()[0];
   delta = cacheSizeBytes.call() - initialCacheSize;
   console.log(`\n`);
   console.log(`Warming cache for "${dbName}.${collName}" documents:`);
   console.log(`\tscanned ${documentsScanned} documents`);
   console.log(`\ttotal: ${objectSizeBytes} bytes`);
   console.log(`\tchange in WT cache size: ${delta} bytes`);
   console.log(`\n`);

   // cache pre-warming for index
   initialCacheSize = cacheSizeBytes.call();
   let { indexKeysScanned, indexSizeBytes } = namespace.aggregate(
      { "$match": {
         [idxName]: { "$gte": MinKey, "$lte": MaxKey }
      } },
      { "$project": { [idxName]: 1 } },
      { "$group": {
         "_id": null,
         "indexKeysScanned": { "$sum": 1 },
         "indexSizeBytes": { "$sum": { "$bsonSize": "$$ROOT" } }
      } },
      { "$project": { "_id": 0 } }
   ).toArray()[0];
   delta = cacheSizeBytes.call() - initialCacheSize;
   console.log(`\n`);
   console.log(`Warming cache for "${dbName}.${collName}" index "${idxName}":`);
   console.log(`\tscanned ${indexKeysScanned} keys`);
   console.log(`\ttotal: ${indexSizeBytes} bytes`);
   console.log(`\tchange in WT cache size: ${delta} bytes`);
   console.log(`\n`);
})();

(() => {
   /*
    *  report stale indexes
    */
   const dbName = 'database', collName = 'collection';
   const idxAge = 24 * 3600 * 1000; // 24hrs in millis
   const indexes = db.getSiblingDB(dbName).getCollection(collName).aggregate(
      { "$indexStats": {} },
      { "$match": {
         // "name": "_id_", // explicitly add specific index
         "$or": [
            { "accesses.ops": { "$lt": 1 } }, // never accessed
            { "$expr": { "$lt": ["$accesses.since", { "$subtract": ["$$NOW", idxAge] }] } }
         ],
         "building": { "$ne": true }
      } }
   );
   for (const { name = '', accesses = 0 } of indexes) {
      const since = (accesses.ops < 1) ? 'never since startup' : accesses.since;
      console.log(`Index ${name} last accessed ${since}`);
   }
})();

// filter out fields

EJSON.stringify(Object.fromEntries(Object.entries(db.adminCommand({ "getCmdLineOpts": 1 })).filter(([key]) => key.match(/^(?!(ok|\$clusterTime|operationTime)$)/))));

// with polyfill

if (typeof Object.prototype.fromEntries === 'undefined') {
   Object.fromEntries = entries => {
      if (!entries || !entries[Symbol.iterator])
         { throw new Error('Object.fromEntries() requires a single iterable argument') }
      let obj = {};
      for (let [key, value] of entries)
         { obj[key] = value }
      return obj;
} }

if (typeof Object.prototype.entries === 'undefined') {
   Object.entries = obj => {
      let ownProps = Object.keys(obj),
         i = ownProps.length,
         resArray = new Array(i); // preallocate the Array
      while (i--)
         resArray[i] = [ownProps[i], obj[ownProps[i]]];

      return resArray;
} }

JSON.stringify(Object.fromEntries(Object.entries(db.adminCommand({ "getCmdLineOpts": 1 })).filter(([key]) => key.match(/^(?!(ok|\$clusterTime|operationTime)$)/))));

// concurrent MongoClient()s
(() => {
   const datasets = Mongo('mongodb://localhost:27017'),
      superpowers = Mongo('mongodb://localhost:27018'),
      movies1 = datasets.getSiblingDB('sample_mflix').getCollection('movies'),
      movies2 = superpowers.getSiblingDB('sample_mflix').getCollection('movies'),
      cursor1 = movies1.find().sort({ "_id": 1 }),
      cursor2 = movies2.find().sort({ "_id": 1 });

   let i = 0, doc;

   while (doc = cursor1.next()) {
      let otherDoc = cursor2.next();
      ((++i % 1000) === 0) && console.log(`compared ${i} docs`);
      (!util.isDeepStrictEqual(doc, otherDoc)) && console.log(`doc mismatch ${doc} ${otherDoc}`);
   }
})();

/*
 *  evaluate binary subtype
 */
(() => {
   const dbName = '$';
   const namespace = db.getSiblingDB(dbName);
   const options = {
         "comment": "bin type eval"
      },
      pipeline = [
         { "$documents": [
            {
               "document": 1,
               "bin": BinData(0, UUID().toString('base64')),
               "fle": BinData(6, UUID().toString('base64'))
            },
            {
               "document": 2,
               "bin": BinData(0, UUID().toString('base64')),
               "fle": BinData(6, UUID().toString('base64'))
            },
            {
               "document": 3,
               "bin": BinData(0, UUID().toString('base64')),
               "fle": BinData(6, UUID().toString('base64'))
            }
         ] },
         { "$project": {
            "document": 1,
            "bin": {
               "bson": { "$type": "$bin" },
               "subtype": { "$first": { "$slice": [["$bin"], 0, 1] } }
            },
            "fle": {
               "bson": { "$type": "$fle" },
               "subtype": { "$first": { "$slice": [["$fle"], 0, 1] } }
            }
         } }
      ];

   namespace.aggregate(pipeline, options).forEach(console.log);
})();

/*
 *  $sample substitute using readOnce cursor option
 */
(() => {
   const dbName = 'database', collName = 'collection';
   const { count = 0 } = db.getSiblingDB(dbName).getCollection(collName).stats();
   const sampleSize = 5;
   const sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   const sample = db.getSiblingDB(dbName).runCommand({
      "find": collName,
      "filter": { "$sampleRate": sampleRate },
      "hint": "_id_",
      "readOnce": true,
      "limit": sampleSize,
      // "returnKey": true,
      "comment": "sampling with readOnce cursor option"
   });
   printjson(sample);
})();

(() => {
   const dbName = 'database', collName = 'collection';
   const database = db.getSiblingDB(dbName);
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const { count = 0 } = namespace.stats();
   const sampleSize = 1000;
   const sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   const samplerCmd = {
      "find": collName,
      "filter": { "$sampleRate": sampleRate },
      "hint": "_id_",
      "readOnce": true,
      "limit": sampleSize,
      // "returnKey": true,
      "comment": "sampling with readOnce cursor option"
   };
   const { 'executionStats': samplerCmdStats = null } = database.runCommand({
      "explain": samplerCmd,
      "verbosity": "executionStats",
      "comment": "psuedo-sampler stats"
   });
   printjson(samplerCmdStats);
})();

// by distribution

(() => {
   const dbName = 'database', collName = 'collection';
   const database = db.getSiblingDB(dbName);
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   // const { count } = namespace.stats();
   const sampleSize = 1000;
   // const sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   // const bucketSize = Math.ceil(count / sampleSize); // 64;
   const explainPlan = 'executionStats'; // ['queryPlanner'|'executionStats'|'allPlansExecution']
   const options = {
      "allowDiskUse": true,
      "cursor": { "batchSize": sampleSize },
      "readConcern": { "level": "local" },
      "hint": { "_id": 1 },
      "comment": "sampling with readOnce cursor option"
   };
   const pipeline = [
      { "$bucketAuto": {
         "groupBy": "$_id",
         "buckets": sampleSize, // bucketSize,
         // "output": { "_id": { "$sum": 1 } },
         // "granularity": "POWERSOF2"
      } },
      { "$project": { "_id": "$_id.max" } }
      /* { "$group": {
         "_id": null,
         "total": { "$sum": 1 }
      } } */
   ];
   const { 'stages': [{ '$cursor': { 'executionStats': bucketStats = null } = {} } = {}] = [] } = namespace.explain(explainPlan).aggregate(pipeline, options);
   printjson(bucketStats);
   const buckets = namespace.aggregate(pipeline, options).toArray().map(id => { return id['_id'] });
   // printjson(buckets);
   const samplerCmd = {
      "find": collName,
      "filter": { "_id": { "$in": buckets } },
      // "hint": "_id_",
      "readOnce": true,
      "readConcern": { "level": "local" },
      "comment": "sampling with readOnce cursor option"
   };
   const { 'executionStats': samplerCmdStats = null } = database.runCommand({
      "explain": samplerCmd,
      "verbosity": "executionStats",
      "comment": "psuedo-sampler stats"
   });
   printjson(samplerCmdStats);
})();

(() => {
   const dbName = 'database', collName = 'collection';
   const database = db.getSiblingDB(dbName);
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   // const { count } = namespace.stats();
   const sampleSize = 1000;
   // const sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   // const bucketSize = Math.ceil(count / sampleSize); // 64;
   const explainPlan = 'executionStats'; // ['queryPlanner'|'executionStats'|'allPlansExecution']
   const options = {
      "allowDiskUse": true,
      "cursor": { "batchSize": sampleSize },
      "readConcern": { "level": "local" },
      // "hint": { "_id": 1 },
      "comment": "sampling with readOnce cursor option"
   };
   const pipeline = [
      { "$sample": { "size": sampleSize } }
   ];
   // const { 'stages': [{ '$cursor': { 'executionStats': bucketStats } }] } = namespace.explain(explainPlan).aggregate(pipeline, options);
   const bucketStats = namespace.explain(explainPlan).aggregate(pipeline, options);
   printjson(bucketStats);
})();

// EOF
