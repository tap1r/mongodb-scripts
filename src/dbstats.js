// DB storage stats uber script
// - created by luke.prochazka@mongodb.com

// Usage: "mongo [+options] --quiet dbstats.js"

/* Helper functions
 *  https://github.com/uxitten/polyfill/blob/master/string.polyfill.js
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padStart
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padEnd
 */

String.prototype.padStart = function padStart(targetLength, padString) {
    targetLength = targetLength >> 0; //truncate if number, or convert non-number to 0;
    padString = String(typeof padString !== 'undefined' ? padString : ' ');
    if (this.length >= targetLength) {
        return String(this);
    } else {
        targetLength = targetLength - this.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength / padString.length); //append to original to ensure we are longer than needed
        }
        return padString.slice(0, targetLength) + String(this);
    }
};

String.prototype.padEnd = function padEnd(targetLength, padString) {
    targetLength = targetLength >> 0; //floor if number or convert non-number to 0;
    padString = String((typeof padString !== 'undefined' ? padString : ' '));
    if (this.length > targetLength) {
        return String(this);
    } else {
        targetLength = targetLength - this.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength / padString.length); //append to original to ensure we are longer than needed
        }
        return String(this) + padString.slice(0, targetLength);
    }
};

// Helper classes

class ScaleFactor {
    /*
     * Scale formatting preferences
     */
    constructor(unit) {
        // default to MB
        switch (unit) {
            case 'B': return { name: "bytes", unit: "B", symbol: "", factor: Math.pow(1024, 0), precision: 0, pctPoint: 2 };
            case 'KB': return { name: "kilobytes", unit: "KB", symbol: "k", factor: Math.pow(1024, 1), precision: 2, pctPoint: 1 };
            case 'MB': return { name: "megabytes", unit: "MB", symbol: "M", factor: Math.pow(1024, 2), precision: 2, pctPoint: 1 };
            case 'GB': return { name: "gigabytes", unit: "GB", symbol: "G", factor: Math.pow(1024, 3), precision: 2, pctPoint: 1 };
            case 'TB': return { name: "terabytes", unit: "TB", symbol: "T", factor: Math.pow(1024, 4), precision: 2, pctPoint: 1 };
            case 'PB': return { name: "petabytes", unit: "PB", symbol: "P", factor: Math.pow(1024, 5), precision: 2, pctPoint: 1 };
            case 'EB': return { name: "exabytes", unit: "EB", symbol: "E", factor: Math.pow(1024, 6), precision: 2, pctPoint: 1 };
            default: return { name: "megabytes", unit: "MB", symbol: "M", factor: Math.pow(1024, 2), precision: 2, pctPoint: 1 };
        }
    }
}

// Global defaults

var getStats = function() {}, printHeader = function() {};
var fmtUnit = function() {}, fmtUPct = function() {}, fmtRatio = function() {};
var printCollection = function() {}, printDb = function() {}, printDbPath = function() {};
var collection = {}, database = {}, dbPath = {};

/*
 * Formatting preferences
 */

const scale = new ScaleFactor(); // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'
const termWidth = 120;
const columnWidth = 16;
const rowHeader = 27;

/*
 * main
 */

var getStats = function () {
    /*
     *  Gather DB stats
     */
    dbPath = { dataSize: 0, storageSize: 0, objects: 0, indexSize: 0, freeBlocks: 0, compression: 0 };
    db.getMongo().getDBNames().forEach(function (dbName) {
        database = { name: "", dataSize: 0, storageSize: 0, objects: 0, indexSize: 0, freeBlocks: 0, compression: 0 };
        dbStats = db.getSiblingDB(dbName).stats();
        database.name = dbStats.db;
        database.objects = dbStats.objects;
        database.dataSize = dbStats.dataSize;
        database.storageSize = dbStats.storageSize;
        database.indexSize = dbStats.indexSize;
        printHeader();
        db.getSiblingDB(dbName).getCollectionNames().forEach(function (collName) {
            collection = { name: "", dataSize: 0, storageSize: 0, objects: 0, freeBlocks: 0, compression: 0 };
            collStats = db.getSiblingDB(dbName).getCollection(collName).stats();
            collection.name = collStats.ns.substr(collStats.ns.indexOf('.') + 1);
            collection.objects = collStats.count;
            collection.dataSize = collStats.size;
            collection.storageSize = collStats.wiredTiger['block-manager']['file size in bytes'];
            collection.freeBlocks = collStats.wiredTiger['block-manager']['file bytes available for reuse'];
            collection.compression = collection.dataSize / (collection.storageSize - collection.freeBlocks)
            // printjson(collection);
            printCollection();
            database.freeBlocks += collection.freeBlocks;
        })
        database.compression = database.dataSize / (database.storageSize - database.freeBlocks);
        // printjson(database);
        printDb();
        dbPath.dataSize += database.dataSize;
        dbPath.storageSize += database.storageSize;
        dbPath.objects += database.objects;
        dbPath.indexSize += database.indexSize;
        dbPath.freeBlocks += database.freeBlocks;
    })
    dbPath.compression = dbPath.dataSize / (dbPath.storageSize - dbPath.freeBlocks);
    // printjson(dbPath);
    printDbPath();
};

