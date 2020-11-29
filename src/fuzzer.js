/*
 *  Name: "fuzzer.js"
 *  Version = "0.1.0"
 *  Description: Generate pseudo random test data, with some fuzzing capability
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongo [connection options] --quiet fuzzer.js"

/*
 *  Load helper pcg-xsh-rr.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/pcg-xsh-rr.js)
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the current working directory
 */

load('pcg-xsh-rr.js');
load('mdblib.js');

/*
 *  User defined parameters
 */

let dbName = 'database', collName = 'collection';
// var batchSize = 1000; // adjust only if exceeding the BSON cap under Bulk
let dropPref = true; // drop collection prior to generating data
let exponent = 4; // number of doc by order of magnitude
let totalDocs = Math.ceil(getRandomNumber(1, 10) * 10 ** exponent);
let days = 365.25; // date range
let fuzzer = { // not in use
    "_id": "", // default to server/bulk generation
    "vary_types": false, // fuzz value types
    "nests": 0, // how many nested layers
    "distribution": "uniform", // uniform, normal, bimodal, pareto, exponent
    "range": "max", // min, max, %
    "cardinality": 1, // experimental
    "sparsity": 0, // 0 - 100%
    "weighting": 50 // 0 - 100%
};
let indexes = [ // createIndexes parameters
    // { "oid": { unique: true } },
    { "date": 1 },
    { "location": "2dsphere" },
    { "random": 1 },
    { "timestamp": 1 }
];
let wc = 1; // bulk write concern

/*
 *  Global defaults
 */

var batch = 0, totalBatches = 1, residual = 0, doc = {};
let now = new Date().getTime();
let timestamp = Math.floor(now/1000.0);

function main() {
    /*
     *  main
     */
    let avgSize = Object.bsonsize(genDocument());
    print('\n');
    print('Estimated document BSON size is:', avgSize, 'bytes');
    let batchSize = Math.floor((bsonMax * 0.8 / avgSize) / 1000) * 1000;
    print('Estimated optimal batch size capacity:', batchSize, 'documents');
    if (totalDocs < batchSize) {
        batchSize = totalDocs;
    } else {
        totalBatches += Math.floor(totalDocs / batchSize);
        residual = Math.floor(totalDocs % batchSize);
    }

    dropNS(dropPref);

    // generate and bulk write the docs
    print('\n');
    print('Generating', totalDocs, 'documents in', totalBatches, 'batch(es)');
    for (let i = 0; i < totalBatches; ++i) {
        if (i === totalBatches - 1 && residual > 0) {
            batchSize = residual;
        }

        var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
        for (let batch = 0; batch < batchSize; ++batch) {
            doc = genDocument();
            bulk.insert(doc);
        }

        var result = bulk.execute({ "w": wc });
        print('...bulk inserting batch', i + 1, 'of', totalBatches,
            '(' + result.nInserted, 'documents)');
    }

    print('\n');
    print('Completed generating:', totalDocs,
        'documents in "' + dbName + '.' + collName + '"');

    // create indexes
    print('\n');
    print('Building indexes:');
    indexes.forEach((index) => {
        printjson(index);
    });
    db.getSiblingDB(dbName).getCollection(collName).createIndexes(indexes, {}, 1);
    print('\n');
    print('Complete!');
    print('\n');
}

