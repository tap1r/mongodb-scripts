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

// load('pcg-xsh-rr.js');
load('mdblib.js');

/*
 *  User defined parameters
 */

let dbName = 'database', collName = 'collection';
let compressor = (serverVer() >= 4.2) ? 'zstd' : 'zlib';
// { "collation": { "locale": "simple" } }
let collation = {
    "locale": "simple" // ["simple"|"en"|"es"|"de"|"fr"]
};
let wc = 1; // bulk write concern
let dropPref = true; // drop collection prior to generating data
let exponent = 4; // order of magnitude (total documents)
let totalDocs = Math.ceil(getRandomNumber(1, 10) * 10 ** exponent);
let fuzzer = { // preferences
    "_id": "ts", // ["ts"|"oid"]
    "range": 365.25, // date range in days
    "vary_types": false, // fuzz value types
    "nests": 0, // how many nested layers
    "distribution": "uniform", // uniform, normal, bimodal, pareto, exponential
    "entropy": 100, // 0 - 100%
    "cardinality": 1, // experimental
    "sparsity": 0, // 0 - 100%
    "weighting": 50, // 0 - 100%
    "schemas": [{}, {}, {}],
    "ratios": [1, 0, 0]
};
var sampleSize = 9, docSize = 0;
fuzzer.ratios.forEach((ratio) => {
    sampleSize += parseInt(ratio);
});
sampleSize *= sampleSize;
let indexes = [ // createIndexes parameters
    { "date": 1 },
    { "location": "2dsphere" },
    { "random": 1 },
    { "timestamp": 1 },
    (serverVer() >= 4.2) ? { "object.$**": 1 } : { "object.oid": 1 }
];
let specialIndexes = [ // collations not supported
    { "2dlegacy": "2d" },
    { "string": "text" }
];

/*
 *  Global defaults
 */

var batch = 0, totalBatches = 1, residual = 0, doc = {};
let now = new Date().getTime();
let timestamp = (now/1000.0)|0;

function main() {
    /*
     *  main
     */
    for (let i = 0; i < sampleSize; ++i) {
        docSize += Object.bsonsize(genDocument());
    }
    let avgSize = (docSize / sampleSize)|0;
    print('\n');
    print('Sampling', sampleSize, 'document(s) with BSON size average:', avgSize, 'bytes');
    let batchSize = (bsonMax * 0.95 / avgSize)|0;
    print('Estimated optimal batch size capacity:', batchSize, 'documents');
    if (totalDocs < batchSize) {
        batchSize = totalDocs;
    } else {
        totalBatches += (totalDocs / batchSize)|0;
        residual = (totalDocs % batchSize)|0;
    }

    dropNS(dropPref);

    // generate and bulk write the docs
    print('\n');
    print('Generating', totalDocs, 'document(s) in', totalBatches, 'batch(es):');
    for (let i = 0; i < totalBatches; ++i) {
        if (i === totalBatches - 1 && residual > 0) {
            batchSize = residual;
        }

        var bulk = db.getSiblingDB(dbName).getCollection(collName).initializeUnorderedBulkOp();
        for (let batch = 0; batch < batchSize; ++batch) {
            doc = genDocument();
            bulk.insert(doc);
        }

        try {
            var result = bulk.execute({ "w": wc });
        } catch (e) {
            print(e);
        }

        print('...bulk inserting batch', i + 1, 'of', totalBatches,
              '(' + result.nInserted, 'document(s))');
    }

    print('\n');
    print('Completed generating:', totalDocs,
          'document(s) in "' + dbName + '.' + collName + '"');

    // create indexes
    print('\n');
    print('Building regular index(es) with collection locale "' + collation.locale + '":');
    indexes.forEach((index) => {
        printjson(index);
    });
    db.getSiblingDB(dbName).getCollection(collName).createIndexes(indexes, { "collation": collation } );
    print('\n');
    print('Building special index(es) with collation locale "simple":');
    specialIndexes.forEach((index) => {
        printjson(index);
    });
    db.getSiblingDB(dbName).getCollection(collName).createIndexes(specialIndexes, { "collation": { "locale": "simple" } });
    print('\n');
    print('Complete!');
    print('\n');

    return;
}

