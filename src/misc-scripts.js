// miscellaneous unsorted scripts

(() => { // $sample expression testing
   let dbName = 'database', collName = 'collection';
   let namespace = db.getSiblingDB(dbName).getCollection(collName),
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
         // { "$sample": { "size": 1000 } } // factory default works as expected
         // { "$sample": { "size": "$$sampleN" } } // fails
         { "$sample": { "size": { "$expr": "$$sampleN" } } } // fails
      ];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => {
   let dbName = 'database', collName = 'collection';

   let namespace = db.getSiblingDB(dbName).getCollection(collName),
      sampleCap = 50000, // 50K
      collSize = namespace.estimatedDocumentCount(),
      collCap = 2000000, // 2M
      rndCursorLimit = 0.049, // 4.9%
      sampleSize = (collSize <= sampleCap) ? collSize
                 : (collSize <= collCap) ? collSize * rndCursorLimit
                 : sampleCap;

   let options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" }
      },
      pipeline = [
         { "$sample": { "size": sampleSize } }
      ];

   namespace.aggregate(pipeline, options).forEach(printjson);
})();

(() => { // collmod validators
   let dbName = 'database', collName = 'collection';
   let db = db.getSiblingDB(dbName),
      validatorLevel = 'moderate', validatorActions = 'warn', validator = { "$jsonSchema": { } };

   db.runCommand({
      "collMod": collName,
      "validator": validator,
      "validationLevel": validatorLevel,
      "validationAction": validatorActions
   });

   db.getCollectionInfos({ "name": collName })[0]['options'];
   // db.getCollectionInfos({ "name": collName })[0]['options']['validator'];
   // db.getCollectionInfos({ "name": collName })[0]['options']['validationLevel'];
   // db.getCollectionInfos({ "name": collName })[0]['options']['validationAction'];
})();