function genDocument() {
    /*
     *  generate pseudo-random key values
     */
    return {
        // "_id": new ObjectId(),
        "string": genRandomString(getRandomIntInclusive(6, 24)),
        "object": {
            "oid": ObjectId(),
            "str": genRandomAlpha(getRandomIntInclusive(8, 16)),
            "num": +getRandomNumber(-1 * 2 ** 12, 2 ** 12).toFixed(4)
        },
        "array": genArrayElements(getRandomIntInclusive(0, 10)),
        "boolean": rand() < 0.5,
        "date": new Date(now - (rand() * days * 24 * 60 * 60 * 1000)),
        "timestamp": new Timestamp(timestamp - (rand() * days * 24 * 60 * 60), 1),
        "null": null,
        "int32": NumberInt(getRandomIntInclusive(-1 * 2 ** 31 - 1, 2 ** 31 - 1)),
        "int64": NumberLong(getRandomIntInclusive(-1 * 2 ** 63 - 1, 2 ** 63 - 1)),
        "double": getRandomNumber(-1 * 2 ** 12, 2 ** 12),
        "decimal128": NumberDecimal(getRandomNumber(-1 * 10 ** 127 - 1, 10 ** 127 -1)),
        "regex": /\/[A-Z0-9a-z]*\//,
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5(genHexString(32)),
        "fle": BinData(6, UUID().base64()),
        "location": {
            "type": "Point",
                "coordinates": [
                    +getRandomNumber(-180, 180).toFixed(4),
                    +getRandomNumber(-90, 90).toFixed(4)
                ]
        },
        "random": +getRandomNumber(0, totalDocs).toFixed(4),
        "symbol": genRandomSymbol(),
        "unit": +getRandomNumber(0, 10 ** 6).toFixed(2),
        "qty": NumberInt(getRandomIntInclusive(0, 10 ** 4)),
        "currency": genRandomCurrency(),
        "price": +getRandomNumber(0, 10 ** 4).toFixed(2),
        "temperature": +genNormal(15, 10).toFixed(1),
        "temperatureUnit": ['°C', '°F', 'K'][getRandomIntInclusive(0, 2)]
    };
}

function dropNS(dropPref) {
    /*
     *  drop target namespace
     */
    if (dropPref) {
        print('\n');
        print('Dropping namespace:', dbName + '.' + collName);
        db.getSiblingDB(dbName).getCollection(collName).drop();
    } else {
        print('\n');
        print('Not dropping namespace:', dbName + '.' + collName);
    }

    return;
}

function getRandomNumber(min = 0, max = 1) {
    /*
     *  generate random number
     */
    return rand() * (max - min) + min;
}

function getRandomInt(min = 0, max = 1) {
    /*
     *  generate random integer
     */
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(rand() * (max - min) + min);
}

function getRandomIntInclusive(min = 0, max = 1) {
    /*
     *  generate random integer inclusive of the maximum
     */
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(rand() * (max - min + 1) + min);
}

function genHexString(len = 1) {
    /*
     *  generate hexadecimal string
     */
    let res = '';
    for (let i = 0; i < len; ++i) {
        res += (Math.floor(rand() * 16)).toString(16);
    }

    return res;
}

function genRandomString(len = 1) {
    /*
     *  generate random alpha-numeric string
     */
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(Math.floor(rand() * chars.length));
    }

    return res;
}

function genRandomAlpha(len = 1) {
    /*
     *  fetch random alpha character
     */
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(getRandomInt(0, chars.length));
    }

    return res;
}

function genRandomSymbol() {
    /*
     *  fetch random symbol
     */
    let symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';
    return symbol.charAt(Math.floor(rand() * symbol.length));
}

function genRandomCurrency() {
    /*
     *  fetch random curreny symbol
     */
    let currencies = ['$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱zł', '₲', '฿', '₴', '₫'];
    return currencies[getRandomInt(0, currencies.length)];
}

function genArrayElements(len) {
    /*
     *  generate array of random strings
     */
    let array = [];
    for (let i = 0; i < len; ++i) {
        array.push(genRandomString(getRandomIntInclusive(6, 24)));
    }

    return array;
}

function genRandomInclusivePareto(min, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the “shape” of the distribution
     */
    let u = 1.0 - rand();
    return min / u ** (1.0 / alpha);
}

function randomIntInclusivePareto(min, max, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the “shape” of the distribution
     */
    let k = max * (1.0 - rand()) + min
    let v = k ** alpha;
    return v + min;
}

function genNormal(mu, sigma) {
    /*
     *  mu = mean
     *  sigma = standard deviation
     */
    let x = Math.sqrt(-2.0 * Math.log(rand())) * Math.cos(Math.PI*2 * rand());
    return x * sigma + mu;
}

function genExponential(lambda = 1) {
    /*
     *  exponential distribution function
     */
    return -Math.log(1.0 - rand()) / lambda;
}

function toCelsius(fahrenheit) {
    /*
     *  convert temparature unit
     */
    return (5/9) * (fahrenheit-32);
}

main();

// EOF
