/*
 *  Name: "docsizes.js"
 *  Version: "0.1.2"
 *  Description: sample document size distribution
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongosh [connection options] --quiet docsizes.js"

let __script = { "name": "docsizes.js", "version": "0.1.2" };
console.log(`\n---> Running script ${__script.name} v${__script.version}\n`);

/*
 *  User defined parameters
 */

let options = {
    "dbName": "database",
    "collName": "collection",
    "sampleSize": 1000,
    "buckets": Array.from([0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], block => block * 1024),
    "pages": Array.from([0, 1, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384], block => block * 1024)
}

// connection preferences
if (typeof readPref === 'undefined') var readPref = (db.hello().secondary === false)
    ? 'primaryPreferred'
    : 'secondaryPreferred';

db.getMongo().setReadPref(readPref);

function main() {
    /*
     *  main
     */
    let namespace = db.getSiblingDB(options.dbName).getCollection(options.collName),
        aggOptions = {
            "allowDiskUse": true,
            "cursor": { "batchSize": 0 },
            "readConcern": { "level": "local" },
            "comment": "Performing document distribution analysis with "
                + this.__script.name
                + " v"
                + this.__script.version,
            // "let": { } // Added in MongoDB v5.0
        },
        host = db.hostInfo().system.hostname,
        dbPath = db.serverCmdLineOpts().parsed.storage.dbPath,
        stats = namespace.stats(),
        dataSize = stats.size,
        blocksFree = stats.wiredTiger['block-manager']['file bytes available for reuse'],
        storageSize = stats.wiredTiger['block-manager']['file size in bytes'],
        compressor = stats.wiredTiger.creationString.match(/block_compressor=[a-z]+/)[0].slice(17),
        documentCount = stats.count,
        overhead = 0, // 2 * 1024 * 1024;
        ratio = +(dataSize / (storageSize - blocksFree - overhead)).toFixed(2);

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
                        "compressionRatio": ratio,
                        "compressor": compressor,
                        "estStorageSize": { "$round": [{ "$divide": ["$dataSize", ratio] }, 0] }
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
                        }
                    } },
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
                        }
                    } },
                    { "$set": { "bucket": "$_id" } },
                    { "$unset": "_id" }
                ]
            } },
            /* { "$set": {
                "CollectionTotals": {
                    "$set": {
                        "host": host,
                        "dbPath": dbPath,
                        "namespace": namespace,
                        "dataSize": dataSize,
                        "storageSize": storageSize,
                        "compressor": compressor,
                        "compressionRatio": ratio,
                        "documentCount": documentCount
                } }
            } } */
        ];

    namespace.aggregate(pipeline, aggOptions).forEach(printjson);
}

main();

// EOF
