/*
 *  fuzzer.js
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Created by: luke.prochazka@mongodb.com
 */

// Usage: "mongo [+connection options] --quiet fuzzer.js"

// User defiend parameters

let dbName = 'database', collName = 'collection';
let dropPref = true; // drop collection prior to generating data
let x = 5; // number of doc by order of magnitude
let totalDocs = _rand() * 10 ** x;
var fuzzer = {
    _id: "", // default to server generation
    types: false,
    mode: "random", // random, bell, bimodal
    range: "max", // min, max, %
    sparsity: 100, //
};
var indexes = {
    "oid": { unique: true },
    "position": "2dsphere",
    "random": 1
};

// global defaults

var i = 0, batch = 0, batchSize = 1000, doc = {};
if (totalDocs < batchSize) {
    var iter = 1;
    var batchSize = totalDocs;
} else {
    var iter = totalDocs / batchSize;
}
let residual = Math.floor(totalDocs % 1000);

/*
 * main
 */

function dropNS(dropPref) {
    return (dropPref ? db.getSiblingDB(dbName).getCollection(collName).drop() : print('Not dropping collection'));
}

function getRandomIntInclusive(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(_rand() * (max - min + 1) + min); //The maximum is inclusive and the minimum is inclusive 
}

function genDoc() {
    /*
     * Generate pseudo-random doc values
     */
    return {
        "oid": new ObjectId(),
        "string": "abcdefg",
        "object": {
            "a": "b",
            "x": "y"
        },
        "array": [ "element1", "element2" ],
        "boolean": true,
        "date": new ISODate(),
        "timestamp": new Timestamp(),
        "null": null,
        "int32": NumberInt(Math.floor(_rand() * ( 2 ** 32 - 1))),
        "int64": NumberLong(Math.floor(_rand() * ( 2 ** 63 - 1))),
        "double": _rand() * (2 ** 63 -1),
        "decimal128": NumberDecimal(_rand() * 2 ** 128),
        "regex": /\/[0-9a-f]*\//,
        "binary": BinData(0, "TW9uZ29EQg=="),
        "uuid": BinData(4, "abcdef12abcd1234abcdabcdef123456"),
        "md5": BinData(5, "TW9uZ29EQg=="),
        "fle": BinData(6, "TW9uZ29EQg=="),
        "position": {
            "type": "Point",
                "coordinates": [
                    +((_rand() * 360) - 180).toFixed(4),
                    +((_rand() * 180) - 90).toFixed(4)
                ]
        },
        "random": _rand(),
        "MinKey": { $minKey: 1 },
        "MaxKey": { $maxKey: 1 }
    };
}

dropNS(dropPref);

// generate and bulk write the docs
while (i < iter) {
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    while (batch < batchSize) {
        bulk.insert(genDoc());
        ++batch
    }
    bulk.execute();
    batch = 0;
    ++i;
}
if (residual) {
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    while (batch < residual) {
        bulk.insert(genDoc());
        ++batch
    }
    bulk.execute();
}

// create indexes
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "position": "2dsphere" });
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "oid": 1} , { unique: true });
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "timestamp": 1 });
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "random": 1 });

// EOF