function genDocument() {
    /*
     *  generate pseudo-random key values
     */
    let dateOffset = rand() * fuzzer.range * 24 * 60 * 60;
    switch (fuzzer._id) {
        case 'oid':
            var oid = new ObjectId();
            break;
        default:
            var oid = new ObjectId(
                Math.floor(timestamp - (dateOffset)).toString(16) + 
                genRandomHex(16)
            );
    }

    let date = new Date(now - (dateOffset * 1000));
    let ts = new Timestamp(timestamp - (dateOffset), 1);
    let schemaA = {
        "_id": oid,
        "schema": "Shape A",
        "string": genRandomString(getRandomIntInclusive(6, 24)),
        "object": {
            "oid": new ObjectId(),
            "str": genRandomAlpha(getRandomIntInclusive(8, 16)),
            "num": +getRandomNumber(-1 * 2 ** 12, 2 ** 12).toFixed(4)
        },
        "array": genArrayElements(getRandomIntInclusive(0, 10)),
        "boolean": rand() < 0.5,
        "date": date,
        "timestamp": ts,
        "null": null,
        "int32": NumberInt(getRandomIntInclusive(-1 * 2 ** 31 - 1, 2 ** 31 - 1)),
        "int64": NumberLong(getRandomIntInclusive(-1 * 2 ** 63 - 1, 2 ** 63 - 1)),
        "double": getRandomNumber(-1 * 2 ** 12, 2 ** 12),
        "decimal128": NumberDecimal(getRandomNumber(-1 * 10 ** 127 - 1, 10 ** 127 -1)),
        "regex": /\/[A-Z0-9a-z]*\//,
        "bin": BinData(0, UUID().base64()),
        "uuid": UUID(),
        "md5": MD5(genRandomHex(32)),
        "fle": BinData(6, UUID().base64()),
        "2dlegacy": [
                    +getRandomNumber(-180, 180).toFixed(4),
                    +getRandomNumber(-90, 90).toFixed(4)
        ],
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
        "price": [+getRandomNumber(0, 10 ** 4).toFixed(2), genRandomCurrency()],
        "temperature": [+genNormal(15, 10).toFixed(1), ['°C', '°F', 'K'][getRandomIntInclusive(0, 2)]],
        "status": ['Active', 'Inactive', null][getRandomRatioInt([80, 20, 1])]
    };
    let schemaB = {
        "_id": oid,
        "schema": "Shape B",
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
    };
    let schemaC = {
        "_id": oid,
        "schema": "Shape C",
        "random": +getRandomNumber(0, totalDocs).toFixed(4)
    };
    fuzzer.schemas[0] = schemaA;
    fuzzer.schemas[1] = schemaB;
    fuzzer.schemas[2] = schemaC;

    return fuzzer.schemas[getRandomRatioInt(fuzzer.ratios)];
}

function dropNS(dropPref) {
    /*
     *  drop target namespace
     */
    if (dropPref) {
        print('\n');
        print('Dropping namespace "' + dbName + '.' + collName + '"');
        db.getSiblingDB(dbName).getCollection(collName).drop();
        print('Creating namespace "' + dbName + '.' + collName + '"',
              'with block compression "' + compressor + '"',
              'and collation locale "' + collation.locale + '"'
        );
        db.getSiblingDB(dbName).createCollection(collName,
            {
                "storageEngine": { "wiredTiger": { "configString": "block_compressor=" + compressor } },
                "collation": collation
            }
        )
    } else {
        print('\n');
        print('Not dropping namespace "' + dbName + '.' + collName + '"');
    }

    return;
}

/*
 *  Helper functions
 */

const K = 273.15;

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

    return (rand() * (max - min) + min)|0;
}

function getRandomIntInclusive(min = 0, max = 1) {
    /*
     *  generate random integer inclusive of the maximum
     */
    min = Math.ceil(min);
    max = Math.floor(max);

    return (rand() * (max - min + 1) + min)|0;
}

function getRandomRatioInt(ratios = [1]) {
    /*
     *  generate ratioed random integer
     */
    let weightedIndex = [];
    ratios.forEach((ratio, idx) => {
        for (let i = 0; i < ratio; ++i) {
            weightedIndex.push(idx);
        }
    });

    return weightedIndex[rand() * weightedIndex.length|0];
}

function genRandomHex(len = 1) {
    /*
     *  generate random hexadecimal string
     */
    let res = '';
    for (let i = 0; i < len; ++i) {
        res += (rand() * 16|0).toString(16);
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
       res += chars.charAt(rand() * chars.length|0);
    }

    return res;
}

function genRandomAlpha(len = 1) {
    /*
     *  generate random alpha-character string
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
     *  generate random symbol
     */
    let symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

    return symbol.charAt(rand() * symbol.length|0);
}

function genRandomCurrency() {
    /*
     *  generate random curreny symbol
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
     *  alpha controls the "shape" of the distribution
     */
    let u = 1.0 - rand();

    return min / u ** (1.0 / alpha);
}

function genRandomIntInclusivePareto(min, max, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the "shape" of the distribution
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

function ftoc(fahrenheit) {
    /*
     *  convert Fahrenheit to Celsius temparature unit
     */
    return (fahrenheit - 32) / 1.8;
}

function ctof(celsius) {
    /*
     *  convert Celsius to Fahrenheit temparature unit
     */
    return celsius * 1.8 + 32;
}

function ctok(celsius) {
    /*
     *  convert Celsius to Kelvin temparature unit
     */
    return celsius + K;
}

function ktoc(kelvin) {
    /*
     *  convert Kelvin to Celsius temparature unit
     */
    return kelvin - K;
}

function ftok(fahrenheit) {
    /*
     *  convert Fahrenheit to Kelvin temparature unit
     */
    return ((fahrenheit - 32) / 1.8) + K;
}

function ktof(kelvin) {
    /*
     *  convert Kelvin to Fahrenheit temparature unit
     */
    return (kelvin - K) * 1.8 + 32;
}

main();

// EOF
