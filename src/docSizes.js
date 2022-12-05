/*
 *  Name: "docSizes.js"
 *  Version: "0.1.9"
 *  Description: sample document size distribution
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet docSizes.js"

let __script = { "name": "docSizes.js", "version": "0.1.9" };
console.log(`\n---> Running script ${__script.name} v${__script.version}\n`);

/*
 *  User defined parameters
 */

let options = {
   "dbName": "database",
   "collName": "collection",
   // "sampleSize": 1000,
   // "buckets": [],
   // "pages": []
};

(({
      dbName,
      collName,
      sampleSize = 1000,   // parameter to $sample
      buckets = Array.from([0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], block => block * 1024),
      pages = Array.from([0, 1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], block => block * 1024)
   }) => {
   /*
    *  main
    */

   // connection preferences
   if (typeof readPref === 'undefined') var readPref = (db.hello().secondary === false)
      ? 'primaryPreferred'
      : 'secondaryPreferred';
   db.getMongo().setReadPref(readPref);

   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   let {
         'size': dataSize,
         'wiredTiger': {
            'block-manager': {
               'file bytes available for reuse': blocksFree,
               'file size in bytes': storageSize
            },
            'uri': dhandle,
         },
         'count': documentCount,
         compressor
   } = Object.assign(
      { get compressor() {
         return this['wiredTiger']['creationString'].match(/block_compressor=(?<compressor>\w+)/).groups.compressor
      } },
      namespace.stats()
   );
   let aggOptions = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": `Performing document distribution analysis with ${this.__script.name} v${this.__script.version}`
      },
      { 'system': { hostname } } = db.hostInfo(),
      { 'parsed': { 'storage': { dbPath } } } = db.serverCmdLineOpts(),
      overhead = 0, // 2 * 1024 * 1024;
      pageSize = 32768,
      ratio = +(dataSize / (storageSize - blocksFree - overhead)).toFixed(2);

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
            "freePages": blocksFree,
            "utilised": storageSize - blocksFree - overhead,
            "compressor": compressor,
            "compressionRatio": ratio,
            "documentCount": documentCount,
            "consumed32kPages": Math.ceil((storageSize - blocksFree - overhead) / pageSize),
            "avgDocsPer32kPage": +(documentCount/((storageSize - blocksFree - overhead) / pageSize)).toFixed(2)
      } } }
   ];

   namespace.aggregate(pipeline, aggOptions).forEach(printjson);
})(options);

// EOF
