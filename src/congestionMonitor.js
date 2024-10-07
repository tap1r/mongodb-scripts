(async() => {
   /*
    *  Name: "congestionMonitor.js"
    *  Version: "0.1.6"
    *  Description: "realtime monitor for mongod congestion vitals, designed for use with client side admission control"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  TODOs:
    *  - 
    */

   // Usage: mongosh [connection options] --quiet [-f|--file] congestionMonitor.js

   let vitals = {};
   let pollingIntervalMS = 100;

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

      function hostInfo() {
         let hostInfo = {};
         try {
            hostInfo = db.hostInfo();
         } catch(error) {
            // console.debug(`\x1b[31m[WARN] insufficient rights to execute db.hostInfo()\n${error}\x1b[0m`);
         }

         return hostInfo;
      }

      return {
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
         "hostInfo": hostInfo(),
         "wiredTigerEngineRuntimeConfig": db.adminCommand({ "getParameter": 1, "wiredTigerEngineRuntimeConfig": 1 }).wiredTigerEngineRuntimeConfig,
         "storageEngineConcurrentReadTransactions": db.adminCommand({ "getParameter": 1, "wiredTigerConcurrentReadTransactions": 1 }).wiredTigerConcurrentReadTransactions,
         // db.adminCommand({ "getParameter": 1, "storageEngineConcurrentReadTransactions": 1 })
         "storageEngineConcurrentWriteTransactions": db.adminCommand({ "getParameter": 1, "wiredTigerConcurrentWriteTransactions": 1 }).wiredTigerConcurrentWriteTransactions,
         "lowPriorityAdmissionBypassThreshold": db.adminCommand({ "getParameter": 1, "lowPriorityAdmissionBypassThreshold": 1 }).lowPriorityAdmissionBypassThreshold,
         // https://www.mongodb.com/docs/manual/reference/command/serverStatus/#mongodb-serverstatus-serverstatus.wiredTiger.concurrentTransactions
         "serverStatus": await serverStatus({ // minimal server status metrics to reduce server cost
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
         }),
         "slowms": db.getSiblingDB('admin').getProfilingStatus().slowms,
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
            return +((this.cachedBytes / this.cacheSizeBytes) * 100).toFixed(2);
         },
         get cacheStatus() {
            return (this.cacheUtil < this.evictionTarget) ? 'low'
                 : (this.cacheUtil > this.evictionTrigger) ? 'high'
                 : 'medium';
         },
         get dirtyUtil() {
            return +((this.dirtyBytes / this.cacheSizeBytes) * 100).toFixed(2);
         },
         get dirtyStatus() {
            return (this.dirtyUtil < this.evictionDirtyTarget) ? 'low'
                 : (this.dirtyUtil > this.evictionDirtyTrigger) ? 'high'
                 : 'medium';
         },
         get dirtyUpdatesUtil() {
            return +((this.updatesDirtyBytes / this.cacheSizeBytes) * 100).toFixed(2);
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
            let hitBytes = this.serverStatus.wiredTiger.cache['pages requested from the cache'];
            let missBytes = this.serverStatus.wiredTiger.cache['pages read into cache'];
            return +(100 * (hitBytes - missBytes) / hitBytes).toFixed(2);
         },
         get cacheHitStatus() {
            return (this.cacheHitRatio < 20) ? 'high'
                 : (this.cacheHitRatio > 75) ? 'low'
                 : 'medium';
         },
         get cacheMissRatio() {
            let hitBytes = this.serverStatus.wiredTiger.cache['pages requested from the cache'];
            let missBytes = this.serverStatus.wiredTiger.cache['pages read into cache'];
            return +(100 * (1 - (hitBytes - missBytes) / hitBytes)).toFixed(2);
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
            return this?.hostInfo?.system?.numCores ?? 4; // else max 4 is probably a good default aligning with concurrency limits
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
            return +(100 * (this.currentAllocatedBytes / this.heapSize)).toFixed(2);
         },
         get pageheapFreeBytes() {
            // assume zero fragmentation if we cannot measure pageheap_free_bytes
            return +(this.serverStatus?.tcmalloc?.tcmalloc?.pageheap_free_bytes ?? 0);
         },
         get totalFreeBytes() {
            return +(this.serverStatus?.tcmalloc?.tcmalloc?.total_free_bytes ?? 0);
         },
         get memoryFragmentationRatio() {
            return +((this.pageheapFreeBytes / this.memSizeBytes) * 100).toFixed(2);
         },
         get memoryFragmentationStatus() {
            // mimicing the (bad) t2 derived metric for now
            return (this.memoryFragmentationRatio < 10) ? 'low' // 25 is more realistic
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
            let { out, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read;
            return +((out / totalTickets) * 100).toFixed(2);
         },
         get wtReadTicketsAvail() {
            let { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read;
            return +((available / totalTickets) * 100).toFixed(2);
         },
         get wtWriteTicketsUtil() {
            let { out, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write;
            return +((out / totalTickets) * 100).toFixed(2);
         },
         get wtWriteTicketsAvail() {
            let { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write;
            return +((available / totalTickets) * 100).toFixed(2);
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
            let { currentMigrationsDonating, currentMigrationsReceiving } = this.serverStatus.tenantMigrations;
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
            return +(((this.serverStatus.wiredTiger.transaction?.['transaction checkpoint most recent time (msecs)'] ?? this.serverStatus.wiredTiger.checkpoint?.['most recent time (msecs)']) / this.checkpointIntervalMS) * 100).toFixed(2);
         },
         get checkpointStatus() {
            return (this.checkpointRuntimeRatio < 50) ? 'low'
                 : (this.checkpointRuntimeRatio > 100) ? 'high'
                 : 'medium';
         }
      };
   }

   class EQ {
      constructor({ width = 30, row = 0, column = 0, name = '', metric = '', status = '', scale = '', unit = '', interval = 100 } = {}) {
         this.width = width;
         this.row = row;
         this.column = column;
         this.markers = {
            "bg": "\u2591", // light grey
            "low": "\x1b[92m\u2593\x1b[0m", // green
            "medium": "\x1b[93m\u2593\x1b[0m", // yellow
            "high": "\x1b[91m\u2593\x1b[0m" // red
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
         let cursor = 0;
         while (true) { // draw the EQ bar
            // take current stats values from the parent monitoring thread
            let { [this.metric]: metric = 0, [this.status]: status = '', [this.scale]: scale = 100 } = vitals;
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
      let metrics = [
         // {  // EQ attributes
         //    "name": "<string>",   // EQ label
         //    "metric": "<string>", // monitor metric
         //    "status": "<string>", // metric status
         //    "scale": "<string>",  // metric scale
         //    "unit": "<string>",   // metric unit
         //    "interval": <int>     // refresh interval in milliseconds
         // },
         { "name": "readTicketsUtil", "metric": "wtReadTicketsUtil", "status": "wtReadTicketsStatus", "unit": "%" },
         { "name": "writeTicketsUtil", "metric": "wtWriteTicketsUtil", "status": "wtWriteTicketsStatus", "unit": "%" },
         { "name": "cacheFill", "metric": "cacheUtil", "status": "cacheStatus", "scale": "evictionTrigger", "unit": "%" },
         { "name": "dirtyFill", "metric": "dirtyUtil", "status": "dirtyStatus", "scale": "evictionDirtyTrigger", "unit": "%" },
         { "name": "dirtyUpdatesFill", "metric": "dirtyUpdatesUtil", "status": "dirtyUpdatesStatus", "scale": "evictionUpdatesTrigger", "unit": "%" },
         { "name": "checkpointStress", "metric": "checkpointRuntimeRatio", "status": "checkpointStatus", "interval": 500, "unit": "%" }
      ];
      // instantiate EQ objects
      metrics.forEach((metric, _) => {
         metric.row = _ + 1;
         metric.column = 1;
         metric.eq = new EQ(metric);
      });
      // setup the initial console state
      let tableWidth = 54;
      let tableTitle = 'Real-time congestion monitor';
      let titleSpacing = (tableWidth - tableTitle.length)/2;
      console.clear();
      console.log('┏' + '━'.repeat(titleSpacing - 1) + '┫' + tableTitle + '┣' + '━'.repeat(titleSpacing - 1) + '┓');
      metrics.forEach(() => {
         console.log('┃'+ ' '.repeat(tableWidth) + '┃'); 
      });
      console.log('┗'+ '━'.repeat(tableWidth) + '┛');
      process.stdout.write('\x1b[?25l'); // disable the console cursor
      Promise.allSettled([ // do not await to background thread
         // begin rendering EQ bars
         metrics.forEach(({ eq }) => eq.draw())
      ]);

      while (true) { // refresh stats
         vitals = await congestionMonitor();
         sleep(pollingIntervalMS);
      }
   }

   await main().finally(process.stdout.write('\x1b[?25h')); // re-enable the console cursor
})();
