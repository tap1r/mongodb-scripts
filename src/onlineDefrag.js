/*
 *  Name: "onlineDefrag.js"
 *  Version: "0.1.5"
 *  Description: "online compaction"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Legacy archive line: v0.1.4 is the snapshot for this script. mongosh-only
 *  (async IIFE, process/fs; incompatible with legacy mongo).
 *  Still the demarked version for the whole-tree freeze. Further feature
 *  work targets mongosh; see ROADMAP.md → Legacy mongo shell retirement.
 *
 *  Notes:
 *  - mongosh only. Do not top-level-await this IIFE (rewriter SyntaxError).
 *  - --eval must use var (not let/const). Do not declare dbName/collName
 *    in this file — IIFE const would shadow the overlay.
 *  - storage snapshots use mdblib $collStats (MDBLIB, ~/.mongodb, or cwd).
 */

// Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>onlineDefrag.js

/*
 *  Example:
 *    mongosh [connection options] --quiet --eval "var dbName = 'database', collName = 'collection';" [-f|--file] </path/to/>onlineDefrag.js
 */

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "onlineDefrag.js", "version": "0.1.5" };
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

(async() => {
   const nsDb = typeof dbName === 'undefined' ? 'database' : dbName;
   const nsColl = typeof collName === 'undefined' ? 'collection' : collName;
   const namespace = db.getSiblingDB(nsDb).getCollection(nsColl);

   const pageFillRatio = 0.9;
   const concurrentUpdatesRatio = 0.005;
   const totalUpdatesRatio = 2; // 10;

   function pageStats(
         pageFillRatio = 0.9, // 0.9 (default page fill ratio)
         concurrentUpdatesRatio = 0.01, // needs to be limited to a portion of reusableBytes target ~1%
         totalUpdatesRatio = 0.2 // 20% pass
      ) {
      const {
         dataSize,
         storageSize,
         freeStorageSize,
         objects: documentCount,
         avgObjSize,
         dataPageSize: leafPageSize
      } = $collStats(nsDb, nsColl) || {};
      const compression = dataSize / (storageSize - freeStorageSize);
      const dataPageSize = Number(leafPageSize) > 0 ? leafPageSize : 32 * 1024;
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
      const namespace = session.getDatabase(nsDb).getCollection(nsColl);
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
      await bulkOps(ops, bulkOpts);
   }

   function storageStats() {
      return $collStats(nsDb, nsColl);
   }

   function wtCheckpoint() {
      // WT-11171: v8+ wiredTiger.checkpoint; v7 wiredTiger.transaction.
      // mongos / Atlas M0/Flex / non-WT: no wiredTiger section.
      const { wiredTiger } = serverStatus({ "wiredTiger": true });
      if (wiredTiger == null) {
         return { "available": false, "running": false, "minTimeMS": null };
      }
      const v8 = wiredTiger.checkpoint;
      const v7 = wiredTiger.transaction;
      return {
         "available": true,
         "running": (v8?.['progress state'] > 0) || (v7?.['transaction checkpoint currently running'] === 1),
         "minTimeMS": v8?.['min time (msecs)'] ?? v7?.['transaction checkpoint min time (msecs)'] ?? null
      };
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

      printjson({ "state": "initial storage", ...storageStats() });
      for (let i = 1; i <= iterations; ++i) {
         // console.clear();
         console.log(`Iterative bulk updates round ${i} of ${iterations} with pageFillTarget ${pageFillTarget} and sampleRate 1/${pageFillActual}`);
         let tasks = [];
         let update = 0;
         for await (const ids of getIds(sampleSize, concurrentUpdates, sampleRate)) {
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
         printjson({ "state": "volatile storage", ...storageStats() });
         let { available, running: checkpointState, minTimeMS } = wtCheckpoint();
         if (!available) {
            console.log('checkpoint metrics unavailable (no wiredTiger in serverStatus), skipping wait');
         } else {
            let checkpointCompleted = false;
            const checkpointSleep = Math.ceil(0.9 * (minTimeMS || 1000));
            if (checkpointState) {
               console.log('checkpoint running, waiting to complete...');
            } else {
               console.log('waiting for checkpoint to start and complete...');
            }
            do {
               const checkpointInitState = checkpointState;
               // console.log(`sleeping for ${checkpointSleep}ms`);
               sleep(checkpointSleep);
               ({ running: checkpointState } = wtCheckpoint());
               // console.log('checkpointActive:', checkpointState);
               if (checkpointInitState != checkpointState && !checkpointState) {
                  checkpointCompleted = true;
               }
            } while (checkpointState || !checkpointCompleted);
            console.log('checkpoint completed');
         }
         printjson({ "state": "settled storage", ...storageStats() });
      }
   }

   try {
      await main();
   } catch(e) {
      console.log('[red][ERROR][/]', e.errmsg || e.message || String(e));
      throw e;
   }
})();

// EOF