var fmtUnit = function (metric) {
    /*
     *  Pretty format unit
     */
    return (metric / scale.factor).toFixed(scale.precision) + ' ' + scale.unit;
};

var fmtPct = function (numerator, denominator) {
    /*
     *  Pretty format percentage
     */
    return (numerator / denominator * 100).toFixed(scale.pctPoint) + '%';
};

var fmtRatio = function (metric) {
    /*
     *  Pretty format ratio
     */
    return (metric).toFixed(scale.precision) + ':1'
};

var printHeader = function () {
    /*
     *  Print table header
     */
    print('='.repeat(termWidth));
    print('Database:', database.name);
    print('-'.repeat(termWidth));
    print(' Collection'.padEnd(rowHeader), 'Data size'.padStart(columnWidth), 'Size on disk'.padStart(columnWidth),
          'Obj count'.padStart(columnWidth), 'Free blocks (reuse)'.padStart(columnWidth + 8), 'Compression'.padStart(columnWidth)
    );
};

var printCollection = function () {
    /*
     *  Print collection level stats
     */
    print('-'.repeat(termWidth));
    print(('  ' + collection.name).padEnd(rowHeader),
          fmtUnit(collection.dataSize).padStart(columnWidth),
          fmtUnit(collection.storageSize).padStart(columnWidth),
          collection.objects.toString().padStart(columnWidth),
          (fmtUnit(collection.freeBlocks) +
          ('(' + fmtPct(collection.freeBlocks, collection.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          fmtRatio(collection.compression).padStart(columnWidth)
    );
};

var printDb = function () {
    /*
     *  Print DB level rollup stats
     */
    print('-'.repeat(termWidth));
    print('Collection subtotals:'.padEnd(rowHeader),
          fmtUnit(database.dataSize).padStart(columnWidth),
          fmtUnit(database.storageSize).padStart(columnWidth),
          database.objects.toString().padStart(columnWidth),
          (fmtUnit(database.freeBlocks).padStart(columnWidth) +
          ('(' + fmtPct(database.freeBlocks, database.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          fmtRatio(database.compression).padStart(columnWidth)
    );
    print('DB Index size:'.padEnd(rowHeader),
          ''.padStart(columnWidth),
          fmtUnit(database.indexSize).padStart(columnWidth)
    );
    print('Subtotal:'.padEnd(rowHeader),
          fmtUnit(database.dataSize).padStart(columnWidth),
          fmtUnit(database.storageSize + database.indexSize).padStart(columnWidth),
          database.objects.toString().padStart(columnWidth),
          (fmtUnit(database.freeBlocks).padStart(columnWidth) +
          ('(' + fmtPct(database.freeBlocks, database.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          fmtRatio(database.compression).padStart(columnWidth)
    );
    print('='.repeat(termWidth));
};

var printDbPath = function () {
    /*
     *  Print total rollup stats
     */
    print('\n' + '='.repeat(termWidth));
    print('Rollup stats'.padEnd(rowHeader), 'Data size'.padStart(columnWidth), 'Size on disk'.padStart(columnWidth),
          'Obj count'.padStart(columnWidth), 'Free blocks (reuse)'.padStart(columnWidth + 8), 'Compression'.padStart(columnWidth)
    );
    print('-'.repeat(termWidth));
    print('DB subtotals:'.padEnd(rowHeader),
          fmtUnit(dbPath.dataSize).padStart(columnWidth),
          fmtUnit(dbPath.storageSize).padStart(columnWidth),
          dbPath.objects.toString().padStart(columnWidth),
          (fmtUnit(dbPath.freeBlocks) +
          ('(' + fmtPct(dbPath.freeBlocks, dbPath.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          fmtRatio(dbPath.compression).padStart(columnWidth)
    );
    print('All indexes:'.padEnd(rowHeader),
          ''.padStart(columnWidth),
          fmtUnit(dbPath.indexSize).padStart(columnWidth)
    );
    print('Total:'.padEnd(rowHeader),
          fmtUnit(dbPath.dataSize).padStart(columnWidth),
          fmtUnit(dbPath.storageSize + dbPath.indexSize).padStart(columnWidth),
          dbPath.objects.toString().padStart(columnWidth),
          (fmtUnit(dbPath.freeBlocks) +
          ('(' + fmtPct(dbPath.freeBlocks, dbPath.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          fmtRatio(dbPath.compression).padStart(columnWidth)
    );
    print('='.repeat(termWidth));
};

getStats();

// EOF