/*
 *  Name: "onlineDefrag.js"
 *  Version: "0.1.1"
 *  Description: "online compaction"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet [-f|--file] onlineDefrag.js"

/*
 *  Custom parameters:
 *  [mongo|mongosh] [connection options] --quiet --eval "let dbName = 'database', collName = 'collection';" [-f|--file] onlineDefrag.js
 */

(async() => {
   const dbName = 'database', collName = 'collection';
   const namespace = db.getSiblingDB(dbName).getCollection(collName);

   const pageFillRatio = 0.9;
   const concurrentUpdatesRatio = 0.005;
   const totalUpdatesRatio = 2; // 10;
   const serverStatusOptions = {
      "activeIndexBuilds": false,
      "asserts": false,
      "batchedDeletes": false,
      "bucketCatalog": false,
      "catalogStats": false,
      "changeStreamPreImages": false,
      "collectionCatalog": false,
      "connections": false,
      "defaultRWConcern": false,
      "electionMetrics": false,
      "encryptionAtRest": false,
      "extra_info": false,
      "featureCompatibilityVersion": false,
      "flowControl": false,
      "globalLock": false,
      "health": false,
      "hedgingMetrics": false,
      "indexBuilds": false,
      "indexBulkBuilder": false,
      "indexStats": false,
      "internalTransactions": false,
      "Instance Information": false,
      "latchAnalysis": false,
      "locks": false,
      "logicalSessionRecordCache": false,
      "metrics": false,
      "mirroredReads": false,
      "network": false,
      "opLatencies": false,
      "opReadConcernCounters": false,
      "opWriteConcernCounters": false,
      "opcounters": false,
      "opcountersRepl": false,
      "oplogTruncation": false,
      "planCache": false,
      "queryAnalyzers": false,
      "readConcernCounters": false,
      "readPreferenceCounters": false,
      "repl": false,
      "scramCache": false,
      "security": false,
      "sharding": false,
      "shardingStatistics": false,
      "shardedIndexConsistency": false,
      "shardSplits": false,
      "storageEngine": false,
      "tcmalloc": false,
      "tenantMigrations": false,
      "trafficRecording": false,
      "transactions": false,
      "transportSecurity": false,
      "twoPhaseCommitCoordinator": false,
      "watchdog": false,
      "wiredTiger": true,
      "writeBacksQueued": false
   };

   function pageStats(
         pageFillRatio = 0.9, // 0.9 (default page fill ratio)
         concurrentUpdatesRatio = 0.01, // needs to be limited to a portion of reusableBytes target ~1%
         totalUpdatesRatio = 0.2 // 20% pass
      ) {
      const {
         'storageStats': {
            'wiredTiger': {
               'block-manager': {
                  'file bytes available for reuse': reusableBytes
               } = {}
            } = {},
            'size': dataSize,
            'count': documentCount,
            storageSize,
            avgObjSize
         } = {}
      } = namespace.aggregate([{ "$collStats": { "storageStats": { "freeStorage": 1, "scale": 1 } } }]).toArray()[0];
      const compression = dataSize / (storageSize - reusableBytes);
      const dataPageSize = 32 * 1024;
      const pageFillTarget = Math.ceil((pageFillRatio * dataPageSize * compression) / avgObjSize);
      const pageFillActual = Math.ceil((0.9 * dataPageSize * compression) / avgObjSize);
      const estimatedDataPageCount = Math.ceil(documentCount / pageFillActual);
      const concurrentUpdates = Math.ceil(estimatedDataPageCount * concurrentUpdatesRatio);
      const iterations = Math.ceil(totalUpdatesRatio / concurrentUpdatesRatio);

      return {
         "pageFillTarget": pageFillTarget,
         "documentCount": documentCount,
         "concurrentUpdates": concurrentUpdates,
         "iterations": iterations,
         "pageFillActual": pageFillActual,
         "estimatedDataPageCount": estimatedDataPageCount
      };
   }

   async function* rndSample(sampleSize = 1, concurrentUpdates = 1) {
      //
      const options = {
            "allowDiskUse": true,
            "readConcern": { "level": "local" },
            "batchSize": Math.ceil(sampleSize / concurrentUpdates),
            "comment": "$sample technique"
         },
         pipeline = [
            { "$sample": { "size": sampleSize } },
            { "$project": { "_id": 1 } }
         ];

      yield namespace.aggregate(pipeline, options);
   }

   async function* adjacentSample(sampleSize = 1, concurrentUpdates = 1, sampleRate = 1) {
      //
      let options, pipeline;
      options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": "fetching seed _id via $sample"
      },
      pipeline = [
         { "$sample": { "size": 1 } },
         { "$project": { "_id": 1 } }
      ];
      const { '_id': seed } = namespace.aggregate(pipeline, options).toArray()[0];
      const seeding = [
         { "$gte": seed },
         { "$lte": seed }
      ][Math.floor(Math.random() * 2)];
      options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "hint": { "$natural": -1 },
         // "batchSize": Math.ceil(sampleSize / concurrentUpdates),
         "comment": "get neighbouring documents by _id/recordId"
      },
      pipeline = [
         { "$match": { "_id": seeding } },
         { "$match": { "$sampleRate": sampleRate } },
         { "$limit": sampleSize },
         { "$group": { "_id": "$_id" } }
      ];
      yield namespace.aggregate(pipeline, options);
      // yield db.getSiblingDB(dbName).runCommand(
      //    {
      //       "aggregate": collName,
      //       "pipeline": pipeline,
      //       ...options,
      //       "cursor": { "batchSize": Math.ceil(sampleSize / concurrentUpdates) }
      //    },
      //    { "readPreference": { "mode": "secondaryPreferred" } }
      // );
   }

   async function* bucketedIds(sampleSize = 1, concurrentUpdates = 1) {
      //
      let options, pipeline;
      options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "comment": "fetching seed _id via $sample"
      },
      pipeline = [
         { "$sample": { "size": 1 } },
         { "$project": { "_id": 1 } }
      ];
      const { '_id': seed } = namespace.aggregate(pipeline, options).toArray()[0];
      const seeding = [
         { "$gte": seed },
         { "$lte": seed }
      ][Math.floor(Math.random() * 2)];
      options = {
         "allowDiskUse": true,
         "readConcern": { "level": "local" },
         "hint": { "$natural": -1 },
         "batchSize": Math.ceil(sampleSize / concurrentUpdates),
         "comment": "get neighbouring documents by _id/recordId"
      },
      pipeline = [
         { "$match": { "_id": seeding } },
         { "$match": { "$sampleRate": sampleRate } },
         { "$limit": sampleSize },
         { "$group": { "_id": "$_id" } }
      ];
      yield namespace.aggregate(pipeline, options);
   }

   async function* getIds(sampleSize, concurrentUpdates, sampleRate) {
      // yield* rndSample(sampleSize, concurrentUpdates);
      yield* adjacentSample(sampleSize, concurrentUpdates, sampleRate);
      // yield* bucketedIds(sampleSize, concurrentUpdates);
   }

   async function bulkOps(ops, bulkOpts) {
      const sessionOpts = {
         "readPreference": { "mode": "primary" },
         "causalConsistency": true
      };
      const txnOpts = {
         "readConcern": { "level": "local" },
         "writeConcern": {
            "w": "majority",
            "j": false
         },
         "comment": "online compacting updates"
      };
      const session = db.getMongo().startSession(sessionOpts);
      const namespace = session.getDatabase(dbName).getCollection(collName);
      const bulkUpdate = async() => {
         const { modifiedCount } = await namespace.bulkWrite(ops, bulkOpts);
         console.log(`\tmodifiedCount: ${modifiedCount}`);
      }
      //
      try {
         session.withTransaction(bulkUpdate, txnOpts);
      } catch(error) {
         // console.log(`txn error:`, error);
         console.log(`\ttxn conflict detected, aborting op`);
      } finally {
         session.endSession();
      }
   }

   async function iBulkUpdateMany(updateManyFilter, updatePipeline, updateManyOpts, bulkOpts) {
      const ops = [
         { "updateMany": {
            "filter": updateManyFilter,
            "update": updatePipeline,
            ...updateManyOpts
         } }
      ];
      // await bulkOps(ops, bulkOpts);
      bulkOps(ops, bulkOpts);
   }

   function storageStats() {
      load(`${process.env.MDBLIB}/dbstats.js`);
      const { dataSize, storageSize, freeStorageSize } = dbStats.databases[0].collections[0];
      return {
         // 'dataSize': dataSize,
         'storageSize': storageSize,
         'freeStorageSize': freeStorageSize,
         'reuse': `${+((freeStorageSize / storageSize) * 100).toFixed(1)}%`,
         'compression': `${+(dataSize / (storageSize - freeStorageSize)).toFixed(2)}:1`
      };
   }

   function activeCheckpoint() {
      // WT-11171
      // v7-
      // return (db.serverStatus(serverStatusOptions).wiredTiger.transaction['transaction checkpoint currently running'] === 1);
      // v8+
      return (db.serverStatus(serverStatusOptions).wiredTiger.checkpoint['progress state'] > 0);
   }

   function checkpointMintimeMS() {
      // WT-11171
      // v7 and below
      // transaction['transaction checkpoint max time (msecs)']
      // transaction['transaction checkpoint min time (msecs)']
      // transaction['transaction checkpoint most recent time (msecs)']
      // return db.serverStatus(serverStatusOptions).wiredTiger.transaction['transaction checkpoint min time (msecs)'];

      // v8+
      // checkpoint['max time (msecs)']
      // checkpoint['min time (msecs)']
      // checkpoint['most recent time (msecs)']
      return db.serverStatus(serverStatusOptions).wiredTiger.checkpoint['min time (msecs)'];
   }

   async function main() {
      const bulkOpts = {
         "writeConcern": { "w": "majority" },
         "ordered": false
      };
      const updatePipeline = [{ "$unset": "_id" }]; // leverages SERVER-36405
      const updateManyOpts = {
         "upsert": false, // must only update existing documents
         "hint": { "_id": 1 } // must force hint to avoid $expr collscan
      };
      const { iterations = 1, concurrentUpdates = 1, pageFillTarget = 1, documentCount = 1, pageFillActual = 1, estimatedDataPageCount = 0 } = pageStats(pageFillRatio, concurrentUpdatesRatio, totalUpdatesRatio);
      const sampleSize = pageFillTarget;
      const sampleRate = 1 / pageFillActual;

      console.table({ ...{ 'state': 'initial storage' }, ...storageStats() });
      for (let i = 1; i <= iterations; ++i) {
         // console.clear();
         console.log(`Iterative bulk updates round ${i} of ${iterations} with pageFillTarget ${pageFillTarget} and sampleRate 1/${pageFillActual}`);
         let tasks = [];
         let update = 0;
         for await (ids of getIds(sampleSize, concurrentUpdates, sampleRate)) {
            const updateOneIds = ids.map(id => id._id).toArray();
            const updateManyFilter = { "_id": { "$in": updateOneIds } };
            ++update;
            console.log(`\tforking concurrent update ${update} with ${updateOneIds.length} IDs`);
            // await iBulkUpdateMany(concurrentUpdates, updateManyFilter, updatePipeline, updateManyOpts, bulkOpts);
            const op = () => iBulkUpdateMany(updateManyFilter, updatePipeline, updateManyOpts, bulkOpts);
            // console.log(`typeof iBulkdUpdateMany`, typeof op);
            tasks.push(op());
         }
         await Promise.allSettled(tasks);
         console.table({ ...{ 'state': 'volatile storage' }, ...storageStats() });
         let checkpointState = activeCheckpoint(), checkpointCompleted = false, checkpointSleep = Math.ceil(0.9 * checkpointMintimeMS());
         if (checkpointState) {
            console.log('checkpoint running, waiting to complete...');
         } else {
            console.log('waiting for checkpoint to start and complete...');
         }
         do {
            const checkpointInitState = checkpointState;
            // console.log(`sleeping for ${checkpointSleep}ms`);
            sleep(checkpointSleep);
            checkpointState = activeCheckpoint();
            // console.log('checkpointActive:', checkpointState);
            if (checkpointInitState != checkpointState && !checkpointState) {
               checkpointCompleted = true;
            }
         } while (checkpointState || !checkpointCompleted);
         console.log('checkpoint completed');
         console.table({ ...{ 'state': 'settled storage' }, ...storageStats() });
      }
   }

   await main();
})(options = { "filter": { "db": "^database$", "collection": "^collection$" }, "output": { "format": "json" } });

// EOF