(() => { // stringify $function
   let dbName = 'database', collName = 'collection';
   let db = db.getSiblingDB(dbName);
   let namespace = db.getCollection(collName);
   let options = {
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

   let view = 'view';
   db.createView(view, collName, pipeline);
})();

(() => { // JSON parser $function
   let dbName = 'database', collName = 'collection';
   let namespace = db.getSiblingDB(dbName).getCollection(collName),
      options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": "JOSN parser aggregation query"
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
   let dbName = 'database', collName = 'collection';
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
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

(() => { // connections counter script v1
   let readPref = 'primary';
   db.getMongo().setReadPref(readPref);
   let filter = { "$all": true, "connectionId": { "$gt": 0 } },
      reducer = (accumulator, connection) => {
         group = (typeof connection.shard === 'undefined') ? connection.host : connection.shard;
         accumulator[group] = (accumulator[group] || 0) + 1;
         ++accumulator['TOTAL_CONNECTION_COUNT'];
         if (connection['active'] === true)
            ++accumulator['TOTAL_ACTIVE_CONNECTION_COUNT']
         else
            ++accumulator['TOTAL_IDLE_CONNECTION_COUNT']

         return accumulator;
      },
      initial = { 'TOTAL_CONNECTION_COUNT': 0, 'TOTAL_ACTIVE_CONNECTION_COUNT': 0, 'TOTAL_IDLE_CONNECTION_COUNT': 0 };

   db.currentOp(filter).inprog.reduce(reducer, initial);
})();

(() => { // connections counter script new
   let readPref = 'primary';
   db.getMongo().setReadPref(readPref);
   let filter = { "$all": true, "connectionId": { "$gt": 0 } },
      reducer = (accumulator, connection) => {
         group = (typeof connection.shard === 'undefined') ? connection.host : connection.shard;
         accumulator[group] = (accumulator[group] || 0) + 1;
         ++accumulator['TOTAL_CONNECTION_COUNT'];
         if (connection['active'] === true)
            ++accumulator['TOTAL_ACTIVE_CONNECTION_COUNT']
         else
            ++accumulator['TOTAL_IDLE_CONNECTION_COUNT']

         return accumulator;
      },
      initial = { 'TOTAL_CONNECTION_COUNT': 0, 'TOTAL_ACTIVE_CONNECTION_COUNT': 0, 'TOTAL_IDLE_CONNECTION_COUNT': 0 };

   db.currentOp(filter).inprog.reduce(reducer, initial);
})();

(() => { // count by client app metadata on mongos
   let options = {
         "cursor": { "batchSize": 0 },
         "comment": "$currentOp command to count mongos connections by client metadata"
      },
      currentOpFilter = [
         { "$currentOp": { "allUsers": true, "localOps": true, "idleConnections": true } },
         { "$match": { "connectionId": { "$gt": 0 } } },
         { "$group": { "_id": "$appName", "count": { "$sum": 1 } } },
         { "$project": { "_id": 0, "Client metadata": "$_id", "Total": "$count" } }
      ];

   db.getSiblingDB('admin').aggregate(currentOpFilter, options).forEach(printjson);
})();

(() => { // Validate namespace concurrently (sync script)
   db.getMongo().getDBNames().filter(dbs => dbs.match(/^(?!(admin|config|local)$)/)).map(dbName =>
      db.getSiblingDB(dbName).getCollectionNames().filter(collections => collections.match(/^(?!(system\.))/)).map(collName =>
         printjson(db.getCollection(collName).validate())));
})();

(async() => {  // Validate namespace concurrently (async script)
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
      { "$currentOp": { } },
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
   let cores = (typeof db.hostInfo().system.numCores !== 'undefined') ? db.hostInfo().system.numCores : 16; // else max 16 is probably a good default

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
   let isSystemUser = context.runningAsSystem();
   if (isSystemUser) {
      // console.log('Running function in system context');
      let cluster = 'cluster', dbName = 'database', collName = 'collection', mergedColl = 'hash_count';
      let offset = 1 * (24 * 3600 * 1000); // 1 day (in milliseconds),
         collection = context.services.get(cluster).db(dbName).collection(collName),
         pipeline = [
            { "$match": { "$expr": { "$gte": ["$creation_date", { "$subtract": ["$$NOW", offset] }] } } },
            { "$merge": { "into": mergedColl } }
         ];
      // console.log('Running the $merge pipeline...');
      return collection.aggregate(pipeline).toArray()
         .then(result => {
            if (result.length > 0) {
               console.log(`Merged with result: ${result}`);
               return result.length;
            } else {
               console.log(`Successfully merged`);
               return true;
            }
         })
         .catch(err => console.error(`$merge failed: ${err}`));
   } else {
      throw Error('This user is not allowed to execute the system function');
   }
};

(() => { // reproduction for javascript BSON types 13 & 15
   let batch = [
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

   let dbName = 'database', collName = 'collection';
   let namespace = db.getSiblingDB(dbName).getCollection(collName),
      options = {
         "readConcern": { "level": "local" },
         "comment": "reproduction for javascript BSON types 13 & 15"
      },
      pipeline = [{
         "$project": {
            "_id": 0,
            "name": 1,
            "type": { "$type": "$js" },
            "js": 1
      } }];

   db.getMongo().setReadPref('primary');

   namespace.drop();
   namespace.insertMany(batch);
   namespace.aggregate(pipeline, options);
})();

(() => { // replset config changes, rename replset hosts
   let hosts = ["host1:27017", "host2:27018", "host3:27019"];
   rs.reconfig({
      ...rs.conf(),
      "members": rs.conf().members.map(member => ({
         ...member,
         "host": hosts[member._id],
      }))
   });
})();

(() => { // replset config changes, set split-horizon mappings
   let horizons = [
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

db.adminCommand({ "currentOp": true, "active": true }).inprog.forEach(op => {
   if (typeof op.progress !== 'undefined') printjson({ "message": op.msg })
});

db.adminCommand({ "currentOp": true, "active": true, "progress": true }).inprog.forEach(op =>
   printjson({ "message": op.msg })
);

(() => { // template
   let dbName = 'database';
   db.adminCommand({
      "currentOp": true,
      // "$ownOps": true,
      "active": true,
      "ns": { "$regex": `^${dbName}\.` },
      "$or": [
         { "op": "command", "command.createIndexes": { "$exists": true } },
         { "op": "none", "msg": /^Index Build/ }
      ]
   }).inprog.forEach(op =>
      printjson({ "message": op.msg })
   );
})();

db.runCommand({ "connectionStatus": 1, "showPrivileges": true });

(() => { // template
   db.adminCommand({
      "currentOp": true,
      "active": true,
      "ns": { "$regex": `^${dbName}\.` },
      "command.validate": { "$exists": true }
   }).inprog.forEach(op => 
      print("Currently validating:", op.command['$db'], op.command.validate, "for", op.secs_running, "seconds")
   );
})();

(() => { // template
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": { } },
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
      { "$currentOp": { } },
      { "$match": { "active": true } }
   ]).forEach(op =>
      print('\nCurrent multi-document transactions:',
            'TXN:', op.transaction.parameters.txnNumber,
            'Participating shards', printjson(op.transaction.participants)
   ));
})();

// indexing build

(() => { // template
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

let currentOp = {
   "currentOp": true,
   "$all": true,
   "$expr": {
      "$filter": {
         "input": "$cursor.originatingCommand.pipeline",
         "as": "pipeline",
         "cond": { "$eq": [{ "$getField": { "$literal": "$$pipeline.$changeStream" } }, true] }
} } };
db.adminCommand(currentOp).inprog.forEach(op => printjson({ "Application": op.appName, "Source": op.client, "User": op.runBy }));

db.getSiblingDB('local').getCollection('oplog.rs').aggregate([{ "$match": {} }]).forEach(printjson);

(() => {
   let dbName = 'database', collName = 'collection';
   let changeStream = db.getSiblingDB(dbName).getCollection(collName).watch();

   while (!changeStream.isClosed()) {
      if (changeStream.tryNext()) {
         printjson(changeStream.next());
         // printjson(changeStream);
   } }

   let watchCursor = db.getMongo().watch([{ "$match": { } }]);
   while (!watchCursor.isClosed()) {
      let next = watchCursor.tryNext();
      while (next !== null) {
         printjson(next);
         next = watchCursor.tryNext();
   } }
})();

(async() => {
   let dbName = 'database', collName = 'collection';
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
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
   let dbName = 'database', collName = 'collection';
   db.getSiblingDB(dbName).runCommand({ "compact": collName });

   db.adminCommand({ "getLog": "global" }).log.filter(line => line.match(/[Cc]ompact/)).map(entry => console.log(entry));

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

(() => { // template
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
      let shardedNamespaces = db.getSiblingDB('config')
                                .getCollection('collections')
                                .find({
                                    "_id": /^(?!(config\.))/,
                                    "dropped": { "$ne": true }
                                 },
                                 { "_id": 1 }
                              ).toArray(),
         { shards } = db.adminCommand({ "listShards": 1 }),
         sleepInterval = 2000, // ms
         result;
      print('\nSharded collections:');
      shardedNamespaces.forEach(namespace => print(`\t${namespace._id}`));
      print('\nShards:');
      shards.forEach(shard => print(`\nID: ${shard._id} with: ${shard.host}`));
      shards.forEach(shard => {
         print(`\nConnecting to: ${shard._id}`);
         // let { setName, seedList } = shard.host.match(/(?<setName>\w+)\/(?<seedList>.+)/).groups,
         let [, setName, seedList] = shard.host.match(/(\w+)\/(.+)/),
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
   let dbName = 'database';
   let collName = 'collection';
   let idxName = '_id';

   let initialCacheSize, delta;
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   let cacheSizeBytes = () => db.serverStatus().wiredTiger.cache['bytes belonging to page images in the cache'];

   // cache pre-warming for collection
   initialCacheSize = cacheSizeBytes.call();
   let { documentsScanned, objectSizeBytes } = namespace.aggregate(
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

/*
 *  report stale indexes
 */
(() => {
   let dbName = 'database', collName = 'collection';
   let idxAge = 24 * 3600 * 1000; // 24hrs in millis
   let indexes = db.getSiblingDB(dbName).getCollection(collName).aggregate(
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
   for (let { name, accesses } of indexes) {
      let since = (accesses.ops < 1) ? 'never since startup' : accesses.since;
      console.log(`Index ${name} last accessed ${since}`);
   }
})();

// connection count per client

(() => {
   db.getSiblingDB('admin').aggregate([
      { "$currentOp": {
         "allUsers": true,
         "localOps": false, // set true for mongos
         "idleConnections": true
      } },
      { "$match": {
         "client": { "$exists": true },
         "$nor": [
            { "command.ismaster": 1 },
            { "command.hello": true }
         ]
      } },
      { "$group": {
         "_id": {
            "user": "$effectiveUsers.user",
            "client": { "$first": { "$split": ["$client", ":"] } },
            "appName": "$appName",
            "active": "$active"
         },
         "count": { "$count": {} }
      } },
      { "$sort": { "_id": 1 } },
      { "$project": {
         "_id": 0,
         "user": "$_id.user",
         "client": "$_id.client",
         "appName": "$_id.appName",
         "active": "$_id.active",
         "count": 1
      } }
   ]);
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
   let datasets = Mongo('mongodb://localhost:27017'),
      superpowers = Mongo('mongodb://localhost:27018'),
      movies1 = datasets.getSiblingDB('sample_mflix').getCollection('movies'),
      movies2 = superpowers.getSiblingDB('sample_mflix').getCollection('movies'),
      cursor1 = movies1.find().sort({ "_id": 1 }),
      cursor2 = movies2.find().sort({ "_id": 1 }),
      i = 0, doc;

   while (doc = cursor1.next()) {
      let otherDoc = cursor2.next();
      ((++i % 1000) === 0) && console.log(`compared ${i} docs`);
      (!util.isDeepStrictEqual(doc, otherDoc)) && console.log(`doc mismatch ${doc} ${otherDoc}`);
   }
})();

// bin subtype eval

(() => {
   let dbName = 'admin';
   let namespace = db.getSiblingDB(dbName);
   let options = {
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
   let dbName = 'database', collName = 'collection';
   let { count } = db.getSiblingDB(dbName).getCollection(collName).stats();
   let sampleSize = 5;
   let sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   let sample = db.getSiblingDB(dbName).runCommand({
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
   let dbName = 'database', collName = 'collection';
   let database = db.getSiblingDB(dbName);
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   let { count } = namespace.stats();
   let sampleSize = 1000;
   let sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   let samplerCmd = {
      "find": collName,
      "filter": { "$sampleRate": sampleRate },
      "hint": "_id_",
      "readOnce": true,
      "limit": sampleSize,
      // "returnKey": true,
      "comment": "sampling with readOnce cursor option"
   };
   let { 'executionStats': samplerCmdStats } = database.runCommand({
      "explain": samplerCmd,
      "verbosity": "executionStats",
      "comment": "psuedo-sampler stats"
   });
   printjson(samplerCmdStats);
})();

// by distribution

(() => {
   let dbName = 'database', collName = 'collection';
   let database = db.getSiblingDB(dbName);
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   // let { count } = namespace.stats();
   let sampleSize = 1000;
   // let sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   // let bucketSize = Math.ceil(count / sampleSize); // 64;
   let explainPlan = 'executionStats'; // ['queryPlanner'|'executionStats'|'allPlansExecution']
   let options = {
      "allowDiskUse": true,
      "cursor": { "batchSize": sampleSize },
      "readConcern": { "level": "local" },
      "hint": { "_id": 1 },
      "comment": "sampling with readOnce cursor option",
   };
   let pipeline = [
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
   let { 'stages': [{ '$cursor': { 'executionStats': bucketStats } }] } = namespace.explain(explainPlan).aggregate(pipeline, options);
   printjson(bucketStats);
   let buckets = namespace.aggregate(pipeline, options).toArray().map(id => { return id['_id'] });
   // printjson(buckets);
   let samplerCmd = {
      "find": collName,
      "filter": { "_id": { "$in": buckets } },
      // "hint": "_id_",
      "readOnce": true,
      "readConcern": { "level": "local" },
      "comment": "sampling with readOnce cursor option"
   };
   let { 'executionStats': samplerCmdStats } = database.runCommand({
      "explain": samplerCmd,
      "verbosity": "executionStats",
      "comment": "psuedo-sampler stats"
   });
   printjson(samplerCmdStats);
})();

(() => {
   let dbName = 'database', collName = 'collection';
   let database = db.getSiblingDB(dbName);
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   // let { count } = namespace.stats();
   let sampleSize = 1000;
   // let sampleRate = (sampleSize * 1.1) / count; // oversample slightly to round out nearer to the expected sample size
   // let bucketSize = Math.ceil(count / sampleSize); // 64;
   let explainPlan = 'executionStats'; // ['queryPlanner'|'executionStats'|'allPlansExecution']
   let options = {
      "allowDiskUse": true,
      "cursor": { "batchSize": sampleSize },
      "readConcern": { "level": "local" },
      // "hint": { "_id": 1 },
      "comment": "sampling with readOnce cursor option",
   };
   let pipeline = [
      { "$sample": { "size": sampleSize } },
   ];
   // let { 'stages': [{ '$cursor': { 'executionStats': bucketStats } }] } = namespace.explain(explainPlan).aggregate(pipeline, options);
   let bucketStats = namespace.explain(explainPlan).aggregate(pipeline, options);
   printjson(bucketStats);
})();

// EOF
