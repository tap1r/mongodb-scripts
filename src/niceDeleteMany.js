(async() => {
   /*
    *  Name: "niceDeleteMany.js"
    *  Version: "0.1.0"
    *  Description: "nice concurrent/batch deleteMany() technique with admission control"
    *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - Curation relies on blocking operator for bucket estimations
    *  - Good for matching up to 2,147,483,647,000 documents
    *
    *  TODOs:
    *  - add execution profiler/timers
    *  - add admission controls
    *  - add serverStatus() debounce decorator, calculate moving averages (https://github.com/mongodb-js/mongosh/blob/main/packages/shell-api/src/mongo.ts#L338-L352)
    *  - add progress counters with estimated time remaining
    *  - add congestion meter for admission control
    *  - add throttling meter for admission control
    */

   // Usage: "mongosh [connection options] --quiet [--eval "let options = {...};"] [-f|--file] niceDeleteMany.js"

   /*
    * start user defined options
    */
   let dbName = 'database', collName = 'collection';
   let filter = {}; // { "qty": { "$lte": 1000 } };
   let hint = {}; // define a hint if it helps
   let collation = {
      // "locale": <string>,
      // "caseLevel": <boolean>,
      // "caseFirst": <string>,
      // "strength": <int>,
      // "numericOrdering": <boolean>,
      // "alternate": <string>,
      // "maxVariable": <string>,
      // "backwards": <boolean>
   };
   let simulate = true; // simulates deletes only (via aborted transactions), set false to remove safeguard
   // let niceness = 10; // TBA
   /*
    * end user defined options
    */

   let __script = { "name": "niceDeleteMany.js", "version": "0.1.0" };
   let banner = `#### Running script ${__script.name} v${__script.version} on shell v${version()}`;

   async function* getIds(filter = {}, bucketSizeLimit = 100, sessionOpts = {}) {
      // ID curation using blocking aggregation stage operator
      let session = db.getMongo().startSession(sessionOpts);
      let namespace = session.getDatabase(dbName).getCollection(collName);
      let buckets = Math.pow(2, 31) - 1, // max 32bit Int,
         pipeline = [
            { "$match": filter },
            { "$setWindowFields": {
               "sortBy": { "_id": 1 },
               "output": {
                  "ordinal": { "$documentNumber": {} },
                  "IDsTotal": { "$count": {} }
            } } },
            { "$bucketAuto": { // fixed height bucketing
               "groupBy": { "$ceil": { "$divide": ["$ordinal", "$$bucketSizeLimit"] } },
               "buckets": buckets,
               "output": {
                  "IDs": { "$push": "$_id" },
                  "bucketSize": { "$sum": 1 },
                  "IDsTotal": { "$max": "$IDsTotal" }
            } } },
            { "$setWindowFields": {
               "sortBy": { "_id": 1 },
               "output": {
                  "bucketId": { "$documentNumber": {} },
                  "bucketsTotal": { "$count": {} },
                  "IDsCumulative": {
                     "$sum": "$bucketSize",
                     "window": { "documents": ["unbounded", "current"] }
            } } } },
            { "$project": {
               "_id": 0,
               "bucketId": 1, // ordinal of current bucket
               "bucketsTotal": 1, // total number of buckets
               "bucketsRemaining": { "$subtract": ["$bucketsTotal", "$bucketId"] }, // number of buckets remaining
               "bucketSize": 1, // number of _ids in the current bucket
               "bucketSizeLimit": "$$bucketSizeLimit", // bucket size limit
               "IDsCumulative": 1, // cumulative total number of IDs
               "IDsRemaining": { "$subtract": ["$IDsTotal", "$IDsCumulative"] }, // total number of IDs remaining
               "IDsTotal": 1, // total number of IDs
               "IDs": 1 // IDs in the current bucket
            } }
         ],
         aggOpts = {
            "allowDiskUse": true,
            // "readConcern": readConcern,
            "collation": collation,
            "hint": hint,
            "comment": "Bucketing IDs via niceDeleteMany.js",
            "let": { "bucketSizeLimit": bucketSizeLimit }
         };
      yield* namespace.aggregate(pipeline, aggOpts);
   }

   function countIds(filter = {}) {
      // cheaper count for validation purposes
      let session = db.getMongo().startSession({
         "causalConsistency": true,
         "readConcern": { "level": "local" },
         "mode": "primaryPreferred"
      });
      let namespace = session.getDatabase(dbName).getCollection(collName);
      let pipeline = [
            { "$match": filter },
            { "$group": {
               "_id": null,
               "IDsTotal": { "$count": {} }
            } },
            { "$project": {
               "_id": 0,
               "IDsTotal": 1 // total number of IDs
            } }
         ],
         aggOpts = {
            "allowDiskUse": true,
            "readOnce": true, // may or may not work in aggregation?
            // "readConcern": readConcern,
            "collation": collation,
            "hint": hint,
            "comment": "Validating IDs via niceDeleteMany.js"
         };
      return namespace.aggregate(pipeline, aggOpts).toArray()[0]?.IDsTotal ?? 0;
   }

   async function deleteManyTask({ IDs, bucketId, bucketsRemaining } = {}, sessionOpts = {}) {
      let sleepIntervalMS = await admissionControl(bucketId, bucketsRemaining);
      console.log('\t\t...batch', bucketId, 'pre-sleeping for', sleepIntervalMS, 'ms');
      sleep(sleepIntervalMS);
      let session = db.getMongo().startSession(sessionOpts);
      let namespace = session.getDatabase(dbName).getCollection(collName);
      let txnOpts = {
         // "readConcern": { "level": "local" },
         // "writeConcern": {
         //    "w": "majority",
         //    "j": false
         // },
         "comment": "Simulating deleteMany() workload via niceDeleteMany.js"
      };
      let deleteManyFilter = { "_id": { "$in": IDs } };
      let deleteManyOpts = { "collation": collation };
      let deletedCount = 0;
      let deleteMany = async() => {
         return await namespace.deleteMany(deleteManyFilter, deleteManyOpts).deletedCount;
      }
      if (simulate) {
         try {
            session.startTransaction(txnOpts);
            deletedCount = await deleteMany();
         } catch(error) {
            console.log('txn error:', error);
         } finally {
            session.abortTransaction();
         }
      } else {
         try {
            deletedCount = await deleteMany();
         } catch(error) {
            console.log(error);
         }
      }

      return [bucketId, deletedCount];
   }

   async function congestionMonitor() {
      /*
       *  congestionMonitor() function
       */
      async function serverStatus(serverStatusOptions = {}) {
         /*
          *  opt-in version of db.serverStatus()
          */
         let serverStatusOptionsDefaults = { // multiversion compatibile
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
            "mem": false,
            "metrics": false,
            "mirroredReads": false,
            "network": false,
            "opLatencies": false,
            "opReadConcernCounters": false,
            "opWorkingTime": false,
            "opWriteConcernCounters": false,
            "opcounters": false,
            "opcountersRepl": false,
            "oplogTruncation": false,
            "planCache": false,
            "queryAnalyzers": false,
            "querySettings": false,
            "queues": false,
            "readConcernCounters": false,
            "readPreferenceCounters": false,
            "repl": false,
            "scramCache": false,
            "security": false,
            "service": false,
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
            "wiredTiger": false,
            "writeBacksQueued": false
         };

         return await db.adminCommand({
            "serverStatus": true,
            ...{ ...serverStatusOptionsDefaults, ...serverStatusOptions }
         });
      }

      async function _serverStatus() {
         // example decorator only
         return await Promise.race([
            (async () => {
               return (
                  await this._listDatabases({ "readPreference": "primaryPreferred" })
               ).databases.map(db => db.name);
            })(),
            (async () => {
               // See the comment in _getCollectionNamesForCompletion/database.ts
               // for the choice of 200 ms.
               await new Promise(resolve => setTimeout(resolve, 200).unref());
               return this._cachedDatabaseNames;
            })()
         ]);
      }

      async function _wiredTigerEngineRuntimeConfig() {
         // example decorator only
         return await Promise.race([
            (async () => {
               return (
                  await this._listDatabases({ "readPreference": "primaryPreferred" })
               ).databases.map(db => db.name);
            })(),
            (async () => {
               // See the comment in _getCollectionNamesForCompletion/database.ts
               // for the choice of 200 ms.
               await new Promise(resolve => setTimeout(resolve, 200).unref());
               return this._cachedDatabaseNames;
            })()
         ]);
      }

      function hostInfo() {
         let hostInfo = {};
         try {
            hostInfo = db.hostInfo();
         } catch(error) {
            // console.debug(`\x1b[31m[WARN] insufficient rights to execute db.hostInfo()\n${error}\x1b[0m`);
         }

         return hostInfo;
      }

      let congestionMetrics = {
         // # WT eviction defaults (https://kb.corp.mongodb.com/article/000019073)
         // evictionThreadsMin,
         // evictionThreadsMax,
         // evictionCheckpointTarget,
         // evictionDirtyTarget,    // operate in a similar way to the overall targets but only apply to dirty data in cache
         // evictionDirtyTrigger,   // application threads will be throttled if the percentage of dirty data reaches the eviction_dirty_trigger
         // evictionTarget,         // the level at which WiredTiger attempts to keep the overall cache usage
         // evictionTrigger,        // the level at which application threads start to perform the eviction
         // evictionUpdatesTarget,  // eviction in worker threads when the cache contains at least this many bytes of updates
         // evictionUpdatesTrigger, // application threads to perform eviction when the cache contains at least this many bytes of updates
         // # cache stats
         // updatesDirtyBytes,
         // dirtyBytes,
         // cacheSizeBytes,
         // cachedBytes,
         // # derived cache metrics
         // cacheUtil,
         // dirtyUtil,
         // dirtyUpdatesUtil,
         // evictionsTriggered,
         // memSizeBytes,
         // numCores,
         // pageheapFreeBytes,
         // memoryFragmentationRatio, // tcmalloc only
         // # contention indicators
         // backupCursorOpen,
         // wtTicketsAvailable,
         // activeShardMigrations,
         // activeFlowControl,
         // activeIndexBuilds,
         // activeCheckpoints,
         // # workload indicators
         // slowms
         "hostInfo": hostInfo(),
         "wiredTigerEngineRuntimeConfig": db.adminCommand({ "getParameter": 1, "wiredTigerEngineRuntimeConfig": 1 }).wiredTigerEngineRuntimeConfig,
         "wiredTigerConcurrentReadTransactions": db.adminCommand({ "getParameter": 1, "wiredTigerConcurrentReadTransactions": 1 }).wiredTigerConcurrentReadTransactions,
         "wiredTigerConcurrentWriteTransactions": db.adminCommand({ "getParameter": 1, "wiredTigerConcurrentWriteTransactions": 1 }).wiredTigerConcurrentWriteTransactions,
         // https://www.mongodb.com/docs/manual/reference/command/serverStatus/#mongodb-serverstatus-serverstatus.wiredTiger.concurrentTransactions
         "serverStatus": await serverStatus({ // minimal server status metrics to reduce server cost
            "flowControl": true,
            "storageEngine": true,
            "tenantMigrations": true,
            "tcmalloc": true,
            "wiredTiger": true
         }),
         "slowms": db.getSiblingDB('admin').getProfilingStatus().slowms,
         wterc(regex) {
            // { "wiredTigerEngineRuntimeConfig": "eviction=(threads_min=8,threads_max=8),eviction_dirty_target=2,eviction_updates_trigger=8" }
            return +this.wiredTigerEngineRuntimeConfig.match(regex)?.[1];
         },
         get evictionThreadsMin() {
            return this.wterc(/eviction=\(.*threads_min=(\d+).*\)/) ?? 4;
         },
         get evictionThreadsMax() {
            return this.wterc(/eviction=\(.*threads_max=(\d+).*\)/) ?? 4;
         },
         get evictionCheckpointTarget() {
            return this.wterc(/eviction_checkpoint_target=(\d+)/) ?? 1;
         },
         get evictionDirtyTarget() {
            return this.wterc(/eviction_dirty_target=(\d+)/) ?? 5;
         },
         get evictionDirtyTrigger() {
            return this.wterc(/eviction_dirty_trigger=(\d+)/) ?? 20;
         },
         get evictionTarget() {
            return this.wterc(/eviction_target=(\d+)/) ?? 80;
         },
         get evictionTrigger() {
            return this.wterc(/eviction_trigger=(\d+)/) ?? 95;
         },
         get evictionUpdatesTarget() {
            return this.wterc(/eviction_updates_target=(\d+)/) ?? 2.5;
         },
         get evictionUpdatesTrigger() {
            return this.wterc(/eviction_updates_trigger=(\d+)/) ?? 10;
         },
         get updatesDirtyBytes() {
            return this.serverStatus.wiredTiger.cache['bytes allocated for updates'];
         },
         get dirtyBytes() {
            return this.serverStatus.wiredTiger.cache['tracked dirty bytes in the cache'];
         },
         get cacheSizeBytes() {
            return this.serverStatus.wiredTiger.cache['maximum bytes configured'];
         },
         get cachedBytes() {
            return this.serverStatus.wiredTiger.cache['bytes currently in the cache'];
         },
         get cacheUtil() {
            return (this.cachedBytes / this.cacheSizeBytes) * 100;
         },
         get dirtyUtil() {
            return (this.dirtyBytes / this.cacheSizeBytes) * 100;
         },
         get dirtyUpdatesUtil() {
            return (this.updatesDirtyBytes / this.cacheSizeBytes) * 100;
         },
         get evictionsTriggered() {
            return  (this.cacheUtil    > this.eviction_trigger)         ? true
                  : (this.dirtyUtil    > this.eviction_dirty_trigger)   ? true
                  : (this.dirtyUpdates > this.eviction_updates_trigger) ? true
                  : false;
         },
         get memSizeBytes() {
            return (this?.hostInfo?.system?.memSizeMB ?? 1) * 1024 * 1024;
         },
         get numCores() {
            return this?.hostInfo?.system?.numCores ?? 4; // else max 4 is probably a good default aliigning with concurrency limits
         },
         get pageheapFreeBytes() {
            // assume zero fragmentation if we cannot measure pageheap_free_bytes
            return this?.tcmalloc?.pageheap_free_bytes ?? 0;
         },
         get memoryFragmentationRatio() {
            // green: < 10%
            // yellow: 10-30%
            // red: > 30%
            return (this.pageheapFreeBytes / (this.memSizeBytes - this.cachedBytes)) * 100;
         },
         get backupCursorOpen() {
            return this.serverStatus.storageEngine.backupCursorOpen;
         },
         get wtTicketsAvailable() {
            // in fCV(7.0) use serverStatus queued readers writers instead, as tickets are no longer an indicator
            // r/w > 80%
            //    write: {
            //      out: 0,
            //      available: 13,
            //      totalTickets: 13,
            //      queueLength: Long('0'),
            //      processing: Long('0')
            //    },
            //    read: {
            //      out: 0,
            //      available: 13,
            //      totalTickets: 13,
            //      queueLength: Long('0'),
            //      processing: Long('0')
            //    }
            let { 'read': readTickets, 'write': writeTickets } = this.serverStatus.wiredTiger.concurrentTransactions;
            let readUtil = (readTickets.available / readTickets.totalTickets) * 100;
            let writeUtil = (writeTickets.available / writeTickets.totalTickets) * 100;
            return (readUtil > 80 && writeUtil > 80);
         },
         get activeShardMigrations() {
            let { currentMigrationsDonating, currentMigrationsReceiving } = this.serverStatus.tenantMigrations;
            return (currentMigrationsDonating > 0 || currentMigrationsReceiving > 0);
         },
         get activeFlowControl() {
            return (this.serverStatus.flowControl.isLagged === true && this.serverStatus.flowControl.enabled === true);
         },
         get activeIndexBuilds() {
            return (this.serverStatus.activeIndexBuilds?.total ?? 0 > 0);
         },
         get activeCheckpoints() {
            // 'transaction checkpoint max time (msecs)'
            // 'transaction checkpoint min time (msecs)'
            // 'transaction checkpoint most recent time (msecs)'
            return (this.serverStatus.wiredTiger.transaction['transaction checkpoint currently running'] > 0);
         }
      };

      return congestionMetrics;
   }

   async function admissionControl(bucketId = 0, bucketsRemaining = 0) {
      /*
       *  threads should not compete under these contended conditions
       *  also see https://jira.mongodb.org/browse/SPM-1123
       */

      let vitals = congestionMonitor();

      let sleepIntervalMS; // naïve admission control
      if (bucketId === 0 && bucketsRemaining === 0) { // invalid batch
         sleepIntervalMS = 0;
      } else if (bucketId === 1) { // first batch
         sleepIntervalMS = 0;
      } else if (bucketsRemaining === 0) { // last batch
         sleepIntervalMS = 101;
      } else { // every other intermediate batch
         sleepIntervalMS = Math.ceil(100 + Math.random() * 350);
      }

      // console.log('vitals:', vitals);
      return sleepIntervalMS;
   }

   async function* asyncThreadPool(method = () => {}, threads = [], poolSize = 1, sessionOpts = {}) {
      let executing = new Set();
      async function consume() {
         let [threadPromise, thread] = await Promise.race(executing);
         executing.delete(threadPromise);
         return thread;
      }

      for await (let thread of threads) {
         /*
          *  Wrap method() in an async fn to ensure we get a promise.
          *  Then expose such promise, so it's possible to later reference and
          *  remove it from the executing pool.
          */
         let msg = `\n\n\tScheduling batch ${thread.bucketId} with ${thread.bucketsRemaining} buckets remaining queued:\n`;
         msg = banner + msg;
         console.clear();
         console.log(msg);
         let threadPromise = (async() => method(thread, sessionOpts))().then(
            thread => [threadPromise, thread]
         );
         executing.add(threadPromise);
         if (executing.size >= poolSize) yield await consume();
      }

      while (executing.size) yield await consume();
   }

   async function main() {
      let numCores = db.hostInfo()?.system?.numCores ?? 4;
      let concurrency = (numCores > 4) ? numCores : 4; // see https://www.mongodb.com/docs/manual/reference/parameters/#mongodb-parameter-param.wiredTigerConcurrentWriteTransactions
      let bucketSizeLimit = 100; // aligns with SPM-2227
      let readConcern = { "level": "local" }, writeConcern = { "w": "majority" }; // monotonic writes
      let readPreference = {
         "mode": "secondaryPreferred", // offload the bucket generation to a secondary node
         "tags": [ // Atlas friendly defaults
            { "workloadType": "OPERATIONAL", "diskState": "READY" },
            {}
         ]
      };
      let sessionOpts = {
         "causalConsistency": true,
         "readConcern": readConcern,
         "readPreference": readPreference,
         "retryWrites": true,
         "writeConcern": writeConcern
      };
      banner = `\n\x1b[33m${banner}\x1b[0m`;
      banner += `\n\nCurating deletion Ids from namespace '${dbName}.${collName}' with filter ${JSON.stringify(filter)} ...please wait.\n`;
      console.clear();
      console.log(banner);
      let deletionList = getIds(filter, bucketSizeLimit, sessionOpts);
      let { 'value': initialBatch, 'done': initialEmptyBatch } = await deletionList.next();
      if (initialEmptyBatch) {
         console.log('\tno matching documents found to match the filter, double check the namespace and filter');
      } else { // first batch
         let msg = `\nForking ${initialBatch.bucketsTotal} batches of ${initialBatch.bucketSizeLimit} documents with concurrency execution of ${concurrency} to delete ${initialBatch.IDsTotal} documents`;
         banner += msg;
         console.log(msg);
         for await (let [bucketId, deletedCount] of asyncThreadPool(deleteManyTask, [initialBatch], concurrency, sessionOpts)) {
            console.log('\t\t...batch', bucketId, 'deleted', deletedCount, 'documents');
         }
         // update admissionControl metrics after initial load spike from the first batch
         for await (let [bucketId, deletedCount] of asyncThreadPool(deleteManyTask, deletionList, concurrency, sessionOpts)) {
            console.log('\t\t...batch', bucketId, 'deleted', deletedCount, 'documents');
         }
      }
      console.log(`\nValidating deletion results ...please wait.\n`);
      let finalCount = countIds(filter);
      if (simulate) {
         console.log('Simulation safeguard is enabled, no deletions were actually performed.');
         console.log('...but since you asked, the final query count is', finalCount, 'compared to the initial', (initialEmptyBatch) ? 0 : initialBatch.IDsTotal);
      } else if (finalCount === 0) {
         console.log('No matching documents found, deletion succeeded!');
      } else { // found some residual results, outside writes, stale reads etc...
         console.log('Found total:', finalCount, 'documents remaining to be deleted, please consider running the script again.');
      }
      console.log('\nDone!');
   }

   await main().finally(console.log);
})();

// EOF
