/*
 *  fuzzer.js
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Created by: luke.prochazka@mongodb.com
 */

// Usage: "mongo [+connection options] --quiet fuzzer.js"

// User defiend parameters

let dbName = 'database';
let collName = 'collection';
let x = 5; // number of doc by order of magnitude
var fuzzer = {
    _id: "", // default to server generation
    types: false,
    mode: "random", // random, bell, bimodal
    range: "max", // min, max, %
    sparsity: 100, //
};

// global defaults

var i = 0, batch = 0, doc = {};
let batchSize = 1000;
var iter = _rand() * 10 ** x / batchSize;

/*
 * main
 */

db.getSiblingDB(dbName).getCollection(collName).drop()

function genDoc() {
    /*
     * Generate pseudo-random doc values
     */
    return {
        "OID": new ObjectId(),
        "string": "abcdefg",
        "object": {
            "a": "b",
            "x": "y"
        },
        "array": ["element1", "element2"],
        "boolean": true,
        "date": new ISODate(),
        "timestamp": new Timestamp(),
        "null": null,
        "int32": NumberInt(_rand() * 2 ** 32),
        "int64": NumberLong(_rand() * 2 ** 64),
        "float": 92233720368.54775807,
        "decimal128": NumberDecimal(50.0005),
        "regex": /\/[0-9a-f]*\//,
        "binary": BinData(0, "TW9uZ29EQg=="),
        "uuid": BinData(4, "TW9uZ29EQg=="),
        "md5": BinData(5, "TW9uZ29EQg=="),
        "fle": BinData(6, "TW9uZ29EQg=="),
        "position": {
            "type": "Point",
                "coordinates": [{
                      "$numberDouble": "3.2"
                    },{
                      "$numberDouble": "51.9"
                }]
        },
        "random": _rand(),
        "MinKey": { "$minKey": 1 },
        "MaxKey": { "$maxKey": 1 }
    };
}

while (i < iter) {
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    while (batch < batchSize) {
        bulk.insert(genDoc());
        batch++
    }
    bulk.execute();
    batch = 0;
    i++;
}

// EOF
