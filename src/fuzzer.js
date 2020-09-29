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
let totalDocs = Math.ceil(Math.random() * 10 ** x);
print('Generating:', totalDocs, 'total documents');
var fuzzer = {
    _id: "", // default to server generation
    types: false,
    mode: "random", // random, bell, bimodal
    range: "max", // min, max, %
    sparsity: 100, //
};
var indexes = [
    { "oid": { unique: true } },
    { "position": "2dsphere" },
    { "random": 1 }
];

// global defaults

var i = 0, iter = 0, batch = 0, batchSize = 1000, doc = {};
if (totalDocs < batchSize) {
    var iter = 1;
    var batchSize = totalDocs;
} else {
    var iter = Math.floor(totalDocs / batchSize);
}
let residual = Math.floor(totalDocs % batchSize);

print('Number batches:', iter, 'plus', residual, 'remainder documents');

/*
 * main
 */

function dropNS(dropPref) {
    return (dropPref ? db.getSiblingDB(dbName).getCollection(collName).drop() : print('Not dropping collection'));
}

function getRandomNumber(min, max) {
    return Math.random() * (max - min) + min;
}

function getRandomInteger(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1) + min); //The maximum is inclusive and the minimum is inclusive 
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
        "int32": NumberInt(getRandomNumber(-1 * 2 ** 31 - 1, 2 ** 31 - 1)),
        "int64": NumberLong(getRandomNumber(-1 * 2 ** 63 - 1, 2 ** 63 - 1)),
        "double": getRandomNumber(-1 * 2 ** 12, 2 ** 12),
        // "decimal128": NumberDecimal(Math.random() * (2 ** 127 -1)),
        "decimal128": NumberDecimal(getRandomNumber(-1 * 2 ** 127 -1, 2 ** 127 -1)),
        "regex": /\/[0-9a-f]*\//,
        "binary": BinData(0, "TW9uZ29EQg=="),
        "uuid": UUID(),
        "md5": MD5("34d5a8157bd743a382823b7d3cc9a670"),
        "fle": BinData(6, "TW9uZ29EQg=="),
        "position": {
            "type": "Point",
                "coordinates": [
                    +getRandomNumber(-180, 180).toFixed(4),
                    +getRandomNumber(-90, 90).toFixed(4)
                ]
        },
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
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
    result = bulk.execute({ w: 1 });
    batch = 0;
    ++i;
    print('Processing batch', i, 'of', iter, '(' + result.nInserted, 'documents inserted)');
}

if (residual) {
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    while (batch < residual) {
        bulk.insert(genDoc());
        ++batch
    }
    result = bulk.execute({ w: 1 });
    print('Processing remainder batch,', result.nInserted, 'documents inserted');
}

print('Building indexes');

// create indexes
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "position": "2dsphere" });
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "oid": 1} , { unique: true });
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "timestamp": 1 });
db.getSiblingDB(dbName).getCollection(collName).createIndex({ "random": 1 });

print('Complete');

// EOF
