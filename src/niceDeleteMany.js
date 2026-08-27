(async() => {
   /*
    *  Name: "niceDeleteMany.js"
    *  Version: "0.2.25"
    *  Description: "nice concurrent/batch deleteMany() technique with admission control"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Notes:
    *  - Curation relies on a semi-blocking operator for bucket estimations
    *  - Good for matching up to 2,147,483,647,000 documents
    *
    *  TODOs:
    *  - re-add naïve timers for mongos/sharding support
    *  - add execution profiler/timers
    *  - add progress counters with estimated time remaining
    *  - add congestion meter for admission control
    *  - add repl-lag metric for admission control
    *  - add backoff expiry timer
    *  - add better sharding support
    *  - revise lowPriorityAdmissionBypassThreshold for backward compatibility
    *  - improve support for Atlas Flex tiers
    *  - build-in IXSCAN check to support the supplied filter
    */

   // Syntax: mongosh [connection options] [--quiet] [--eval 'let dbName = "", collName = "", filter = {}, hint = {}, collation = {}, safeguard = <bool>;'] [-f|--file] </path/to/>niceDeleteMany.js

   /*
    *  dbName: <string>      // (required) database name
    *  collName: <string>    // (required) collection name
    *  filter: <document>    // (optional) query filter
    *  hint: <document>      // (optional) query hint
    *  collation: <document> // (optional) query collation
    *  safeguard: <bool>     // (optional) simulates deletes only (via aborted transactions), set false to remove safeguard
    */

   // Example: mongosh --host "replset/localhost" --eval 'var dbName = "database", collName = "collection", filter = { "qty": { "$lte": 100 } }, safeguard = true;' niceDeleteMany.js

   /*
    *  Start user defined options defaults
    */

   if (typeof dbName !== 'string' || !dbName) throw new Error('db namespace must be defined');
   if (typeof collName !== 'string' || !collName) throw new Error('collection namespace must be defined');
   typeof filter !== 'object' && (filter = {});
   typeof hint !== 'object' && (hint = {});
   typeof collation !== 'object' && (collation = {});
   typeof safeguard !== 'boolean' && (safeguard = true);

   /*
    *  End user defined options
    */

   const __script = { "name": "niceDeleteMany.js", "version": "0.2.25" };
   let banner = `#### Running script ${__script.name} v${__script.version} on shell v${version()}`;
   let vitals = {};
   let vitalsSampling = false;
   let vitalsView = null; // singleton congestion snapshot (getters created once)

   // TTL caches: serverStatus is hot-path; hostInfo is near-static; rsStatus is low/medium volatility.
   // serverStatus uses a Promise wrapper (adminCommand is sync in mongosh) for in-flight coalescing.
   const SERVER_STATUS_CACHE_TTL_MS = 100;
   const HOST_INFO_CACHE_TTL_MS = 60 * 1000;
   const RS_STATUS_CACHE_TTL_MS = 2 * 1000; // 2s matches the Atlas no-op heartbeat interval
   const SLOWMS_CACHE_TTL_MS = 60 * 1000;
   const GET_PARAMETER_CACHE_TTL_MS = 60 * 1000;
   const VITALS_SAMPLE_INTERVAL_MS = 100;
   // EWMA: α=0.2 ≈ half-life ~0.3s at 100ms samples (reduces single-sample admission chatter).
   const EWMA_ALPHA = 0.2;
   const ewma = {
      "cacheUtil": null,
      "dirtyUtil": null,
      "dirtyUpdatesUtil": null,
      "wtWriteTicketsUtil": null
   };
   // Admission FSM: trip CLOSED at *Trigger; release only at/under *Target (hysteresis).
   const ADMISSION_COOLDOWN_MS = 1000;
   const THROTTLE_DELAY_MIN_MS = 20;
   const THROTTLE_DELAY_MAX_MS = 100; // at *Trigger edge within the soft band
   let admissionState = 'OPEN'; // OPEN | THROTTLE | CLOSED | COOLDOWN
   let admissionCooldownUntil = 0;
   const _serverStatusCache = { "key": null, "at": 0, "value": null, "inflight": null };
   const _hostInfoCache = { "at": 0, "value": null };
   const _rsStatusCache = { "at": 0, "value": null };
   const _slowmsCache = { "at": 0, "value": null };
   const _getParameterCache = Object.create(null); // name -> { at, value }

   // Hoisted once — avoid rebuilding ~60-key maps on every serverStatus() call.
   const SERVER_STATUS_OPTIONS_DEFAULTS = { // multiversion compatible
      "none": true, // 8.3 feature: exclude all optional fields, then opt-in
      "activeIndexBuilds": false,
      "asserts": false,
      "batchedDeletes": false,
      "bucketCatalog": false,
      "catalogStats": false,
      "changeStreamPreImages": false,
      "collectionCatalog": false,
      "connections": false,
      "defaultRWConcern": false,
      "directShardConnections": false,
      "electionMetrics": false,
      "encryptionAtRest": false,
      "extra_info": false,
      "featureCompatibilityVersion": false,
      "fle": false,
      "flowControl": false,
      "ftdcCollectionMetrics": false,
      "globalLock": false,
      "health": false,
      "hedgingMetrics": false,
      "indexBuilds": false,
      "indexBulkBuilder": false,
      "indexStats": false,
      "internalTransactions": false,
      "latchAnalysis": false,
      "locks": false,
      "lockContentionMetrics": false,
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
      "oplogTruncationThread": false,
      "planCache": false,
      "profiler": false,
      "queryAnalyzers": false,
      "querySettings": false,
      "queryStats": false,
      "queues": false,
      "readConcernCounters": false,
      "readPreferenceCounters": false,
      "recoveryOplogApplier": false,
      "repl": false,
      "scramCache": false,
      "security": false,
      "sharding": false,
      "shardingStatistics": false,
      "shardedIndexConsistency": false,
      "shardSplits": false,
      "spillWiredTiger": false,
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
   const SERVER_STATUS_OPT_IN = { // minimal metrics for admission / congestion
      "activeIndexBuilds": true,
      "flowControl": true,
      "indexBuilds": true,
      "mem": true,
      "metrics": true,
      "queues": true,
      "storageEngine": true,
      "tenantMigrations": true,
      "tcmalloc": true, // 2 for more debugging
      "wiredTiger": true
   };

   function getParameter(name, fallback = null) {
      // Near-static mongod knobs (WT runtime config, ticket limits). 60s TTL + try/catch.
      const now = Date.now();
      const hit = _getParameterCache[name];
      if (hit && (now - hit.at) < GET_PARAMETER_CACHE_TTL_MS) return hit.value;
      let value = fallback;
      try {
         value = db.adminCommand({ "getParameter": 1, [name]: 1 })[name] ?? fallback;
      } catch(e) {
         // Flex / restricted roles / unavailable param — keep fallback
      }
      _getParameterCache[name] = { "at": now, "value": value };
      return value;
   }

   function isMongos() {
      /*
       *  True when connected to a mongos router (sharded cluster).
       */
      return db.hello().msg === 'isdbgrid';
   }

   if (isMongos()) throw new Error('\n[WARN] Sharding not currently supported\n');

   async function* getIds(filter = {}, bucketSizeLimit = 100, sessionOpts = {}) {
      // _id curation (employs partial-blocking aggregation operators)
      const session = db.getMongo().startSession(sessionOpts);
      try {
         const namespace = session.getDatabase(dbName).getCollection(collName);
         // const buckets = Math.pow(2, 31) - 1; // max 32bit Int
         const aggOpts = {
            "allowDiskUse": true,
            "collation": collation,
            // "cursor": { "batchSize": bucketSizeLimit * vitals.numCores }, // multiple of bucketSizeLimit * concurrency
            "cursor": { "batchSize": 1 }, // optimised for the prefetch concurrency
            "hint": hint,
            "maxTimeMS": 0, // required to overide potential v8 defaultMaxTimeMS cluster settings
            "noCursorTimeout": true,
            "comment": "Bucketing IDs via niceDeleteMany.js",
            "let": { "bucketSizeLimit": bucketSizeLimit }
         };
         const pipeline = [
            { "$match": filter },
            /* v1 blocking mode with count estimations
               // { "$setWindowFields": {
               //    "sortBy": { "_id": 1 },
               //    "output": {
               //       "ordinal": { "$documentNumber": {} },
               //       "IDsTotal": { "$count": {} }
               // } } },
               // { "$bucketAuto": { // fixed height bucketing
               //    "groupBy": { "$ceil": { "$divide": ["$ordinal", "$$bucketSizeLimit"] } },
               //    "buckets": buckets,
               //    "output": {
               //       "IDs": { "$push": "$_id" },
               //       "bucketSize": { "$sum": 1 },
               //       "IDsTotal": { "$max": "$IDsTotal" }
               // } } },
               // { "$setWindowFields": {
               //    "sortBy": { "_id": 1 },
               //    "output": {
               //       "bucketId": { "$documentNumber": {} },
               //       "bucketsTotal": { "$count": {} },
               //       "IDsCumulative": {
               //          "$sum": "$bucketSize",
               //          "window": { "documents": ["unbounded", "current"] }
               // } } } },
            */
            /* v2 reduced non-blocking mode without count estimations
               // { "$setWindowFields": { // assign ordinal numbers incrementally
               //    "sortBy": { "_id": 1 },
               //    "output": { "ordinal": { "$documentNumber": {} } }
               // } },
               // { "$set": { // assign bucket IDs based on ordinal, avoiding full grouping
               //    "bucketId": { "$ceil": { "$divide": ["$ordinal", "$$bucketSizeLimit"] } }
               // } },
               // { "$group": { // group into buckets incrementally
               //    "_id": "$bucketId",
               //    "IDs": { "$push": "$_id" },
               //    "bucketSize": { "$sum": 1 }
               // } },
               // { "$setWindowFields": { // compute cumulative bucket sizes
               //    "sortBy": { "_id": 1 },
               //    "output": {
               //       "bucketId": { "$documentNumber": {} }, // renumber buckets sequentially
               //       "IDsCumulative": {
               //          "$sum": "$bucketSize",
               //          "window": { "documents": ["unbounded", "current"] }
               // } } } },
            */
            // v3 non-blocking mode
            { "$setWindowFields": { // assign ordinal numbers
               "sortBy": { [Object.keys(filter)[0]]: 1 },
               "output": { "ordinal": { "$documentNumber": {} } }
            } },
            { "$set": { // compute bucketId and running cumulative count
               "bucketId": { "$ceil": { "$divide": ["$ordinal", "$$bucketSizeLimit"] } },
               "cardinal": 1 // each document contributes 1 to its bucket
            } },
            { "$setWindowFields": { // compute cumulative sum in the bucket
               "partitionBy": "$bucketId",
               "sortBy": { [Object.keys(filter)[0]]: 1 },
               "output": {
                  "IDsCumulative": {
                     "$sum": "$cardinal",
                     "window": { "documents": ["unbounded", "current"] }
                  },
                  "IDs": { "$push": "$_id" },
                  "bucketSize": { "$sum": 1 }
               }
            } },
            { "$match": { // reduce to the last bucket of each group
               "$expr": {
                  "$eq": ["$IDsCumulative", "$bucketSize"]
               }
            } },
            //
            { "$project": {
               "_id": 0,
               "bucketId": 1, // ordinal of current bucket
               // "bucketsTotal": 1, // total number of buckets
               // "bucketsRemaining": { "$subtract": ["$bucketsTotal", "$bucketId"] }, // number of buckets remaining
               "bucketSize": 1, // number of _ids in the current bucket
               "bucketSizeLimit": "$$bucketSizeLimit", // bucket size limit
               "IDsCumulative": 1, // cumulative total number of IDs
               // "IDsRemaining": { "$subtract": ["$IDsTotal", "$IDsCumulative"] }, // total number of IDs remaining
               "IDsTotal": 1, // total number of IDs
               "IDs": 1 // IDs in the current bucket
            } }
         ];
         // offload iterator to the server's cursor
         const cursor = namespace.aggregate(pipeline, aggOpts);
         try {
            yield* cursor;
         } finally {
            try { await cursor.close(); } catch(_) { /* exhausted or already closed */ }
         }
      } finally {
         session.endSession();
      }
   }

   function countIds(filter = {}, sessionOpts = {}) {
      // residual validation on primary with majority RC (matches wc:majority deletes)
      const session = db.getMongo().startSession(sessionOpts);
      try {
         const namespace = session.getDatabase(dbName).getCollection(collName);
         const pipeline = [
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
               "readConcern": sessionOpts?.readConcern?.level ?? "majority",
               "collation": collation,
               "hint": hint,
               "comment": "Validating IDs via niceDeleteMany.js"
            };
         return namespace.aggregate(pipeline, aggOpts).toArray()[0]?.IDsTotal ?? 0;
      } finally {
         session.endSession();
      }
   }

   async function deleteManyTask({ IDs, bucketId } = {}, sessionOpts = {}) {
      const session = db.getMongo().startSession(sessionOpts);
      try {
         const namespace = session.getDatabase(dbName).getCollection(collName);
         const txnOpts = {
            // "readConcern": { "level": "local" },
            // "writeConcern": {
            //    "w": "majority",
            //    "j": false
            // },
            "comment": `Simulating deleteMany(${JSON.stringify(filter)}) workload via niceDeleteMany.js`
         };
         const deleteManyFilter = { "_id": { "$in": IDs } };
         const deleteManyOpts = { "collation": collation };
         let deletedCount = 0;
         const deleteMany = async() => {
            return await namespace.deleteMany(deleteManyFilter, deleteManyOpts).deletedCount;
         }
         if (safeguard) {
            let txnStarted = false;
            try {
               session.startTransaction(txnOpts);
               txnStarted = true;
               deletedCount = await deleteMany();
            } catch(e) {
               console.log('transaction error:', e);
            } finally {
               if (txnStarted) {
                  try {
                     session.abortTransaction();
                  } catch(e) {
                     console.log('abort transaction error:', e);
                  }
               }
            }
         } else {
            try {
               deletedCount = await deleteMany();
            } catch(e) {
               console.log(e);
            }
         }

         return [bucketId, deletedCount];
      } finally {
         session.endSession();
      }
   }

   async function congestionMonitor() {
      /*
       *  congestionMonitor() function
       */
      async function serverStatus(serverStatusOptions = {}) {
         /*
          *  opt-in version of db.serverStatus() with a 100ms TTL cache.
          *  Concurrent callers with the same options share one in-flight round trip.
          */
         const key = JSON.stringify(serverStatusOptions);
         const now = Date.now();
         if (_serverStatusCache.value !== null &&
               _serverStatusCache.key === key &&
               (now - _serverStatusCache.at) < SERVER_STATUS_CACHE_TTL_MS) {
            return _serverStatusCache.value;
         }
         if (_serverStatusCache.inflight !== null && _serverStatusCache.key === key) {
            return await _serverStatusCache.inflight;
         }

         // db.adminCommand() is synchronous in mongosh; wrap in a Promise so
         // await is meaningful and concurrent callers can share one in-flight fetch.
         _serverStatusCache.key = key;
         _serverStatusCache.inflight = Promise.resolve().then(() => db.adminCommand({
            "serverStatus": true,
            ...{ ...SERVER_STATUS_OPTIONS_DEFAULTS, ...serverStatusOptions }
         }));
         try {
            const value = await _serverStatusCache.inflight;
            _serverStatusCache.value = value;
            _serverStatusCache.at = Date.now();
            return value;
         } finally {
            _serverStatusCache.inflight = null;
         }
      }

      function hostInfo() {
         // Near-static (cores, RAM limits, OS). 60s TTL is plenty; container limit changes are rare.
         const now = Date.now();
         if (_hostInfoCache.value !== null && (now - _hostInfoCache.at) < HOST_INFO_CACHE_TTL_MS) {
            return _hostInfoCache.value;
         }
         let hostInfo = {};
         try {
            hostInfo = db.hostInfo();
         } catch(e) {
            // console.debug(`\x1b[31m[WARN] insufficient rights to execute db.hostInfo()\n${e}\x1b[0m`);
         }
         _hostInfoCache.value = hostInfo;
         _hostInfoCache.at = now;
         return hostInfo;
      }

      function rsStatus() {
         // Member set/health changes slowly; optimes move faster. TTL balances lag freshness vs rs.status() cost.
         const now = Date.now();
         if (_rsStatusCache.value !== null && (now - _rsStatusCache.at) < RS_STATUS_CACHE_TTL_MS) {
            return _rsStatusCache.value;
         }
         let rsStatus = {};
         try {
            rsStatus = rs.status();
         } catch(e) {
            // console.debug(`\x1b[31m[WARN] insufficient rights to execute rs.status()\n${e}\x1b[0m`);
         }
         _rsStatusCache.value = rsStatus;
         _rsStatusCache.at = now;
         return rsStatus;
      }

      function slowms() {
         // Profiling threshold rarely changes at runtime.
         const now = Date.now();
         if (_slowmsCache.value !== null && (now - _slowmsCache.at) < SLOWMS_CACHE_TTL_MS) {
            return _slowmsCache.value;
         }
         let slowms = null;
         try {
            slowms = db.getSiblingDB('admin').getProfilingStatus().slowms;
         } catch(e) {
            // console.debug(`\x1b[31m[WARN] insufficient rights to execute getProfilingStatus()\n${e}\x1b[0m`);
         }
         _slowmsCache.value = slowms;
         _slowmsCache.at = now;
         return slowms;
      }

      // Refresh dynamic/near-static data fields; create getter-bearing view once.
      const data = {
         "hostInfo": hostInfo(),
         "rsStatus": rsStatus(),
         "wiredTigerEngineRuntimeConfig": getParameter('wiredTigerEngineRuntimeConfig', ''),
         "storageEngineConcurrentReadTransactions": getParameter('wiredTigerConcurrentReadTransactions', null),
         // "storageEngineConcurrentReadTransactions": getParameter('storageEngineConcurrentReadTransactions', null),
         "storageEngineConcurrentWriteTransactions": getParameter('wiredTigerConcurrentWriteTransactions', null),
         // "lowPriorityAdmissionBypassThreshold": getParameter('lowPriorityAdmissionBypassThreshold', null),
         // https://www.mongodb.com/docs/manual/reference/command/serverStatus/#mongodb-serverstatus-serverstatus.wiredTiger.concurrentTransactions
         "serverStatus": await serverStatus(SERVER_STATUS_OPT_IN),
         "slowms": slowms()
      };
      if (vitalsView !== null) {
         Object.assign(vitalsView, data);
         return vitalsView;
      }
      // WT eviction defaults (https://kb.corp.mongodb.com/article/000019073)
      // evictionThreadsMin,
      // evictionThreadsMax,
      // evictionCheckpointTarget,
      // evictionDirtyTarget,    // operate in a similar way to the overall targets but only apply to dirty data in cache
      // evictionDirtyTrigger,   // application threads will be throttled if the percentage of dirty data reaches the eviction_dirty_trigger
      // evictionTarget,         // the level at which WiredTiger attempts to keep the overall cache usage
      // evictionTrigger,        // the level at which application threads start to perform the eviction
      // evictionUpdatesTarget,  // eviction in worker threads when the cache contains at least this many bytes of updates
      // evictionUpdatesTrigger, // application threads to perform eviction when the cache contains at least this many bytes of updates
      vitalsView = {
         ...data,
         wterc(regex) {
            // { "wiredTigerEngineRuntimeConfig": "eviction=(threads_min=8,threads_max=8),eviction_dirty_target=2,eviction_updates_trigger=8,checkpoint=(wait=60,log_size=2GB)" }
            return this.wiredTigerEngineRuntimeConfig.match(regex)?.[1] ?? null;
         },
         get evictionThreadsMin() {
            return +(this.wterc(/eviction=\(.*threads_min=(\d+).*\)/) ?? 4);
         },
         get evictionThreadsMax() {
            return +(this.wterc(/eviction=\(.*threads_max=(\d+).*\)/) ?? 4);
         },
         get evictionCheckpointTarget() {
            return +(this.wterc(/eviction_checkpoint_target=(\d+)/) ?? 1);
         },
         get evictionDirtyTarget() {
            return +(this.wterc(/eviction_dirty_target=(\d+)/) ?? 5);
         },
         get evictionDirtyTrigger() {
            return +(this.wterc(/eviction_dirty_trigger=(\d+)/) ?? 20);
         },
         get evictionTarget() {
            return +(this.wterc(/eviction_target=(\d+)/) ?? 80);
         },
         get evictionTrigger() {
            return +(this.wterc(/eviction_trigger=(\d+)/) ?? 95);
         },
         get evictionUpdatesTarget() {
            return +(this.wterc(/eviction_updates_target=(\d+)/) ?? 2.5);
         },
         get evictionUpdatesTrigger() {
            return +(this.wterc(/eviction_updates_trigger=(\d+)/) ?? 10);
         },
         get checkpointIntervalMS() { // checkpoint=(wait=60
            return 1000 * (this.wterc(/checkpoint=\(.*wait=(\d+).*\)/) ?? 60);
         },
         get updatesDirtyBytes() {
            return this.serverStatus.wiredTiger.cache['bytes allocated for updates'];
         },
         get dirtyBytes() {
            return +this.serverStatus.wiredTiger.cache['tracked dirty bytes in the cache'];
         },
         get cacheSizeBytes() {
            return +this.serverStatus.wiredTiger.cache['maximum bytes configured'];
         },
         get cachedBytes() {
            return this.serverStatus.wiredTiger.cache['bytes currently in the cache'];
         },
         get cacheUtil() {
            return Number.parseFloat(((this.cachedBytes / this.cacheSizeBytes) * 100).toFixed(2));
         },
         get cacheStatus() {
            return (this.cacheUtil < this.evictionTarget) ? 'low'
                 : (this.cacheUtil > this.evictionTrigger) ? 'high'
                 : 'medium';
         },
         get dirtyUtil() {
            return Number.parseFloat(((this.dirtyBytes / this.cacheSizeBytes) * 100).toFixed(2));
         },
         get dirtyStatus() {
            return (this.dirtyUtil < this.evictionDirtyTarget) ? 'low'
                 : (this.dirtyUtil > this.evictionDirtyTrigger) ? 'high'
                 : 'medium';
         },
         get dirtyUpdatesUtil() {
            return Number.parseFloat(((this.updatesDirtyBytes / this.cacheSizeBytes) * 100).toFixed(2));
         },
         get dirtyUpdatesStatus() {
            return (this.dirtyUpdatesUtil < this.evictionUpdatesTarget) ? 'low'
                 : (this.dirtyUpdatesUtil > this.evictionUpdatesTrigger) ? 'high'
                 : 'medium';
         },
         get cacheEvictions() {
            return (this.cacheUtil > this.evictionTrigger);
         },
         get dirtyCacheEvictions() {
            return (this.dirtyUtil > this.evictionDirtyTrigger);
         },
         get dirtyUpdatesCacheEvictions() {
            return (this.dirtyUpdatesUtil > this.evictionUpdatesTrigger);
         },
         get evictionsTriggered() {
            return (this.cacheEvictions || this.dirtyCacheEvictions || this.dirtyUpdatesCacheEvictions);
         },
         get cacheHitRatio() {
            const hitBytes = this.serverStatus.wiredTiger.cache['pages requested from the cache'];
            const missBytes = this.serverStatus.wiredTiger.cache['pages read into cache'];
            return Number.parseFloat((100 * (hitBytes - missBytes) / hitBytes).toFixed(2));
         },
         get cacheHitStatus() {
            return (this.cacheHitRatio < 20) ? 'high'
                 : (this.cacheHitRatio > 75) ? 'low'
                 : 'medium';
         },
         get cacheMissRatio() {
            const hitBytes = this.serverStatus.wiredTiger.cache['pages requested from the cache'];
            const missBytes = this.serverStatus.wiredTiger.cache['pages read into cache'];
            return Number.parseFloat((100 * (1 - (hitBytes - missBytes) / hitBytes)).toFixed(2));
         },
         get cacheMissStatus() {
            return (this.cacheMissRatio < 20) ? 'low'
                 : (this.cacheMissRatio > 75) ? 'high'
                 : 'medium';
         },
         get memSizeBytes() {
            // return (this?.hostInfo?.system?.memSizeMB ?? 1024) * 1024 * 1024;
            return (this?.hostInfo?.system?.memLimitMB ?? 1024) * 1024 * 1024;
         },
         get numCores() {
            // else max 4 is probably a good default aligning with concurrency limits
            return this?.hostInfo?.system?.numCores ?? 4;
         },
         get memResidentBytes() {
            return (this.serverStatus.mem?.resident ?? 0) * 1024 * 1024;
         },
         get currentAllocatedBytes() {
            return +(this.serverStatus?.tcmalloc?.generic?.current_allocated_bytes ?? 0);
         },
         get heapSize() {
            return +(this.serverStatus?.tcmalloc?.generic?.heap_size ?? (this.memSizeBytes / 64));
         },
         get heapUtil() {
            return Number.parseFloat((100 * (this.currentAllocatedBytes / this.heapSize)).toFixed(2));
         },
         get pageheapFreeBytes() {
            // assume zero fragmentation if we cannot measure pageheap_free_bytes
            return +(this.serverStatus?.tcmalloc?.tcmalloc?.pageheap_free_bytes ?? 0);
         },
         get totalFreeBytes() {
            return +(this.serverStatus?.tcmalloc?.tcmalloc?.total_free_bytes ?? 0);
         },
         get memoryFragmentationRatio() {
            return Number.parseFloat(((this.pageheapFreeBytes / this.memSizeBytes) * 100).toFixed(2));
         },
         get memoryFragmentationStatus() {
            // mimicing the (bad) t2 derived metric for now
            return (this.memoryFragmentationRatio < 10) ? 'low'  // 25 is more realistic
                 : (this.memoryFragmentationRatio > 30) ? 'high' // 50 is more realistic
                 : 'medium';
         },
         get backupCursorOpen() {
            return this.serverStatus.storageEngine.backupCursorOpen;
         },
         // WT tickets available
         // v6.0 (and older)
         // {
         //    write: { out: 0, available: 128, totalTickets: 128 },
         //    read: { out: 0, available: 128, totalTickets: 128 }
         //  }
         // v7.0+
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
         // v8.0 see db.serverStats().queues.execution
         get wtReadTicketsUtil() {
            const { out, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read;
            return Number.parseFloat(((out / totalTickets) * 100).toFixed(2));
         },
         get wtReadTicketsAvail() {
            const { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read;
            return Number.parseFloat(((available / totalTickets) * 100).toFixed(2));
         },
         get wtWriteTicketsUtil() {
            const { out, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write;
            return Number.parseFloat(((out / totalTickets) * 100).toFixed(2));
         },
         get wtWriteTicketsAvail() {
            const { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write;
            return Number.parseFloat(((available / totalTickets) * 100).toFixed(2));
         },
         get wtReadTicketsStatus() {
            return (this.wtReadTicketsUtil < 20) ? 'low'
                 : (this.wtReadTicketsUtil > 75) ? 'high'
                 : 'medium';
         },
         get wtWriteTicketsStatus() {
            return (this.wtWriteTicketsUtil < 20) ? 'low'
                 : (this.wtWriteTicketsUtil > 75) ? 'high'
                 : 'medium';
         },
         get activeShardMigrations() {
            const { currentMigrationsDonating, currentMigrationsReceiving } = this.serverStatus.tenantMigrations;
            return (currentMigrationsDonating > 0 || currentMigrationsReceiving > 0);
         },
         get activeFlowControl() {
            return (this.serverStatus.flowControl.isLagged === true && this.serverStatus.flowControl.enabled === true);
         },
         get activeIndexBuilds() {
            return (this.serverStatus?.indexBuilds?.total ?? 0) > (this.serverStatus?.indexBuilds?.phases?.commit ?? 0) || (this.serverStatus?.activeIndexBuilds?.total ?? 0) > 0;
         },
         get activeCheckpoint() {
            return !!(this.serverStatus.wiredTiger.transaction?.['transaction checkpoint currently running'] || this.serverStatus.wiredTiger?.checkpoint?.['progress state']);
         },
         get slowRecentCheckpoint() {
            return (this.serverStatus.wiredTiger.transaction['transaction checkpoint most recent time (msecs)'] > 60000);
         },
         get checkpointRuntimeRatio() {
            return Number.parseFloat((((this.serverStatus.wiredTiger.transaction?.['transaction checkpoint most recent time (msecs)'] ?? this.serverStatus.wiredTiger.checkpoint?.['most recent time (msecs)']) / this.checkpointIntervalMS) * 100).toFixed(2));
         },
         get checkpointStatus() {
            return (this.checkpointRuntimeRatio < 50) ? 'low'
                 : (this.checkpointRuntimeRatio > 100) ? 'high'
                 : 'medium';
         },
         get activeReplLag() { // calculate the highest repl-lag from healthy members
            const members = this.rsStatus?.members;
            if (!Array.isArray(members) || members.length === 0) return 0;
            const opTimers = members.map(({
               stateStr,
               health,
               optimeDate
            } = {}) => {
               return {
                  "stateStr": stateStr,
                  "health": health,
                  "optimeDate": optimeDate
               };
            }).filter(({ health, stateStr }) => {
               return (health && (stateStr === 'PRIMARY' || stateStr === 'SECONDARY'));
            }).map(({ optimeDate }) => optimeDate).filter(optimeDate => optimeDate != null);
            if (opTimers.length === 0) return 0;
            return +((Math.max(...opTimers) - Math.min(...opTimers)) / 1000).toFixed(0);
         },
         get replLagStatus() {
            return (this.activeReplLag < this.heartbeatIntervalMillis / 1000) ? 'low'
                 : (this.activeReplLag > 90) ? 'high' // maxStalenessSeconds
                 : 'medium';
         },
         get replLagScale() {
            return 30;
         },
         get heartbeatIntervalMillis() {
            return this.rsStatus?.heartbeatIntervalMillis ?? 2000;
         }
      };
      return vitalsView;
   }

   function ewmaStep(prev, sample, alpha = EWMA_ALPHA) {
      if (sample == null || Number.isNaN(+sample)) return prev;
      sample = +sample;
      if (prev == null || Number.isNaN(prev)) return sample;
      return alpha * sample + (1 - alpha) * prev;
   }

   function updateEwma(sample) {
      /*
       *  Update smoothed util series from a vitals snapshot (called each sample).
       *  admissionControl bands on these values instead of raw point samples.
       */
      if (sample == null || typeof sample !== 'object') return;
      try {
         ewma.cacheUtil = ewmaStep(ewma.cacheUtil, sample.cacheUtil);
         ewma.dirtyUtil = ewmaStep(ewma.dirtyUtil, sample.dirtyUtil);
         ewma.dirtyUpdatesUtil = ewmaStep(ewma.dirtyUpdatesUtil, sample.dirtyUpdatesUtil);
         ewma.wtWriteTicketsUtil = ewmaStep(ewma.wtWriteTicketsUtil, sample.wtWriteTicketsUtil);
      } catch(e) {
         // getters may throw if serverStatus shape is incomplete; keep prior ewma
      }
   }

   function bandStatus(util, lowMax, highMin) {
      if (util == null || Number.isNaN(util)) return 'medium';
      return (util < lowMax) ? 'low'
           : (util > highMin) ? 'high'
           : 'medium';
   }

   function utilAbove(util, min) {
      return util != null && !Number.isNaN(util) && util > min;
   }

   function utilAtOrBelow(util, max) {
      return util == null || Number.isNaN(util) || util <= max;
   }

   function utilInBand(util, lo, hi) {
      return util != null && !Number.isNaN(util) && util >= lo && util <= hi;
   }

   function fillProgress(util, target, trigger) {
      // 0 at target (or below), 1 at/above trigger — fraction through the soft band.
      if (util == null || Number.isNaN(+util)) return 0;
      const span = trigger - target;
      if (!(span > 0)) return (+util > trigger) ? 1 : 0;
      return Math.min(1, Math.max(0, (+util - target) / span));
   }

   function progressiveThrottleDelay(dirtyUtil, dirtyUpdatesUtil, {
      evictionDirtyTarget,
      evictionDirtyTrigger,
      evictionUpdatesTarget,
      evictionUpdatesTrigger
   } = {}) {
      /*
       *  Map EWMA dirty/updates fill through [target, trigger] → [min, max] ms.
       *  Uses the more stressed of the two signals; light ±20% jitter for desync.
       */
      const t = Math.max(
         fillProgress(dirtyUtil, evictionDirtyTarget, evictionDirtyTrigger),
         fillProgress(dirtyUpdatesUtil, evictionUpdatesTarget, evictionUpdatesTrigger)
      );
      const delay = THROTTLE_DELAY_MIN_MS + (THROTTLE_DELAY_MAX_MS - THROTTLE_DELAY_MIN_MS) * t;
      const jitter = 0.8 + Math.random() * 0.4;
      return Math.floor(delay * jitter);
   }

   async function vitalsSampler(intervalMs = VITALS_SAMPLE_INTERVAL_MS) {
      /*
       *  Vitals are sampled on a background loop (decoupled from task scheduling);
       *  EWMA is updated here; admissionControl reads the smoothed series.
       *  Sleeps first so the caller's initial sample is not immediately repeated.
       */
      while (vitalsSampling) {
         await sleep(intervalMs);
         if (!vitalsSampling) break;
         try {
            vitals = await congestionMonitor();
            updateEwma(vitals);
         } catch(e) {
            console.log('\t[WARN] vitals sample failed:', e);
         }
      }
   }

   function admissionControl() {
      /*
       *  Admission FSM with hysteresis (see https://jira.mongodb.org/browse/SPM-1123):
       *    OPEN     — admit freely (optional ticket+checkpoint pacing)
       *    THROTTLE — admit with progressive delay from dirty/updates fill (target→trigger)
       *    CLOSED   — wait; trip at *Trigger, release only at/under *Target
       *    COOLDOWN — after CLOSED, brief paced resume to avoid thundering herd
       *  Inputs: EWMA-smoothed utils; checkpointStatus stays raw (sticky ratio).
       */

      const {
         evictionTarget = 80,
         evictionTrigger = 95,
         evictionDirtyTarget = 5,
         evictionDirtyTrigger = 20,
         evictionUpdatesTarget = 2.5,
         evictionUpdatesTrigger = 10
      } = vitals;

      // Prefer EWMA; fall back to raw vitals until the first successful updateEwma().
      const cacheUtil = ewma.cacheUtil ?? vitals.cacheUtil;
      const dirtyUtil = ewma.dirtyUtil ?? vitals.dirtyUtil;
      const dirtyUpdatesUtil = ewma.dirtyUpdatesUtil ?? vitals.dirtyUpdatesUtil;
      const wtWriteTicketsUtil = ewma.wtWriteTicketsUtil ?? vitals.wtWriteTicketsUtil;

      const hardPressure = utilAbove(cacheUtil, evictionTrigger)
         || utilAbove(dirtyUtil, evictionDirtyTrigger)
         || utilAbove(dirtyUpdatesUtil, evictionUpdatesTrigger);
      // Soft pressure mirrors prior "medium dirty/updates" throttle (cache medium alone does not throttle).
      const softPressure = utilInBand(dirtyUtil, evictionDirtyTarget, evictionDirtyTrigger)
         || utilInBand(dirtyUpdatesUtil, evictionUpdatesTarget, evictionUpdatesTrigger);
      const releaseOk = utilAtOrBelow(cacheUtil, evictionTarget)
         && utilAtOrBelow(dirtyUtil, evictionDirtyTarget)
         && utilAtOrBelow(dirtyUpdatesUtil, evictionUpdatesTarget);
      const clearPressure = releaseOk && !softPressure;

      const now = Date.now();
      switch (admissionState) {
         case 'OPEN':
            if (hardPressure) admissionState = 'CLOSED';
            else if (softPressure) admissionState = 'THROTTLE';
            break;
         case 'THROTTLE':
            if (hardPressure) admissionState = 'CLOSED';
            else if (clearPressure) admissionState = 'OPEN';
            break;
         case 'CLOSED':
            // Hysteresis: do not reopen at the trigger line — wait until at/under targets.
            if (releaseOk) {
               admissionState = 'COOLDOWN';
               admissionCooldownUntil = now + ADMISSION_COOLDOWN_MS;
            }
            break;
         case 'COOLDOWN':
            if (hardPressure) {
               admissionState = 'CLOSED';
            } else if (now >= admissionCooldownUntil) {
               admissionState = softPressure ? 'THROTTLE' : 'OPEN';
            }
            break;
         default:
            admissionState = 'OPEN';
      }

      if (admissionState === 'CLOSED') {
         return { "state": admissionState, "proceed": false, "delayMs": 0 };
      }

      if (admissionState === 'THROTTLE' || admissionState === 'COOLDOWN') {
         return {
            "state": admissionState,
            "proceed": true,
            "delayMs": progressiveThrottleDelay(dirtyUtil, dirtyUpdatesUtil, {
               evictionDirtyTarget,
               evictionDirtyTrigger,
               evictionUpdatesTarget,
               evictionUpdatesTrigger
            })
         };
      }

      // OPEN: light pacing only when write tickets and checkpoint are both hot
      const wtWriteTicketsStatus = bandStatus(wtWriteTicketsUtil, 20, 75);
      const { checkpointStatus } = vitals;
      const delayMs = (wtWriteTicketsStatus == 'high' && checkpointStatus == 'high')
         ? Math.floor(100 + Math.random() * 100)
         : 0;
      return { "state": admissionState, "proceed": true, "delayMs": delayMs };
   }

   async function* prepend(first, rest) {
      yield first;
      yield* rest;
   }

   async function* asyncPool(tasks = [], method = () => {}, { poolSize = 1, onSchedule, onWait, onLaunch } = {}) {
      /*
       *  Prefetch up to 4 buckets (capped by poolSize) so getMore overlaps
       *  in-flight deletes. Do not wait for a full prefetch before the first
       *  slot: schedule as soon as one bucket is available, top up only while
       *  parked or waiting on a slot. Admission parks/paces before a slot is
       *  taken; executing only holds deleteMany/txn work.
       */
      const executing = new Set();
      const buf = [];
      const prefetch = Math.min(4, poolSize);
      let srcDone = false;
      const source = (typeof tasks[Symbol.asyncIterator] === 'function')
         ? tasks[Symbol.asyncIterator]()
         : (async function*() { for (const task of tasks) yield task; })();

      async function fill(target = prefetch) {
         while (buf.length < target && !srcDone) {
            const { 'value': value, 'done': done } = await source.next();
            if (done) {
               srcDone = true;
               break;
            }
            buf.push(value);
         }
      }

      async function consume() {
         const [taskPromise, outcome] = await Promise.race(executing);
         executing.delete(taskPromise);
         if (outcome.ok === false) throw outcome.error;
         return outcome.value;
      }

      function schedule(task) {
         /*
          *  Wrap method() in an async fn to ensure we get a promise.
          *  Then expose such promise, so it's possible to later reference
          *  and remove it from the executing pool. Both fulfillment and
          *  rejection settle to a tuple so consume() can always delete.
          */
         if (typeof onSchedule === 'function') onSchedule(task);
         const taskPromise = (async() => method(task))().then(
            value => [taskPromise, { "ok": true, "value": value }],
            error => [taskPromise, { "ok": false, "error": error }]
         );
         executing.add(taskPromise);
      }

      await fill(1);

      while (buf.length || executing.size || !srcDone) {
         let admission = admissionControl(); // { state, proceed, delayMs }
         while (!admission.proceed) {
            if (typeof onWait === 'function') onWait(buf[0]?.bucketId, admission);
            await fill();
            if (executing.size) {
               yield await consume();
               await fill();
            } else {
               await sleep(Math.floor(500 + Math.random() * 500));
            }
            admission = admissionControl();
         }
         if (admission.delayMs > 0) await sleep(admission.delayMs);

         if (executing.size >= poolSize) {
            yield await consume();
            await fill(1);
         }

         if (!buf.length) {
            await fill(1);
            if (!buf.length) {
               while (executing.size) yield await consume();
               break;
            }
         }

         if (executing.size >= poolSize) continue;

         const task = buf.shift();
         if (typeof onLaunch === 'function') onLaunch(task, admission);
         schedule(task);
      }
   }

   async function main() {
      vitals = await congestionMonitor(); // initial snapshot before scheduling
      updateEwma(vitals);
      vitalsSampling = true;
      const sampler = vitalsSampler();
      try {
         const { numCores } = vitals;
         const concurrency = Math.max((numCores > 4) ? numCores : 4, 32); // admission control throttles; do not chase live write tickets
         const bucketSizeLimit = 100; // aligns with SPM-2227
         const readConcern = { "level": "local" }, writeConcern = { "w": "majority" }; // support monotonic writes
         /*
          *  Curation uses secondaryPreferred; deletes and residual count use
          *  primary (count: majority RC).
          */
         const curationReadPreference = {
            // "mode": "nearest", // offload the bucket generation to a less busy node
            "mode": "secondaryPreferred",
            "tags": [ // Atlas friendly defaults
               { "nodeType": "READ_ONLY", "diskState": "READY" },
               { "nodeType": "ANALYTICS", "diskState": "READY" },
               { "workloadType": "OPERATIONAL", "diskState": "READY" },
               { "diskState": "READY" },
               {}
            ]
         };
         const writeReadPreference = { "mode": "primary" };
         const readSessionOpts = {
            "causalConsistency": true,
            "readConcern": readConcern,
            "readPreference": curationReadPreference
         };
         const writeSessionOpts = {
            "causalConsistency": true,
            "readConcern": readConcern,
            "readPreference": writeReadPreference,
            "retryWrites": true,
            "writeConcern": writeConcern
         };
         const countSessionOpts = {
            "causalConsistency": true,
            "readConcern": { "level": "majority" },
            "readPreference": writeReadPreference
         };
         banner = `\n\x1b[33m${banner}\x1b[0m`;
         banner += `\n\nCurating '\x1b[32m_id\x1b[0m' deletion list from namespace:` +
                   `\n\n\t\x1b[32m${dbName}.${collName}\x1b[0m` +
                   `\n\nwith filter:` +
                   `\n\n\t\x1b[32m${JSON.stringify(filter)}\x1b[0m` +
                   `\n\n...please wait\n`;
         if (safeguard) {
            banner += '\n\x1b[31mWarning:\x1b[0m \x1b[32mSafeguard is enabled, simulating deletes only (via transaction rollbacks)\n\x1b[0m';
         }
         // eventually replace this with progress meters
         console.clear();
         console.log(banner);
         const deletionList = getIds(filter, bucketSizeLimit, readSessionOpts);
         const { 'value': initialBatch, 'done': initialEmptyBatch } = await deletionList.next();
         if (initialEmptyBatch === true) {
            console.log('\tNo matching documents found to match the filter, double-check the namespace and filter');
         } else {
            // initial batch
            // let msg = `\nForking ${initialBatch.bucketsTotal} batches of ${initialBatch.bucketSizeLimit} documents with concurrency execution of ${concurrency} to delete ${initialBatch.IDsTotal} documents`;
            let msg = `\nUp to ${concurrency} concurrent deletes of ${initialBatch.bucketSizeLimit} documents`;
            banner += msg;
            console.log(msg);
            for await (const [bucketId, deletedCount] of asyncPool(
               prepend(initialBatch, deletionList),
               task => deleteManyTask(task, writeSessionOpts),
               {
                  "poolSize": concurrency,
                  onSchedule(task) {
                     // let msg = `\n\n\tScheduling batch ${task.bucketId} with ${task.bucketsRemaining} buckets queued remaining:\n`;
                     const msg = `\n\n\tScheduling task batch# ${task.bucketId}:\n`;
                     console.clear();
                     console.log(banner + msg);
                  },
                  onWait(bucketId, admission) {
                     console.log('\t\t...batch', bucketId ?? '-', 'is awaiting scheduling due to back pressure (state:', admission?.state ?? 'CLOSED', ')');
                  },
                  onLaunch(task, admission) {
                     console.log('\t\t...batch', task.bucketId, 'executing (state:', admission.state, 'buffering:', admission.delayMs, 'ms)');
                  }
               }
            )) {
               console.log('\t\t...batch#', bucketId, 'deleted', deletedCount, 'documents');
            }
         }
         console.log(`\nValidating deletion results ...please wait\n`);
         console.log('...you may CTRL+C here to exit gracefully if validation is not required\n');
         const finalCount = countIds(filter, countSessionOpts);
         if (safeguard) {
            console.log('Simulation safeguard is enabled, no deletions were actually performed:\n');
         }
         // console.log('\tInitial document count matching filter:', (initialEmptyBatch === true) ? 0 : initialBatch.IDsTotal);
         console.log('\tResidual document count matching filter:', finalCount);
         console.log('\nDone!');
      } finally {
         vitalsSampling = false;
         await sampler;
      }
   }

   await main();
})();

// EOF
