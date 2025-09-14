/*
 *  Name: "docSizes.js"
 *  Version: "0.1.29"
 *  Description: "sample document size distribution"
 *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: mongosh [connection options] --quiet [-f|--file] docSizes.js

/*
 *  User defined parameters
 */

const options = {
   "dbName": "database",
   "collName": "collection",
   "sampleSize": 1000 // parameter to $sample
};

(({ dbName, collName, sampleSize = 1000 } = options) => {
   /*
    *  main
    */
   const __script = { "name": "docSizes.js", "version": "0.1.29" };
   console.log(`\n\x1b[33m#### Running script ${__script.name} v${__script.version} on shell v${version()}\x1b[0m`);
   // connection preferences
   const hello = db.hello();
   if (typeof readPref === 'undefined')
      (readPref = (hello.secondary == false) ? 'primaryPreferred' : 'secondaryPreferred');
   db.getMongo().setReadPref(readPref);
   try {
      if (db.getSiblingDB(dbName).getCollectionInfos({ "name": collName }, true)[0]?.name != collName)
         throw 'namespace does not exist';
   } catch(e) {
      console.error(`${dbName}.${collName}`, e);
   }

   /*
      function fomatted(bytes) {
         return Intl.NumberFormat('en', {
            "minimumIntegerDigits": 1,
            "minimumFractionDigits": 0,
            "maximumFractionDigits": 2,
            "style": "unit",
            "unit": "byte", // https://tc39.es/proposal-unified-intl-numberformat/section6/locales-currencies-tz_proposed_out.html#sec-issanctionedsimpleunitidentifier
            "unitDisplay": "narrow" // "short"
         }).format(bytes);
      }
   */

   // retrieve collection metadata
   const namespace = db.getSiblingDB(dbName).getCollection(collName);
   const {
      'count': documentCount,
      'extras': {
         compressor,
         dataPageSize,
         internalPageSize
      },
      'size': dataSize,
      'wiredTiger': {
         'block-manager': {
            'file bytes available for reuse': blocksFree,
            'file size in bytes': storageSize
         },
         'uri': dhandle
      }
   } = new Proxy(
      namespace.stats(),
      { get(target, name) {
         if (name == 'extras') {
            const regexFilter = /block_compressor=(?<compressor>\w+).+internal_page_max=(?<internalPageSize>\d+).+leaf_page_max=(?<dataPageSize>\d+)/;
            const { compressor, dataPageSize, internalPageSize } = target['wiredTiger']['creationString'].match(regexFilter).groups;
            return { "compressor": compressor, "dataPageSize": dataPageSize * 1024, "internalPageSize": internalPageSize * 1024 };
         }
         return target[name];
      } }
   );
   const aggOptions = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": `Performing document distribution analysis with ${__script.name} v${__script.version}`
      },
      { 'system': { hostname } } = db.hostInfo(),
      dbPath = db.serverCmdLineOpts().parsed?.storage?.dbPath ?? 'sharded',
      metadataSize = internalPageSize, // outside of WT stats (4k-64MB)
      ratio = +((dataSize / (storageSize - blocksFree - metadataSize)).toFixed(2));

   // Distribution buckets
   const range = (start, stop, step) => {
      return Array.from(
         { "length": (stop - start) / (step + 1) },
         (_, idx) => start + idx * step
      );
   };
   const { maxBsonObjectSize = 16777216 } = hello;
   // byte offset to reach the bucket's inclusive boundary
   const buckets = range(1, 1 + maxBsonObjectSize, internalPageSize),
      pages = range(1, 1 + maxBsonObjectSize, dataPageSize);

   // measure document and page size distribution
   const pipeline = [
      { "$sample": { "size": sampleSize } },
      { "$facet": {
         "SampleTotals": [
            { "$group": {
               "_id": null,
               "dataSize": { "$sum": { "$bsonSize": "$$ROOT" } }
            } },
            { "$set": {
               "avgDocSize": { "$round": [{ "$divide": ["$dataSize", sampleSize] }, 0] },
               "sampleSize": sampleSize,
               "estStorageSize": { "$round": [{ "$divide": ["$dataSize", ratio] }, 0] },
            } },
            { "$unset": "_id" }
         ],
         "BSONdistribution": [
            { "$bucket": {
               "groupBy": { "$bsonSize": "$$ROOT" },
               "boundaries": buckets,
               "default": "Unknown",
               "output": {
                  "totalDataSize": { "$sum": { "$bsonSize": "$$ROOT" } },
                  "count": { "$sum": 1 },
            } } },
            { "$set": { "bucket": "$_id" } },
            { "$unset": "_id" }
         ],
         "PageDistribution": [
            { "$bucket": {
               "groupBy": { "$round": { "$divide": [{ "$bsonSize": "$$ROOT" }, ratio] } },
               "boundaries": pages,
               "default": "Unknown",
               "output": {
                  "totalStorageSize": { "$sum": { "$round": { "$divide": [{ "$bsonSize": "$$ROOT" }, ratio] } } },
                  "count": { "$sum": 1 }
            } } },
            { "$set": { "bucket": "$_id" } },
            { "$unset": "_id" }
         ]
      } },
      { "$set": {
         "CollectionTotals": {
            "hostname": hostname,
            "dbPath": dbPath,
            "URI": (hello.msg == 'isdbgrid') ? 'sharded' : dhandle,
            "namespace": `${dbName}.${collName}`,
            "dataSize": dataSize,
            "storageSize": storageSize,
            "metadataSize": metadataSize,
            "freeBlocks": blocksFree,
            "utilisedBytes": storageSize - blocksFree - metadataSize,
            "utilisedPercentage": +((100 * (storageSize - blocksFree - metadataSize) / (storageSize - metadataSize)).toFixed(2)),
            "compressor": compressor,
            "compressionRatio": ratio,
            "documentCount": documentCount,
            "consumed32kPages": Math.ceil((storageSize - blocksFree - metadataSize) / dataPageSize),
            "avgDocsPer32kPage": Math.floor(documentCount / ((storageSize - blocksFree - metadataSize) / dataPageSize))
      } } }
   ];

   namespace.aggregate(pipeline, aggOptions).forEach(printjson);
})();

// EOF
