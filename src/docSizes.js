/*
 *  Name: "docSizes.js"
 *  Version: "0.1.14"
 *  Description: sample document size distribution
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet docSizes.js"

let __script = { "name": "docSizes.js", "version": "0.1.14" };
console.log(`\n---> Running script ${__script.name} v${__script.version}\n`);

/*
 *  User defined parameters
 */

let options = {
   "dbName": "database",
   "collName": "collection",
   // "sampleSize": 1000 // parameter to $sample
};

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

(({ dbName, collName, sampleSize = 1000 }) => {
   /*
    *  main
    */

   // connection preferences
   if (typeof readPref === 'undefined')
      (readPref = (db.hello().secondary === false) ? 'primaryPreferred' : 'secondaryPreferred');
   db.getMongo().setReadPref(readPref);
   try {
      if (db.getSiblingDB(dbName).getCollectionInfos({ "name": collName }, true)[0]?.name != collName)
         throw 'namespace does not exist';
   } catch(e) {
      console.log(`${dbName}.${collName} ${e}`);
   }

   // retrieve collection metadata
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   let { 'size': dataSize,
         'wiredTiger': {
            'block-manager': {
               'file size in bytes': storageSize,
               'file bytes available for reuse': blocksFree
            },
            'uri': dhandle,
         },
         'count': documentCount,
         compressor,
         'internal_page_max': internalPageSize,
         'leaf_page_max': dataPageSize
      } = {
         ...namespace.stats(),
         get compressor() {
            return this['wiredTiger']['creationString'].match(/block_compressor=(?<compressor>\w+)/).groups?.compressor
         },
         get internal_page_max() {
            return this['wiredTiger']['creationString'].match(/internal_page_max=(?<internal_page_max>\d+)/).groups?.internal_page_max * 1024
         },
         get leaf_page_max() {
            return this['wiredTiger']['creationString'].match(/leaf_page_max=(?<leaf_page_max>\d+)/).groups?.leaf_page_max * 1024
         }
      };
   let aggOptions = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": `Performing document distribution analysis with ${__script.name} v${__script.version}`
      },
      { 'system': { hostname } } = db.hostInfo(),
      { 'parsed': { 'storage': { dbPath } } } = db.serverCmdLineOpts(),
      metadataSize = 4096, // outside of WT stats (4k-64MB)
      ratio = +(dataSize / (storageSize - blocksFree - metadataSize)).toFixed(2);

   // Distribution buckets
   let range = (start, stop, step) => {
      return Array.from(
         { "length": (stop - start) / step + 1 },
         (_, idx) => start + idx * step
      );
   };
   let { maxBsonObjectSize } = db.hello();
   // byte offset to reach bucket inclusive boundary
   let buckets = range(1, maxBsonObjectSize + 1, internalPageSize),
      pages = range(1, maxBsonObjectSize + 1, dataPageSize);

   // measure document and page distribution
   let pipeline = [
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
            "URI": dhandle,
            "namespace": `${dbName}.${collName}`,
            "dataSize": dataSize,
            "storageSize": storageSize,
            "metadataSize": metadataSize,
            "freeBlocks": blocksFree,
            "utilisedBytes": storageSize - blocksFree - metadataSize,
            "utilisedPercentage": +(100 * (storageSize - blocksFree - metadataSize) / (storageSize - metadataSize)).toFixed(2), // + '%',
            "compressor": compressor,
            "compressionRatio": ratio,
            "documentCount": documentCount,
            "consumed32kPages": Math.ceil((storageSize - blocksFree - metadataSize) / dataPageSize),
            "avgDocsPer32kPage": +(documentCount / ((storageSize - blocksFree - metadataSize) / dataPageSize)).toFixed(0)
      } } }
   ];

   namespace.aggregate(pipeline, aggOptions).forEach(printjson);
})(options);

// EOF
