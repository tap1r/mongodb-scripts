(async() => {
   /*
    *  Name: "congestionMonitor.js"
    *  Version: "0.3.3"
    *  Description: "realtime monitor for mongod congestion vitals, designed for use with client side admission control"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *  Guide: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/mongosh-scripting-guide.md"
    *  Roadmap: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/ROADMAP.md" (required context)
    *
    *  Legacy archive line: v0.2.13 is the snapshot for this script. mongosh-only
    *  (incompatible with legacy mongo); still the demarked version for the
    *  whole-tree freeze. Archive `.finally(process.stdout.write(…))` is wontfix
    *  on that line. Live wraps `.finally(() => process.stdout.write(…))`.
    *  Mongos: child mongodb:// to shard primaries (collection owners when
    *  dbName/collName are set via --eval var, else all listShards); worst-shard
    *  fold. URI construction matches niceDeleteMany.js. Do not load() that file.
    */

   // Usage: mongosh [connection options] [--quiet] [--eval 'var dbName="...", collName="..."'] [-f|--file] </path/to/>congestionMonitor.js

   let vitals = {};
   const pollingIntervalMS = 100;
   // TTL caches: serverStatus is hot-path; hostInfo is near-static; rsStatus is low/medium volatility.
   const SERVER_STATUS_CACHE_TTL_MS = pollingIntervalMS;
   const HOST_INFO_CACHE_TTL_MS = 60 * 1000;
   const RS_STATUS_CACHE_TTL_MS = 10 * 1000;
   const GET_PARAMETER_CACHE_TTL_MS = 60 * 1000;
   const _serverStatusCache = { "key": null, "at": 0, "value": null, "inflight": null };
   const _hostInfoCache = { "at": 0, "value": null };
   const _rsStatusCache = { "at": 0, "value": null };
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
   const SERVER_STATUS_OPT_IN = { // minimal metrics for congestion display
      "activeIndexBuilds": true,
      "flowControl": true,
      "indexBuilds": true,
      "mem": true,
      "metrics": true,
      "queues": true,
      "shardingStatistics": true,
      "storageEngine": true,
      "tenantMigrations": true,
      "tcmalloc": true,
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

   function isSharded() {
      /*
       *  is mongos process
       */
      return db.hello().msg === 'isdbgrid';
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
         // console.debug(`\x1b[31m[WARN] insufficient rights to execute db.hostInfo()\n${error}\x1b[0m`);
      }
      _hostInfoCache.value = hostInfo;
      _hostInfoCache.at = now;
      return hostInfo;
   }

   function rsStatus() {
      // Member set/health changes slowly; optimes move faster. 10s balances lag freshness vs rs.status() cost.
      const now = Date.now();
      if (_rsStatusCache.value !== null && (now - _rsStatusCache.at) < RS_STATUS_CACHE_TTL_MS) {
         return _rsStatusCache.value;
      }
      let rsStatus = {};
      try {
         rsStatus = rs.status();
      } catch(e) {
         // console.debug(`\x1b[31m[WARN] insufficient rights to execute rs.status()\n${error}\x1b[0m`);
      }
      _rsStatusCache.value = rsStatus;
      _rsStatusCache.at = now;
      return rsStatus;
   }

   function evictionConfigFromWterc(wterc = '') {
      // WT eviction defaults (https://kb.corp.mongodb.com/article/000019073)
      // evictionDirtyTarget:    overall targets but only apply to dirty data in cache
      // evictionDirtyTrigger:   application threads throttle at eviction_dirty_trigger
      // evictionTarget:         overall cache usage target
      // evictionTrigger:        application threads start eviction
      // evictionUpdatesTarget:  worker eviction when cache holds this many update bytes
      // evictionUpdatesTrigger: application threads evict when updates reach this many bytes
      const cfg = String(wterc || '');
      const num = (re, d) => {
         const m = cfg.match(re);
         return m ? +m[1] : d;
      };
      return {
         "evictionThreadsMin": num(/eviction=\(.*threads_min=(\d+).*\)/, 4),
         "evictionThreadsMax": num(/eviction=\(.*threads_max=(\d+).*\)/, 4),
         "evictionCheckpointTarget": num(/eviction_checkpoint_target=(\d+)/, 1),
         "evictionDirtyTarget": num(/eviction_dirty_target=(\d+)/, 5),
         "evictionDirtyTrigger": num(/eviction_dirty_trigger=(\d+)/, 20),
         "evictionTarget": num(/eviction_target=(\d+)/, 80),
         "evictionTrigger": num(/eviction_trigger=(\d+)/, 95),
         "evictionUpdatesTarget": num(/eviction_updates_target=(\d+)/, 2.5),
         "evictionUpdatesTrigger": num(/eviction_updates_trigger=(\d+)/, 10),
         "checkpointIntervalMS": 1000 * num(/checkpoint=\(.*wait=(\d+).*\)/, 60)
      };
   }

   function ticketPool(ss, kind) {
      return ss.wiredTiger?.concurrentTransactions?.[kind]
         ?? ss.queues?.execution?.[kind]
         ?? {};
   }

   function ticketUtil(pool) {
      const total = +(pool.totalTickets ?? 0);
      if (!(total > 0)) return 0;
      return Number.parseFloat(((+(pool.out ?? 0) / total) * 100).toFixed(2));
   }

   function ticketAvail(pool) {
      const total = +(pool.totalTickets ?? 0);
      if (!(total > 0)) return 0;
      return Number.parseFloat(((+(pool.available ?? 0) / total) * 100).toFixed(2));
   }

   function execQueueLength(pool = {}, priority) {
      // 8.0+ nests queueLength under normalPriority / lowPriority; 7.x / early 8.0
      // keep it on the kind document.
      if (priority) return +(pool[priority]?.queueLength ?? 0);
      return +(pool.queueLength ?? pool.normalPriority?.queueLength ?? 0);
   }

   function execQueuedMicros(pool = {}, priority) {
      // Lifetime counter. Kind-level totalTimeQueuedMicros if present, else the
      // sum of nested buckets. priority picks one nested bucket only.
      if (priority) return +(pool[priority]?.totalTimeQueuedMicros ?? 0);
      if (pool.totalTimeQueuedMicros != null) return +(pool.totalTimeQueuedMicros);
      let sum = 0;
      for (const key of ['normalPriority', 'lowPriority', 'exempt', 'deprioritizable', 'nonDeprioritizable']) {
         const v = pool[key]?.totalTimeQueuedMicros;
         if (v != null) sum += +v;
      }
      return sum;
   }

   function execQueueStatus(n) {
      return (n < 1) ? 'low' : (n >= 8) ? 'high' : 'medium';
   }

   const _queuedPrev = Object.create(null);
   function stampQueuedWait(snap = {}, key = 'local') {
      // Interval wait from lifetime totalTimeQueuedMicros (ms of wait this poll).
      // Keyed by shard id (or 'local' on mongod) so a worst-shard fold cannot
      // mix lifetime counters from different primaries. First sample is 0.
      const now = Date.now();
      const read = +(snap.execReadTotalTimeQueuedMicros ?? 0);
      const write = +(snap.execWriteTotalTimeQueuedMicros ?? 0);
      const prev = _queuedPrev[key];
      let readWait = 0;
      let writeWait = 0;
      if (prev && now > prev.at) {
         readWait = Math.max(0, read - prev.read) / 1000;
         writeWait = Math.max(0, write - prev.write) / 1000;
      }
      snap.execReadQueuedWaitMs = Number.parseFloat(readWait.toFixed(0));
      snap.execWriteQueuedWaitMs = Number.parseFloat(writeWait.toFixed(0));
      snap.execQueuedWaitScale = 1000;
      snap.executionControlDeprioritizationScale = 1;
      snap.usesThroughputProbingScale = 1;
      snap.execReadQueuedWaitStatus = (readWait < 10) ? 'low' : (readWait >= 100) ? 'high' : 'medium';
      snap.execWriteQueuedWaitStatus = (writeWait < 10) ? 'low' : (writeWait >= 100) ? 'high' : 'medium';
      _queuedPrev[key] = { "at": now, "read": read, "write": write };
      return snap;
   }

   function cachePct(num, den) {
      if (!(den > 0) || num == null || Number.isNaN(+num)) return 0;
      return Number.parseFloat(((+num / den) * 100).toFixed(2));
   }

   function replLagSeconds(rsSt = {}) {
      const members = rsSt?.members;
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
   }

   function vitalsFromServerStatus({
      ss = {},
      rsSt = {},
      host = {},
      wterc = '',
      executionControlDeprioritizationGate = false
   } = {}) {
      /*
       *  Plain congestion snapshot each poll. EQ bars read these fields as
       *  data properties. Missing WT / queues / shardingStatistics stay 0/false.
       *  Exploratory, not sampled: getProfilingStatus().slowms (latency band)
       *  and wiredTigerConcurrentRead/WriteTransactions (configured ticket
       *  caps, redundant with ticketPool totalTickets). AIMD stays off these.
       */
      const cache = ss.wiredTiger?.cache ?? {};
      const eviction = evictionConfigFromWterc(wterc);
      const cacheSizeBytes = +(cache['maximum bytes configured'] ?? NaN);
      const dirtyBytes = +(cache['tracked dirty bytes in the cache'] ?? 0);
      const cachedBytes = +(cache['bytes currently in the cache'] ?? 0);
      const updatesDirtyBytes = +(cache['bytes allocated for updates'] ?? 0);
      const dirtyIntlBytes = +(cache['tracked dirty internal page bytes in the cache'] ?? 0);
      const dirtyLeafBytes = +(cache['tracked dirty leaf page bytes in the cache'] ?? 0);
      const cacheUtil = cachePct(cachedBytes, cacheSizeBytes);
      const dirtyUtil = cachePct(dirtyBytes, cacheSizeBytes);
      const dirtyUpdatesUtil = cachePct(updatesDirtyBytes, cacheSizeBytes);
      const dirtyIntlUtil = cachePct(dirtyIntlBytes, cacheSizeBytes);
      const dirtyLeafUtil = cachePct(dirtyLeafBytes, cacheSizeBytes);
      const readTickets = ticketPool(ss, 'read');
      const writeTickets = ticketPool(ss, 'write');
      const wtReadTicketsUtil = ticketUtil(readTickets);
      const wtWriteTicketsUtil = ticketUtil(writeTickets);
      const checkpointMs = +(ss.wiredTiger?.transaction?.['transaction checkpoint most recent time (msecs)']
         ?? ss.wiredTiger?.checkpoint?.['most recent time (msecs)']
         ?? 0);
      const checkpointRuntimeRatio = Number.parseFloat(
         ((checkpointMs / eviction.checkpointIntervalMS) * 100).toFixed(2)
      );
      const hitBytes = +(cache['pages requested from the cache'] ?? 0);
      const missBytes = +(cache['pages read into cache'] ?? 0);
      const cacheHitRatio = hitBytes > 0
         ? Number.parseFloat((100 * (hitBytes - missBytes) / hitBytes).toFixed(2))
         : 0;
      const cacheMissRatio = hitBytes > 0
         ? Number.parseFloat((100 * (1 - (hitBytes - missBytes) / hitBytes)).toFixed(2))
         : 0;
      const memSizeBytes = (host?.system?.memLimitMB ?? 1024) * 1024 * 1024;
      const currentAllocatedBytes = +(ss.tcmalloc?.generic?.current_allocated_bytes ?? 0);
      const heapSize = +(ss.tcmalloc?.generic?.heap_size ?? (memSizeBytes / 64));
      const pageheapFreeBytes = +(ss.tcmalloc?.tcmalloc?.pageheap_free_bytes ?? 0);
      const totalFreeBytes = +(ss.tcmalloc?.tcmalloc?.total_free_bytes ?? 0);
      const memoryFragmentationRatio = Number.parseFloat(((pageheapFreeBytes / memSizeBytes) * 100).toFixed(2));
      const heartbeatIntervalMillis = rsSt?.heartbeatIntervalMillis ?? 2000;
      const activeReplLag = replLagSeconds(rsSt);
      const exec = ss.queues?.execution ?? {};
      const writeQ = exec.write ?? {};
      const readQ = exec.read ?? {};
      const readQLen = execQueueLength(readQ);
      const writeQLen = execQueueLength(writeQ);
      const readLpQ = execQueueLength(readQ, 'lowPriority');
      const writeLpQ = execQueueLength(writeQ, 'lowPriority');
      const deprioGate = !!executionControlDeprioritizationGate;
      const tm = ss.tenantMigrations ?? {};
      return {
         ...eviction,
         "cacheSizeBytes": cacheSizeBytes,
         "dirtyBytes": dirtyBytes,
         "cachedBytes": cachedBytes,
         "updatesDirtyBytes": updatesDirtyBytes,
         "dirtyIntlBytes": dirtyIntlBytes,
         "dirtyLeafBytes": dirtyLeafBytes,
         "cacheUtil": cacheUtil,
         "dirtyUtil": dirtyUtil,
         "dirtyUpdatesUtil": dirtyUpdatesUtil,
         "dirtyIntlUtil": dirtyIntlUtil,
         "dirtyLeafUtil": dirtyLeafUtil,
         "cacheStatus": (cacheUtil < eviction.evictionTarget) ? 'low'
            : (cacheUtil >= eviction.evictionTrigger) ? 'high'
            : 'medium',
         "dirtyStatus": (dirtyUtil < eviction.evictionDirtyTarget) ? 'low'
            : (dirtyUtil >= eviction.evictionDirtyTrigger) ? 'high'
            : 'medium',
         "dirtyUpdatesStatus": (dirtyUpdatesUtil < eviction.evictionUpdatesTarget) ? 'low'
            : (dirtyUpdatesUtil >= eviction.evictionUpdatesTrigger) ? 'high'
            : 'medium',
         "dirtyIntlStatus": (dirtyIntlUtil < eviction.evictionDirtyTarget) ? 'low'
            : (dirtyIntlUtil >= eviction.evictionDirtyTrigger) ? 'high'
            : 'medium',
         "dirtyLeafStatus": (dirtyLeafUtil < eviction.evictionDirtyTarget) ? 'low'
            : (dirtyLeafUtil >= eviction.evictionDirtyTrigger) ? 'high'
            : 'medium',
         "cacheEvictions": (cacheUtil > eviction.evictionTrigger),
         "dirtyCacheEvictions": (dirtyUtil >= eviction.evictionDirtyTrigger),
         "dirtyUpdatesCacheEvictions": (dirtyUpdatesUtil >= eviction.evictionUpdatesTrigger),
         "evictionsTriggered": (cacheUtil > eviction.evictionTrigger)
            || (dirtyUtil >= eviction.evictionDirtyTrigger)
            || (dirtyUpdatesUtil >= eviction.evictionUpdatesTrigger),
         "cacheHitRatio": cacheHitRatio,
         "cacheHitStatus": (cacheHitRatio < 20) ? 'high'
            : (cacheHitRatio >= 75) ? 'low'
            : 'medium',
         "cacheMissRatio": cacheMissRatio,
         "cacheMissStatus": (cacheMissRatio < 20) ? 'low'
            : (cacheMissRatio >= 75) ? 'high'
            : 'medium',
         "memSizeBytes": memSizeBytes,
         "numCores": host?.system?.numCores ?? 4,
         "memResidentBytes": (ss.mem?.resident ?? 0) * 1024 * 1024,
         "currentAllocatedBytes": currentAllocatedBytes,
         "heapSize": heapSize,
         "heapUtil": Number.parseFloat((100 * (currentAllocatedBytes / heapSize)).toFixed(2)),
         "pageheapFreeBytes": pageheapFreeBytes,
         "totalFreeBytes": totalFreeBytes,
         "memoryFragmentationRatio": memoryFragmentationRatio,
         "memoryFragmentationStatus": (memoryFragmentationRatio < 10) ? 'low'
            : (memoryFragmentationRatio >= 30) ? 'high'
            : 'medium',
         "backupCursorOpen": !!ss.storageEngine?.backupCursorOpen,
         "wtReadTicketsUtil": wtReadTicketsUtil,
         "wtReadTicketsAvail": ticketAvail(readTickets),
         "wtWriteTicketsUtil": wtWriteTicketsUtil,
         "wtWriteTicketsAvail": ticketAvail(writeTickets),
         "wtReadTicketsStatus": (wtReadTicketsUtil < 20) ? 'low'
            : (wtReadTicketsUtil >= 75) ? 'high'
            : 'medium',
         "wtWriteTicketsStatus": (wtWriteTicketsUtil < 20) ? 'low'
            : (wtWriteTicketsUtil >= 75) ? 'high'
            : 'medium',
         "execReadQueueLength": readQLen,
         "execWriteQueueLength": writeQLen,
         "execReadQueueStatus": execQueueStatus(readQLen),
         "execWriteQueueStatus": execQueueStatus(writeQLen),
         "execReadLowPriorityQueueLength": readLpQ,
         "execWriteLowPriorityQueueLength": writeLpQ,
         "execReadLowPriorityStatus": execQueueStatus(readLpQ),
         "execWriteLowPriorityStatus": execQueueStatus(writeLpQ),
         "execReadTotalTimeQueuedMicros": execQueuedMicros(readQ),
         "execWriteTotalTimeQueuedMicros": execQueuedMicros(writeQ),
         "execReadLowPriorityQueuedMicros": execQueuedMicros(readQ, 'lowPriority'),
         "execWriteLowPriorityQueuedMicros": execQueuedMicros(writeQ, 'lowPriority'),
         "executionControlDeprioritizationGate": deprioGate,
         "executionControlDeprioritizationStatus": deprioGate ? 'high' : 'low',
         "execQueuedWaitScale": 1000,
         "usesThroughputProbing": !!exec.usesThroughputProbing,
         "usesThroughputProbingStatus": !!exec.usesThroughputProbing ? 'high' : 'low',
         "usesThroughputProbingScale": 1,
         "activeShardMigrations": (tm.currentMigrationsDonating > 0 || tm.currentMigrationsReceiving > 0),
         "activeFlowControl": ss.flowControl?.isLagged === true && ss.flowControl?.enabled === true,
         "activeIndexBuilds": (ss.indexBuilds?.total ?? 0) > (ss.indexBuilds?.phases?.commit ?? 0)
            || (ss.activeIndexBuilds?.total ?? 0) > 0,
         "activeRangeDeleter": +(ss.shardingStatistics?.rangeDeleterTasks ?? 0) > 0,
         "rangeDeleterTasks": +(ss.shardingStatistics?.rangeDeleterTasks ?? 0),
         "activeCheckpoint": !!(ss.wiredTiger?.transaction?.['transaction checkpoint currently running']
            || ss.wiredTiger?.checkpoint?.['progress state']),
         "slowRecentCheckpoint": checkpointMs > 60000,
         "checkpointRuntimeRatio": checkpointRuntimeRatio,
         "checkpointStatus": (checkpointRuntimeRatio < 50) ? 'low'
            : (checkpointRuntimeRatio >= 100) ? 'high'
            : 'medium',
         "activeReplLag": activeReplLag,
         "replLagStatus": (activeReplLag < heartbeatIntervalMillis / 1000) ? 'low'
            : (activeReplLag > 90) ? 'high'
            : 'medium',
         "replLagScale": 30,
         "heartbeatIntervalMillis": heartbeatIntervalMillis
      };
   }

   const VITALS_FOLD_MAX = [
      "cacheSizeBytes", "dirtyBytes", "cachedBytes", "updatesDirtyBytes",
      "dirtyIntlBytes", "dirtyLeafBytes",
      "cacheUtil", "dirtyUtil", "dirtyUpdatesUtil", "dirtyIntlUtil", "dirtyLeafUtil",
      "cacheMissRatio", "memSizeBytes", "numCores", "memResidentBytes",
      "currentAllocatedBytes", "heapSize", "heapUtil",
      "pageheapFreeBytes", "totalFreeBytes", "memoryFragmentationRatio",
      "wtReadTicketsUtil", "wtWriteTicketsUtil",
      "execReadQueueLength", "execWriteQueueLength",
      "execReadLowPriorityQueueLength", "execWriteLowPriorityQueueLength",
      "execReadTotalTimeQueuedMicros", "execWriteTotalTimeQueuedMicros",
      "execReadLowPriorityQueuedMicros", "execWriteLowPriorityQueuedMicros",
      "execReadQueuedWaitMs", "execWriteQueuedWaitMs",
      "rangeDeleterTasks", "checkpointRuntimeRatio", "activeReplLag",
      "replLagScale", "heartbeatIntervalMillis"
   ];
   const VITALS_FOLD_MIN = [
      ["evictionDirtyTarget", 5],
      ["evictionDirtyTrigger", 20],
      ["evictionTarget", 80],
      ["evictionTrigger", 95],
      ["evictionUpdatesTarget", 2.5],
      ["evictionUpdatesTrigger", 10],
      ["evictionCheckpointTarget", 1],
      ["checkpointIntervalMS", 60000],
      ["evictionThreadsMin", 4],
      ["evictionThreadsMax", 4],
      ["wtReadTicketsAvail", 0],
      ["wtWriteTicketsAvail", 0],
      ["cacheHitRatio", 0]
   ];
   const VITALS_FOLD_OR = [
      "cacheEvictions", "dirtyCacheEvictions", "dirtyUpdatesCacheEvictions",
      "evictionsTriggered", "backupCursorOpen", "usesThroughputProbing",
      "executionControlDeprioritizationGate",
      "activeShardMigrations", "activeFlowControl", "activeIndexBuilds",
      "activeRangeDeleter", "activeCheckpoint", "slowRecentCheckpoint"
   ];
   const VITALS_FOLD_STATUS = [
      "cacheStatus", "dirtyStatus", "dirtyUpdatesStatus", "dirtyIntlStatus",
      "dirtyLeafStatus", "cacheHitStatus", "cacheMissStatus",
      "memoryFragmentationStatus", "wtReadTicketsStatus", "wtWriteTicketsStatus",
      "execReadQueueStatus", "execWriteQueueStatus",
      "execReadLowPriorityStatus", "execWriteLowPriorityStatus",
      "execReadQueuedWaitStatus", "execWriteQueuedWaitStatus",
      "executionControlDeprioritizationStatus",
      "usesThroughputProbingStatus",
      "checkpointStatus", "replLagStatus"
   ];

   function hasWiredTigerVitals(sample = {}) {
      const cacheSize = sample?.cacheSizeBytes;
      return cacheSize != null && !Number.isNaN(+cacheSize) && +cacheSize > 0;
   }

   function redactMessage(value) {
      return String(value ?? '').replace(/\/\/[^@/]+@/g, '//');
   }

   function namespaceVarsSet() {
      return typeof dbName === 'string' && dbName.length > 0
         && typeof collName === 'string' && collName.length > 0;
   }

   const SHARD_CONNECT_TIMEOUT_MS = 5000;
   const SHARD_VITALS_SAMPLE_INTERVAL_MS = 2000;
   const REPL_LAG_HARD_SEC = 30;

   let _parentConnectionParts = null;
   function parentConnectionParts() {
      if (_parentConnectionParts) return _parentConnectionParts;
      const rawUri = db.getMongo().getURI();
      if (!rawUri || typeof rawUri !== 'string') throw new Error('missing parent URI');
      const isSrv = /^mongodb\+srv:/i.test(rawUri);
      const stripped = rawUri.replace(/^mongodb\+srv:/i, 'mongodb:');
      const url = new URL(stripped);
      const searchParams = new URLSearchParams(url.searchParams);
      searchParams.delete('srvMaxHosts');
      searchParams.delete('srvServiceName');
      const authority = stripped.replace(/^mongodb:\/\//i, '').split(/[/?]/, 1)[0];
      const at = authority.lastIndexOf('@');
      const hosts = (at >= 0 ? authority.slice(at + 1) : authority) || url.host || '';
      _parentConnectionParts = {
         "isSrv": isSrv,
         "username": url.username || '',
         "password": url.password || '',
         "pathname": url.pathname && url.pathname.length ? url.pathname : '/',
         "searchParams": searchParams,
         "hosts": hosts
      };
      return _parentConnectionParts;
   }

   function createShardVitals() {
      /*
       *  Child Mongo clients to shard primaries. Collection owners when
       *  dbName/collName are set; else all listShards. Public: attach / sample /
       *  close (closeClients) / enabled. Child URI construction matches
       *  niceDeleteMany.js.
       */
      let clients = [];
      let enabled = false;

      function collectionOwningShardIds() {
         const ids = new Set();
         try {
            const stats = db.getSiblingDB(dbName).runCommand({ "collStats": collName });
            if (stats?.shards && typeof stats.shards === 'object') {
               for (const id of Object.keys(stats.shards)) {
                  if (id) ids.add(id);
               }
            }
            if (typeof stats?.primary === 'string' && stats.primary) ids.add(stats.primary);
         } catch(_) { /* missing ns / auth */ }

         if (ids.size) return [...ids];

         try {
            const config = db.getSiblingDB('config');
            const ns = `${dbName}.${collName}`;
            const collDoc = config.getCollection('collections').findOne({
               "$or": [{ "_id": ns }, { "ns": ns }]
            });
            if (collDoc && collDoc.dropped !== true) {
               const chunkFilter = collDoc.uuid ? { "uuid": collDoc.uuid } : { "ns": ns };
               const shards = config.getCollection('chunks').distinct('shard', chunkFilter);
               if (Array.isArray(shards)) {
                  for (const id of shards) {
                     if (id) ids.add(id);
                  }
               }
            }
         } catch(_) { /* config auth */ }

         if (ids.size) return [...ids];

         try {
            const dbDoc = db.getSiblingDB('config').getCollection('databases').findOne({ "_id": dbName });
            if (typeof dbDoc?.primary === 'string' && dbDoc.primary) ids.add(dbDoc.primary);
         } catch(_) { /* config auth */ }

         return [...ids];
      }

      function shardPrimaryUri(shardHost) {
         const parent = parentConnectionParts();
         const params = new URLSearchParams(parent.searchParams);
         params.delete('tags');
         params.delete('readPreferenceTags');
         params.delete('maxStalenessSeconds');
         params.delete('minPoolSize');
         params.delete('readPreference');
         params.set('maxPoolSize', '2');
         params.set('serverSelectionTimeoutMS', String(SHARD_CONNECT_TIMEOUT_MS));
         params.set('connectTimeoutMS', String(SHARD_CONNECT_TIMEOUT_MS));
         params.set('socketTimeoutMS', String(SHARD_CONNECT_TIMEOUT_MS));
         if (parent.isSrv && !params.has('tls') && !params.has('ssl')) {
            params.set('tls', 'true');
         }
         const host = String(shardHost || '');
         const slash = host.indexOf('/');
         let hosts;
         if (slash > 0) {
            params.set('replicaSet', host.slice(0, slash));
            params.set('directConnection', 'false');
            params.set('readPreference', 'primary');
            hosts = host.slice(slash + 1);
         } else {
            params.delete('replicaSet');
            params.set('directConnection', 'true');
            params.set('readPreference', 'primary');
            hosts = host;
         }
         if (!hosts) throw new Error('shard host is empty');
         params.sort();
         let auth = '';
         if (parent.username) {
            auth = parent.username;
            if (parent.password !== '' && parent.password != null) auth += `:${parent.password}`;
            auth += '@';
         }
         const path = parent.pathname || '/';
         const q = params.toString();
         return `mongodb://${auth}${hosts}${path}${q ? `?${q}` : ''}`;
      }

      function openShardPrimary(uri) {
         if (typeof Mongo === 'function') return new Mongo(uri);
         const handle = connect(uri);
         return (handle && typeof handle.getMongo === 'function') ? handle.getMongo() : handle;
      }

      function shardAdmin(mongo) {
         if (mongo && typeof mongo.getDB === 'function') return mongo.getDB('admin');
         if (mongo && typeof mongo.getSiblingDB === 'function') return mongo.getSiblingDB('admin');
         throw new Error('shard handle has no admin db');
      }

      function closeShardClient(c) {
         try {
            if (c?.mongo && typeof c.mongo.close === 'function') c.mongo.close();
         } catch(_) { /* already closed */ }
      }

      function closeClients() {
         for (const c of clients) closeShardClient(c);
         clients = [];
         enabled = false;
      }

      async function openShardClient(id, host) {
         const mongo = openShardPrimary(shardPrimaryUri(host));
         try {
            return { "id": id, "mongo": mongo, "admin": shardAdmin(mongo) };
         } catch(e) {
            closeShardClient({ "mongo": mongo });
            throw e;
         }
      }

      function listShardMap() {
         try {
            const listed = db.adminCommand({ "listShards": 1 }).shards ?? [];
            return { "ok": true, "byId": new Map(listed.map(s => [s._id, s])) };
         } catch(e) {
            return {
               "ok": false,
               "detail": `mongos: listShards failed (${redactMessage(e?.message ?? e)})`
            };
         }
      }

      function targetShardIds(mapped) {
         if (namespaceVarsSet()) return collectionOwningShardIds();
         return [...mapped.byId.keys()];
      }

      async function reconcileShardClients() {
         const mapped = listShardMap();
         if (!mapped.ok) return mapped;
         const owning = targetShardIds(mapped);
         if (!owning.length) {
            return {
               "ok": false,
               "detail": namespaceVarsSet()
                  ? 'mongos: no collection-owning shards found'
                  : 'mongos: listShards returned no shards'
            };
         }
         const missing = owning.filter(id => !mapped.byId.has(id) || !mapped.byId.get(id)?.host);
         if (missing.length) {
            return {
               "ok": false,
               "detail": `mongos: shard(s) ${missing.join(', ')} not in listShards`
            };
         }

         const have = new Map(clients.map(c => [c.id, c]));
         const desired = new Set(owning);
         const toAdd = owning.filter(id => !have.has(id));
         const toDrop = clients.filter(c => !desired.has(c.id));
         const opened = [];
         try {
            if (toAdd.length) {
               const settled = await Promise.allSettled(toAdd.map(id => Promise.resolve().then(() =>
                  openShardClient(id, mapped.byId.get(id).host)
               )));
               for (let i = 0; i < settled.length; i++) {
                  if (settled[i].status === 'fulfilled') {
                     opened.push(settled[i].value);
                  } else {
                     throw new Error(`${toAdd[i]}: ${redactMessage(settled[i].reason?.message ?? settled[i].reason)}`);
                  }
               }
            }
         } catch(e) {
            for (const c of opened) closeShardClient(c);
            return {
               "ok": false,
               "detail": `mongos: shard primary unreachable (${redactMessage(e?.message ?? e)})`
            };
         }

         for (const c of toDrop) closeShardClient(c);
         const addedById = new Map(opened.map(c => [c.id, c]));
         clients = owning.map(id => have.get(id) || addedById.get(id)).filter(Boolean);
         enabled = clients.length > 0;
         return { "ok": true };
      }

      function sampleShardPrimary(admin, key) {
         const cmdOpts = { "readPreference": { "mode": "primary" } };
         const ss = admin.runCommand({
            "serverStatus": true,
            ...SERVER_STATUS_OPTIONS_DEFAULTS,
            ...SERVER_STATUS_OPT_IN
         }, cmdOpts);
         let wterc = '';
         try {
            wterc = admin.runCommand({
               "getParameter": 1,
               "wiredTigerEngineRuntimeConfig": 1
            }, cmdOpts).wiredTigerEngineRuntimeConfig || '';
         } catch(_) { /* restricted / missing */ }
         let rsSt = {};
         try {
            rsSt = admin.runCommand({ "replSetGetStatus": 1 }, cmdOpts);
         } catch(_) { /* standalone shard / auth */ }
         let host = {};
         try {
            host = admin.runCommand({ "hostInfo": 1 }, cmdOpts);
         } catch(_) { /* restricted */ }
         let executionControlDeprioritizationGate = false;
         try {
            executionControlDeprioritizationGate = !!admin.runCommand({
               "getParameter": 1,
               "executionControlDeprioritizationGate": 1
            }, cmdOpts).executionControlDeprioritizationGate;
         } catch(_) { /* 7.x / restricted / missing */ }
         const snap = vitalsFromServerStatus({
            "ss": ss,
            "rsSt": rsSt,
            "host": host,
            "wterc": wterc,
            "executionControlDeprioritizationGate": executionControlDeprioritizationGate
         });
         if (!hasWiredTigerVitals(snap)) {
            throw new Error('WiredTiger cache vitals unavailable');
         }
         return stampQueuedWait(snap, key);
      }

      function foldWorstShardVitals(namedSamples = []) {
         const nums = key => namedSamples.map(s => +s[key]).filter(n => !Number.isNaN(n));
         const maxNum = (key, d = 0) => {
            const xs = nums(key);
            return xs.length ? Math.max(...xs) : d;
         };
         const minNum = (key, d) => {
            const xs = nums(key);
            return xs.length ? Math.min(...xs) : d;
         };
         const rank = { "low": 0, "medium": 1, "high": 2 };
         let worst = namedSamples[0];
         let worstScore = -1;
         for (const s of namedSamples) {
            const score = Math.max(
               s.dirtyUtil || 0,
               s.dirtyUpdatesUtil || 0,
               s.cacheUtil || 0,
               ((s.activeReplLag || 0) / REPL_LAG_HARD_SEC) * 100
            );
            if (score > worstScore) {
               worstScore = score;
               worst = s;
            }
         }
         const folded = {};
         for (const key of VITALS_FOLD_MAX) folded[key] = maxNum(key);
         for (const key of VITALS_FOLD_OR) folded[key] = namedSamples.some(s => s[key]);
         for (const [key, d] of VITALS_FOLD_MIN) folded[key] = minNum(key, d);
         for (const key of VITALS_FOLD_STATUS) {
            let status = 'low';
            for (const s of namedSamples) {
               if ((rank[s[key]] ?? 0) > rank[status]) status = s[key];
            }
            folded[key] = status;
         }
         folded["worstShard"] = worst?.id;
         folded["owningShards"] = namedSamples.map(s => s.id);
         folded["execQueuedWaitScale"] = 1000;
         folded["executionControlDeprioritizationScale"] = 1;
         folded["usesThroughputProbingScale"] = 1;
         return folded;
      }

      async function sample({ reconcile = true } = {}) {
         if (reconcile) {
            const rec = await reconcileShardClients();
            if (!rec.ok) return rec;
         }
         if (!clients.length) {
            return { "ok": false, "detail": 'mongos: no shard primary clients' };
         }
         const settled = await Promise.allSettled(
            clients.map(c => Promise.resolve().then(() => ({
               "id": c.id,
               ...sampleShardPrimary(c.admin, c.id)
            })))
         );
         const ok = [];
         const failed = [];
         for (let i = 0; i < settled.length; i++) {
            const id = clients[i].id;
            if (settled[i].status === 'fulfilled') {
               ok.push(settled[i].value);
            } else {
               failed.push(`${id}: ${redactMessage(settled[i].reason?.message ?? settled[i].reason)}`);
            }
         }
         if (failed.length || ok.length !== clients.length) {
            return {
               "ok": false,
               "detail": `mongos: shard primary unreachable (${
                  failed.join('; ') || 'incomplete sample'
               })`
            };
         }
         const keep = new Set(ok.map(s => s.id));
         for (const k of Object.keys(_queuedPrev)) {
            if (!keep.has(k)) delete _queuedPrev[k];
         }
         return { "ok": true, "vitals": foldWorstShardVitals(ok) };
      }

      async function attach() {
         const rec = await reconcileShardClients();
         if (!rec.ok) return rec;
         const sampled = await sample({ "reconcile": false });
         if (!sampled.ok) {
            closeClients();
            return sampled;
         }
         if (!hasWiredTigerVitals(sampled.vitals)) {
            closeClients();
            return {
               "ok": false,
               "detail": 'mongos: shard primaries reachable but WT cache vitals missing'
            };
         }
         return sampled;
      }

      return {
         attach,
         sample,
         close: closeClients,
         get enabled() { return enabled; }
      };
   }

   async function congestionMonitor() {
      /*
       *  Mongod congestion snapshot: cached hostInfo / rs.status / wterc /
       *  opt-in serverStatus, projected through vitalsFromServerStatus.
       */
      async function serverStatus(serverStatusOptions = {}) {
         /*
          *  opt-in version of db.serverStatus() with a short TTL cache.
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

      const ss = await serverStatus(SERVER_STATUS_OPT_IN);
      return stampQueuedWait(vitalsFromServerStatus({
         "ss": ss,
         "rsSt": rsStatus(),
         "host": hostInfo(),
         "wterc": getParameter('wiredTigerEngineRuntimeConfig', '') || '',
         "executionControlDeprioritizationGate": getParameter('executionControlDeprioritizationGate', false)
      }), 'local');
   }

   class EQ {
      /*
       *  EQ class
       */
      constructor({
         width = 30,
         row = 0,
         column = 0,
         name = '',
         metric = '',
         status = '',
         scale = '',
         unit = '',
         interval = 100
      } = {}) {
         this.width = width;
         this.row = row;
         this.column = column;
         this.markers = {
            "bg": "\u2591",                    // light grey
            "low": "\x1b[92m\u2593\x1b[0m",    // green
            "medium": "\x1b[93m\u2593\x1b[0m", // yellow
            "high": "\x1b[91m\u2593\x1b[0m"    // red
         };
         this.name = name;
         this.barOffset = 17;
         this.offset = column + this.barOffset;
         this.metric = metric;
         this.status = status;
         this.scale = scale;
         this.unit = unit;
         this.interval = interval;
      }

      async draw() {
         /*
          *  render the EQ bar
          */
         let cursor = 0;
         while (true) {
            // take current stats values from the parent monitoring thread
            const { [this.metric]: metric = 0, [this.status]: status = 'low', [this.scale]: scale = 100 } = vitals;
            cursor = Math.floor(metric * (this.width / scale));
            // always re-render the empty bar background
            readline.cursorTo(process.stdout, this.column, this.row);
            process.stdout.write(this.name.padEnd(this.barOffset, ' ') + this.markers.bg.repeat(this.width));
            // re-render the bar elements to the current metric value
            cursor = (cursor > this.width) ? this.width : cursor; // cap bar length
            for (let i = 0; i < cursor; ++i) {
               readline.cursorTo(process.stdout, this.offset + i, this.row);
               process.stdout.write(this.markers[status]); // coordinate marker colour with status
            }
            // re-render the metric value
            readline.cursorTo(process.stdout, this.width + this.offset + 1, this.row);
            process.stdout.write('\x1b[0K' + metric + this.unit); // erase to the end of the line
            // re-render the table border
            readline.cursorTo(process.stdout, this.width + this.offset + 7, this.row);
            process.stdout.write('┃');
            // sleep on the rendering interval per EQ (decoupled from the stats update interval)
            sleep(this.interval);
         }
      }
   }

   async function main() {
      /*
       *  main
       */
      const shardVitals = createShardVitals();
      if (isSharded()) {
         const attached = await shardVitals.attach();
         if (!attached.ok) {
            console.log(attached.detail || 'mongos: shard WT attach failed');
            return;
         }
         vitals = attached.vitals;
      }

      const metrics = [
         // {  // EQ attributes
         //    "name": "<string>",   // EQ label
         //    "metric": "<string>", // monitor metric
         //    "status": "<string>", // metric status
         //    "scale": "<string>",  // metric scale
         //    "unit": "<string>",   // metric unit
         //    "interval": <int>     // refresh interval in milliseconds
         // }
         { "name": "readTicketsUtil", "metric": "wtReadTicketsUtil", "status": "wtReadTicketsStatus", "unit": "%" },
         { "name": "writeTicketsUtil", "metric": "wtWriteTicketsUtil", "status": "wtWriteTicketsStatus", "unit": "%" },
         { "name": "throughputProbe", "metric": "usesThroughputProbing", "status": "usesThroughputProbingStatus", "scale": "usesThroughputProbingScale" },
         { "name": "readQueue", "metric": "execReadQueueLength", "status": "execReadQueueStatus" },
         { "name": "writeQueue", "metric": "execWriteQueueLength", "status": "execWriteQueueStatus" },
         { "name": "cacheFill", "metric": "cacheUtil", "status": "cacheStatus", "scale": "evictionTrigger", "unit": "%" },
         { "name": "dirtyFill", "metric": "dirtyUtil", "status": "dirtyStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "dirtyUpdatesFill", "metric": "dirtyUpdatesUtil", "status": "dirtyUpdatesStatus", "scale": "evictionUpdatesTrigger", "unit": "%" },
         { "name": "dirtyIntlFill", "metric": "dirtyIntlUtil", "status": "dirtyIntlStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "dirtyLeafFill", "metric": "dirtyLeafUtil", "status": "dirtyLeafStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "checkpointStress", "metric": "checkpointRuntimeRatio", "status": "checkpointStatus", "unit": "%", "interval": 250 },
         { "name": "activeReplLag", "metric": "activeReplLag", "status": "replLagStatus", "scale": "replLagScale", "unit": "s", "interval": 500 },
         { "name": "deprioritize", "metric": "executionControlDeprioritizationGate", "status": "executionControlDeprioritizationStatus", "scale": "executionControlDeprioritizationScale" },
         { "name": "lowPriorityRead", "metric": "execReadLowPriorityQueueLength", "status": "execReadLowPriorityStatus" },
         { "name": "lowPriorityWrite", "metric": "execWriteLowPriorityQueueLength", "status": "execWriteLowPriorityStatus" },
         { "name": "readQueuedWait", "metric": "execReadQueuedWaitMs", "status": "execReadQueuedWaitStatus", "scale": "execQueuedWaitScale", "unit": "ms" },
         { "name": "writeQueuedWait", "metric": "execWriteQueuedWaitMs", "status": "execWriteQueuedWaitStatus", "scale": "execQueuedWaitScale", "unit": "ms" }
      ];
      // instantiate EQ objects
      metrics.forEach((metric, _idx) => {
         metric.row = _idx + 1;
         metric.column = 1;
         metric.eq = new EQ(metric);
      });
      // setup the initial console state
      let tableTitle = 'Real-time congestion monitor';
      if (vitals.worstShard) {
         tableTitle = `Congestion worst ${vitals.worstShard}`;
         if (Array.isArray(vitals.owningShards) && vitals.owningShards.length) {
            tableTitle += ` (${vitals.owningShards.length})`;
         }
      }
      const tableWidth = Math.max(54, tableTitle.length + 6);
      const titleSpacing = (tableWidth - tableTitle.length) / 2;
      process.stdout.write('\x1b[?25l;1049h]'); // disable the console cursor and enable alternate buffer 
      console.clear();
      console.log('╭' + '─'.repeat(titleSpacing - 1) + '┤' + tableTitle + '├' + '─'.repeat(titleSpacing - 1) + '╮');
      metrics.forEach(() => {
         console.log('│'+ ' '.repeat(tableWidth) + '│'); 
      });
      console.log('╰'+ '─'.repeat(tableWidth) + '╯');
      Promise.allSettled( // do not await to background thread
         // begin rendering EQ bars
         metrics.map(({ eq }) => eq.draw())
      ).finally(() => process.stdout.write('\x1b[?1049l;25h]')); // disable alternate buffer and re-enable the console cursor

      while (true) { // refresh stats
         if (shardVitals.enabled) {
            const next = await shardVitals.sample();
            if (next.ok) vitals = next.vitals;
         } else {
            vitals = await congestionMonitor();
         }
         sleep(shardVitals.enabled ? SHARD_VITALS_SAMPLE_INTERVAL_MS : pollingIntervalMS);
      }
   }

   await main().finally(console.log);
})();

// EOF
