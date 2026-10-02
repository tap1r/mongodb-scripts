(async() => {
   /*
    *  Name: "congestionMonitor.js"
    *  Version: "0.2.15"
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
    *  Further feature work (sharding) targets mongosh; see ROADMAP.md →
    *  Legacy mongo shell retirement.
    *
    *  TODOs:
    *  - Add sharding support (per-shard WT fold)
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>congestionMonitor.js

   let vitals = {};
   const pollingIntervalMS = 100;
   // TTL caches: serverStatus is hot-path; hostInfo is near-static; rsStatus is low/medium volatility.
   const SERVER_STATUS_CACHE_TTL_MS = pollingIntervalMS;
   const HOST_INFO_CACHE_TTL_MS = 60 * 1000;
   const RS_STATUS_CACHE_TTL_MS = 10 * 1000;
   const SLOWMS_CACHE_TTL_MS = 60 * 1000;
   const GET_PARAMETER_CACHE_TTL_MS = 60 * 1000;
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
      slowms = null,
      storageEngineConcurrentReadTransactions = null,
      storageEngineConcurrentWriteTransactions = null,
      lowPriorityAdmissionBypassThreshold = null
   } = {}) {
      /*
       *  Plain congestion snapshot each poll. EQ bars read these fields as
       *  data properties. Missing WT / queues / shardingStatistics stay 0/false.
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
         "execReadQueueLength": +(readQ.queueLength ?? readQ.normalPriority?.queueLength ?? 0),
         "execWriteQueueLength": +(writeQ.queueLength ?? writeQ.normalPriority?.queueLength ?? 0),
         "usesThroughputProbing": !!exec.usesThroughputProbing,
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
         "heartbeatIntervalMillis": heartbeatIntervalMillis,
         "slowms": slowms,
         "storageEngineConcurrentReadTransactions": storageEngineConcurrentReadTransactions,
         "storageEngineConcurrentWriteTransactions": storageEngineConcurrentWriteTransactions,
         "lowPriorityAdmissionBypassThreshold": lowPriorityAdmissionBypassThreshold
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
      return vitalsFromServerStatus({
         "ss": ss,
         "rsSt": rsStatus(),
         "host": hostInfo(),
         "wterc": getParameter('wiredTigerEngineRuntimeConfig', '') || '',
         "slowms": slowms(),
         "storageEngineConcurrentReadTransactions": getParameter('wiredTigerConcurrentReadTransactions', null),
         "storageEngineConcurrentWriteTransactions": getParameter('wiredTigerConcurrentWriteTransactions', null),
         "lowPriorityAdmissionBypassThreshold": getParameter('lowPriorityAdmissionBypassThreshold', null)
      });
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
         { "name": "cacheFill", "metric": "cacheUtil", "status": "cacheStatus", "scale": "evictionTrigger", "unit": "%" },
         { "name": "dirtyFill", "metric": "dirtyUtil", "status": "dirtyStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "dirtyUpdatesFill", "metric": "dirtyUpdatesUtil", "status": "dirtyUpdatesStatus", "scale": "evictionUpdatesTrigger", "unit": "%" },
         { "name": "dirtyIntlFill", "metric": "dirtyIntlUtil", "status": "dirtyIntlStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "dirtyLeafFill", "metric": "dirtyLeafUtil", "status": "dirtyLeafStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "checkpointStress", "metric": "checkpointRuntimeRatio", "status": "checkpointStatus", "unit": "%", "interval": 250 },
         { "name": "activeReplLag", "metric": "activeReplLag", "status": "replLagStatus", "scale": "replLagScale", "unit": "s", "interval": 500 }
      ];
      // instantiate EQ objects
      metrics.forEach((metric, _idx) => {
         metric.row = _idx + 1;
         metric.column = 1;
         metric.eq = new EQ(metric);
      });
      // setup the initial console state
      const tableWidth = 54;
      const tableTitle = 'Real-time congestion monitor';
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
         vitals = await congestionMonitor();
         sleep(pollingIntervalMS);
      }
   }

   await main().finally(console.log);
})();

// EOF
