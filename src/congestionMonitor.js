(async() => {
   /*
    *  Name: "congestionMonitor.js"
    *  Version: "0.1.0"
    *  Description: "monitors mongod congestion vitals"
    *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  TODOs:
    *  - align EQ colour codes with metric thresholds
    */

   // Usage: "mongosh [connection options] --quiet [-f|--file] congestionMonitor.js"

   let vitals = {};
   let rendering = true;

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
            let { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.read ?? this.serverStatus?.queues?.execution?.read;
            return +((available / totalTickets) * 100).toFixed(2);
         },
         get wtWriteTicketsUtil() {
            let { available, totalTickets } = this.serverStatus.wiredTiger?.concurrentTransactions?.write ?? this.serverStatus?.queues?.execution?.write;
            return +((available / totalTickets) * 100).toFixed(2);
         },
         get wtReadTicketsStatus() {
            return (this.wtReadTicketsUtil > 80) ? 'low'
                 : (this.wtReadTicketsUtil < 25) ? 'high'
                 : 'medium';
         },
         get wtWriteTicketsStatus() {
            return (this.wtWriteTicketsUtil > 80) ? 'low'
                 : (this.wtWriteTicketsUtil < 25) ? 'high'
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
      constructor({ size = 1, row = 0, column = 0, label = '', metric = '', status = '', interval = 100 } = {}) {
         this.size = size;
         this.row = row;
         this.column = column;
         this.markers = {
            "bg": "\u2591",
            "low": "\x1b[92m\u2593\x1b[0m",
            "medium": "\x1b[93m\u2593\x1b[0m",
            "high": "\x1b[91m\u2593\x1b[0m"
         };
         this.label = label;
         // this.offset = column + label.length + 1;
         this.barOffset = 19;
         this.offset = column + this.barOffset;
         this.metric = metric;
         this.status = status;
         this.interval = interval;
      }

      async render() {
         let cursor = 0;
         do { // draw the progressing bar
            // fetch stats
            let { [this.metric]: metric = 0, [this.status]: status = '' } = vitals;
            cursor = Math.floor((metric * this.size) / 100);
            // re-render the empty bar always
            readline.cursorTo(process.stdout, this.column, this.row);
            process.stdout.write(this.label.padEnd(this.barOffset, ' ') + this.markers.bg.repeat(this.size));
            // re-render the eq bar
            cursor = (cursor > this.size) ? this.size : cursor; // cap bar length
            for (let i = 0; i < cursor; ++i) {
               readline.cursorTo(process.stdout, this.offset + i, this.row);
               process.stdout.write(this.markers[status]); // coordinate marker colour with status
            }
            // re-render the metric value
            readline.cursorTo(process.stdout, this.size + this.offset + 2, this.row);
            process.stdout.write('\x1b[0K' + metric + '%'); // erase to the end of the line
            //
            sleep(this.interval);
         } while (rendering);
      }
   }

   async function main() {
      console.clear();
      process.stdout.write('\x1b[?25l'); // disable cursor
      let cacheUtil = new EQ({ "size": 30, "row": 1, "column": 3, "label": "cache%", "metric": "cacheUtil", "status": "cacheStatus", "interval": 50 });
      let dirtyUtil = new EQ({ "size": 30, "row": 3, "column": 3, "label": "dirty%", "metric": "dirtyUtil", "status": "dirtyStatus", "interval": 50 });
      let dirtyUpdatesUtil = new EQ({ "size": 30, "row": 5, "column": 3, "label": "dirtyUpdates%", "metric": "dirtyUpdatesUtil", "status": "dirtyUpdatesStatus", "interval": 50 });
      let checkpointStress = new EQ({ "size": 30, "row": 7, "column": 3, "label": "checkpointStress", "metric": "checkpointRuntimeRatio", "status": "checkpointStatus", "interval": 500 });
      let wtReadTicketsUtil = new EQ({ "size": 30, "row": 9, "column": 3, "label": "wtReadTickets%", "metric": "wtReadTicketsUtil", "status": "wtReadTicketsStatus", "interval": 50 });
      let wtWriteTicketsUtil = new EQ({ "size": 30, "row": 11, "column": 3, "label": "wtWriteTickets%", "metric": "wtWriteTicketsUtil", "status": "wtWriteTicketsStatus", "interval": 50 });
      // let heapFragmentation = new EQ({ "size": 30, "row": 13, "column": 3, "label": "heapFragmentation%", "metric": "memoryFragmentationRatio", "status": "memoryFragmentationStatus", "interval": 50 });
      // console.log(util.inspect(congestionMetrics, { "colors": true, "getters": "get", "depth": Infinity, "compact": Infinity, "breakLength": 80, "numericSeparator": true }));
      // await Promise.allSettled([
      Promise.allSettled([
         cacheUtil.render(),
         dirtyUtil.render(),
         dirtyUpdatesUtil.render(),
         checkpointStress.render(),
         wtReadTicketsUtil.render(),
         wtWriteTicketsUtil.render(),
         // heapFragmentation.render()
      ]).then(() => process.stdout.write('\x1b[?25h')); // re-enable cursor
      //
      // for (let n = 0; n <= 1000; ++n) {
      while (true) {
         // fetching the stats
         vitals = await congestionMonitor();
         sleep(200);
      }
      rendering = false;
   }

   await main().finally(console.log);
})();
