/*
 *  Name: "docsizes.js"
 *  Version: "0.1.5"
 *  Description: sample document size distribution
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet docsizes.js"

let __script = { "name": "docsizes.js", "version": "0.1.5" };
console.log(`\n---> Running script ${__script.name} v${__script.version}\n`);

/*
 *  User defined parameters
 */

let options = {
   "dbName": "database",
   "collName": "collection",
   "sampleSize": 1000,  // parameter to $sample
   "buckets": Array.from([0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], block => block * 1024),
   "pages": Array.from([0, 1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], block => block * 1024)
}

// connection preferences
if (typeof readPref === 'undefined') var readPref = (db.hello().secondary === false)
   ? 'primaryPreferred'
   : 'secondaryPreferred';

(() => {
   /*
   *  main
   */
   db.getMongo().setReadPref(readPref);
   let namespace = db.getSiblingDB(options.dbName).getCollection(options.collName),
      aggOptions = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": `Performing document distribution analysis with ${this.__script.name} v${this.__script.version}`
      },
      host = db.hostInfo().system.hostname,
      dbPath = db.serverCmdLineOpts().parsed.storage.dbPath,
      overhead = 0, // 2 * 1024 * 1024;
      pageSize = 32768;

   let {
      'size': dataSize,
      'wiredTiger': {
         'block-manager': {
            'file bytes available for reuse': blocksFree,
            'file size in bytes': storageSize
         },
         creationString
      },
      'count': documentCount
   } = namespace.stats();
   let compressor = creationString.match(/block_compressor=(?<compressor>\w+)/).groups.compressor;
   let ratio = +(dataSize / (storageSize - blocksFree - overhead)).toFixed(2);

   let pipeline = [
      { "$sample": { "size": options.sampleSize } },
      { "$facet": {
         "SampleTotals": [
            { "$group": {
               "_id": null,
               "dataSize": { "$sum": { "$bsonSize": "$$ROOT" } }
            } },
            { "$set": {
               "avgDocSize": { "$round": [{ "$divide": ["$dataSize", options.sampleSize] }, 0] },
               "sampleSize": options.sampleSize,
               "estStorageSize": { "$round": [{ "$divide": ["$dataSize", ratio] }, 0] },
            } },
            { "$unset": "_id" }
         ],
         "BSONdistribution": [
            { "$bucket": {
               "groupBy": { "$bsonSize": "$$ROOT" },
               "boundaries": options.buckets,
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
               "boundaries": options.pages,
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
            "host": host,
            "dbPath": dbPath,
            "namespace": `${options.dbName}.${options.collName}`,
            "dataSize": dataSize,
            "storageSize": storageSize,
            "freePages": blocksFree,
            "utilised": storageSize - blocksFree - overhead,
            "compressor": compressor,
            "compressionRatio": ratio,
            "documentCount": documentCount,
            "consumed32kPages": Math.ceil((storageSize - blocksFree - overhead)/pageSize),
            "avgDocsPer32kPage": +(documentCount/((storageSize - blocksFree - overhead)/pageSize)).toFixed(2)
      } } }
   ];

   namespace.aggregate(pipeline, aggOptions).forEach(printjson);
})()

// EOF
