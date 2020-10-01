/*
 *  fuzzer.js
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Created by: luke.prochazka@mongodb.com
 */

// Usage: "mongo [+connection options] --quiet fuzzer.js"

// User defiend parameters

let dbName = 'database', collName = 'collection';
let dropPref = true; // drop collection prior to generating data
let exp = 5; // number of doc by order of magnitude
let totalDocs = Math.ceil(Math.random() * 10 ** exp);
let days = 365; // date range
var fuzzer = { // not in use
    _id: '', // default to server generation
    vary_types: false, // fuzz value types
    nests: 0, // how many nested layers
    mode: "random", // random, bell, bimodal
    range: "max", // min, max, %
    cardinality: 1, //
    sparsity: 0 // 0 - 100%
};
var indexes = [ // createIndex options document
    // { "oid": { unique: true } },
    { "date": 1 },
    { "location": "2dsphere" },
    { "random": 1 },
    { "timestamp": 1 }
];

// global defaults

var iter = 0, batch = 0, batchSize = 1000, doc = {};
let now = new Date().getTime();
let timestamp = Math.floor(now/1000.0);
if (totalDocs < batchSize) {
    var iter = 1;
    var batchSize = totalDocs;
} else {
    var iter = Math.floor(totalDocs / batchSize);
}

let residual = Math.floor(totalDocs % batchSize);

/*
 * main
 */

function dropNS(dropPref) {
    return (dropPref ? db.getSiblingDB(dbName).getCollection(collName).drop() : print('Not dropping collection'));
}

function genRandomNumber(min, max) {
    return Math.random() * (max - min) + min;
}

function genRandomInteger(min, max) {
    var min = Math.ceil(min);
    var max = Math.floor(max);
    return Math.floor(Math.random() * (max - min) + min);
}

function genHexString(len) {
    let res = '';
    for (let i = 0; i < len; ++i) {
        res += (Math.floor(Math.random() * 16)).toString(16);
    }
    return res;
}

function genRandomString(len) {
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
}

function genRandomAlpha(len) {
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return res;
}

function genRandomSymbol() {
    let symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';
    return symbol.charAt(Math.floor(Math.random() * symbol.length));
}

function genRandomCurrency() {
    let symbol = [ '$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱zł', '₲', '฿', '₴', '₫' ];
    return symbol[(Math.floor(Math.random() * symbol.length))];
}

function genDoc() {
    /*
     * Generate pseudo-random doc values
     */
    return {
        // "_id": new ObjectId(),
        "string": genRandomString(genRandomInteger(6, 24)),
        "object": {
            "oid": ObjectId(),
            "str": genRandomAlpha(genRandomInteger(8, 16)),
            "num": +genRandomNumber(-1 * 2 ** 12, 2 ** 12).toFixed(4)
        },
        "array": [ "element1", "element2" ],
        "boolean": Math.random() < 0.5,
        "date": new Date(now - (Math.random() * days * 24 * 60 * 60 * 1000)),
        "timestamp": new Timestamp(timestamp - (Math.random() * days * 24 * 60 * 60), 1),
        "null": null,
        "int32": NumberInt(genRandomNumber(-1 * 2 ** 31 - 1, 2 ** 31 - 1)),
        "int64": NumberLong(genRandomNumber(-1 * 2 ** 63 - 1, 2 ** 63 - 1)),
        "double": genRandomNumber(-1 * 2 ** 12, 2 ** 12),
        "decimal128": NumberDecimal(genRandomNumber(-1 * 2 ** 127 - 1, 2 ** 127 - 1)),
        "regex": /\/[0-9a-z]*\//,
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5(genHexString(32)),
        "fle": BinData(6, UUID().base64()),
        "location": {
            "type": "Point",
                "coordinates": [
                    +genRandomNumber(-180, 180).toFixed(4),
                    +genRandomNumber(-90, 90).toFixed(4)
                ]
        },
        "random": +genRandomNumber(0, totalDocs).toFixed(4),
        "symbol": genRandomSymbol(),
        "currency": genRandomCurrency()
    };
}

dropNS(dropPref);
// generate and bulk write the docs
print('Number of batches:', iter, 'plus', residual, 'remainder documents');
for (let i = 0; i < iter; ++i) {
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    for (let batch = 0; batch < batchSize; ++batch) {
        bulk.insert(genDoc());
    }
    result = bulk.execute({ w: 1 });
    print('Processing batch', i + 1, 'of', iter, '(' + result.nInserted, 'documents inserted)');
}

if (residual) {
    var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
    for (let batch = 0; batch < residual; ++batch) {
        bulk.insert(genDoc());
    }
    result = bulk.execute({ w: 1 });
    print('Processing remainder batch,', result.nInserted, 'documents inserted');
}

print('Building indexes');

// create indexes
indexes.forEach((index) => {
    printjson(index);
    db.getSiblingDB(dbName).getCollection(collName).createIndex(index);
})

print('Completed generating:', totalDocs, 'documents in "' + dbName + '.' + collName + '"');

// EOF
