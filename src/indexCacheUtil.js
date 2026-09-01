/*
 *  Name: "indexCacheUtil.js"
 *  Version: "0.1.5"
 *  Description: "index cache util"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 *
 *  Legacy archive line: v0.1.5 is the snapshot for this script. mongosh-only
 *  (async IIFE, Promise.allSettled; incompatible with legacy mongo). Still
 *  the demarked version for the whole-tree freeze. Further feature work
 *  (thread pool, sharding, runCommand, ProgressTracker) targets mongosh;
 *  see ROADMAP.md → Legacy mongo shell retirement.
 *
 *  Notes: mongosh only. Do not top-level-await this IIFE.
 *
 *  TODOs:
 *  - Add threadpool support
 *  - Add sharding support
 *  - Convert adminCommand to runCommand for directed command execution
 *  - Add cluster wide reporting
 *  - revise the scope for cache util in system namespaces
 *  - add progress meter while accumulating counters
 */

// Usage: mongosh [<connection options>] [--quiet] [-f|--file] </path/to/>indexCacheUtil.js

(async() => {
   /*
    *  Index cache util%
    */
   async function getAllNonSystemNamespaces() {
      /*
       *  returns a flat array of all non-system namespaces documents
       */
      return db.adminCommand({
         "listDatabases": 1,
         "filter": {
            "name": /(?:^(?!(admin|config|local)$).+)/
         },
         "nameOnly": true,
         "authorizedDatabases": true,
         "comment": "fetching all DB names" // fCV(4.4)
      }).databases.map(async({ 'name': dbName }) => {
         return db.getSiblingDB(dbName).runCommand({
            "listCollections": 1,
            "filter": {
               "type": /^(collection|timeseries)$/,
               "name": /(?:^(?!system\..+$).+)/
            },
            "nameOnly": true,
            "authorizedCollections": true,
            "comment": "fetching all collection names" // fCV(4.4)
         }).cursor.firstBatch.map(({ 'name': collName }) => {
            return { "dbName": dbName, "collName": collName };
         });
      });
   }

   async function getIndexCacheStats({ dbName, collName }) {
      /*
       *  returns the index cache stats for a given namespace
       */

      // Sample stats

      // wiredTiger: {
      //    cache: {
      //      'bytes allocated for updates': 8182,
      //      'bytes currently in the cache': 69725,
      //      'bytes dirty in the cache cumulative': 61760,
      //      'maximum bytes configured': 1073741824,
      //      'percentage overhead': 8,
      //      'tracked bytes belonging to internal pages in the cache': 2262,
      //      'tracked bytes belonging to leaf pages in the cache': 67463,
      //      'tracked dirty bytes in the cache': 12151
      // } }

      const pipeline = [
         { "$collStats": {
            "storageStats": {
               "scale": 1
         } } },
         { "$project": {
            "cachedPages": {
               "$reduce": {
                  "input": {
                     "$objectToArray": "$storageStats.indexDetails"
                  },
                  "initialValue": 0,
                  "in": {
                     "$add": [
                        "$$value",
                        "$$this.v.cache.bytes currently in the cache"
            ] } } },
            "indexPages": {
               "$reduce": {
                  "input": {
                     "$objectToArray": "$storageStats.indexDetails"
                  },
                  "initialValue": 0,
                  "in": {
                     "$add": [
                        "$$value",
                        "$$this.v.block-manager.file size in bytes"
            ] } } },
            "freePages": {
               "$reduce": {
                  "input": {
                     "$objectToArray": "$storageStats.indexDetails"
                  },
                  "initialValue": 0,
                  "in": {
                     "$add": [
                        "$$value",
                        "$$this.v.block-manager.file bytes available for reuse"
         ] } } } } }
      ];
      const options = {
         "cursor": { "batchSize": 1 },
         "readConcern": { "level": "local" },
         "comment": "Index cache usage query"
      };
      const {
         cachedPages,
         indexPages,
         freePages
      } = db.getSiblingDB(dbName).getCollection(collName).aggregate(pipeline, options).toArray()[0];
      return {
         "sizeInMemory": cachedPages,
         "totalIndexPages": indexPages - freePages
      };
   }

   async function main() {
      /*
       *  main
       */
      let sizeInMemory = 0, totalIndexPages = 0;
      const cacheSize = db.serverStatus().wiredTiger.cache['maximum bytes configured'];
      const cachedPagesBytes = db.serverStatus().wiredTiger.cache['bytes belonging to page images in the cache'];
      const namespaces = await getAllNonSystemNamespaces();
      const nslist = (await Promise.allSettled(namespaces)).map(({ status, value, reason }) => {
         if (status === 'fulfilled') return value;
         console.log('Listing one of the namespaces failed:', reason);
         return [];
      });
      await Promise.allSettled(nslist.flat().map(getIndexCacheStats)).then(results => {
         results.forEach(({ status, value, reason }) => {
            if (status === 'fulfilled') {
               sizeInMemory += value.sizeInMemory;
               totalIndexPages += value.totalIndexPages;
            } else if (status === 'rejected') {
               console.error('rejected:', reason);
            }
         });
         console.log('\n');
         console.log(`\tConfigured WT cache Size:\t${cacheSize} bytes`);
         console.log(`\tTotal bytes in cache:\t\t${cachedPagesBytes} bytes`);
         console.log(`\tTotal cache util:\t\t${+(100 * (cachedPagesBytes / cacheSize)).toFixed(2)}%`);
         console.log('\n');
         console.log(`\tTotal indexes size on disk:\t${totalIndexPages} bytes`);
         console.log(`\tIndex bytes in cache:\t\t${sizeInMemory} bytes`);
         console.log(`\tCache util by indexes:\t\t${+(100 * (sizeInMemory / cachedPagesBytes)).toFixed(2)}%`);
         console.log(`\tIndex working set util:\t\t${+(100 * (sizeInMemory / totalIndexPages)).toFixed(2)}%`);
         console.log('\n');
      });
   }

   await main();
})();

// EOF
