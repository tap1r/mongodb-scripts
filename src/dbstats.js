/*
 *  dbstats.js
 *  Description: DB storage stats uber script
 *  Created by: luke.prochazka@mongodb.com
 */

// Usage: "mongo [+connection options] --quiet dbstats.js"

/*
 *  Load helper library (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save mdblib.js to the local directory for the mongo shell to read
 */

load('mdblib.js');

// Global defaults

var dbPath, database, collection, dbStats, collStats = {};

/*
 * Formatting preferences
 */

const scale = new ScaleFactor(); // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
let termWidth = 120, columnWidth = 15, rowHeader = 32;

/*
 * main
 */

function getStats() {
    /*
     *  Gather DB stats
     */
    dbPath = { "name": "", "dataSize": 0, "storageSize": 0, "objects": 0, "freeBlocks": 0, "compression": 0, "indexSize": 0, "indexFree": 0 };
    db.getMongo().getDBNames().forEach((dbName) => {
        database = { "name": "", "dataSize": 0, "storageSize": 0, "objects": 0, "freeBlocks": 0, "compression": 0, "indexSize": 0, "indexFree": 0 };
        dbStats = db.getSiblingDB(dbName).stats();
        database.name = dbStats.db;
        database.objects = dbStats.objects;
        database.dataSize = dbStats.dataSize;
        database.storageSize = dbStats.storageSize;
        database.indexSize = dbStats.indexSize;
        printHeader();
        db.getSiblingDB(dbName).getCollectionInfos({ "type": "collection" }, true).forEach((collDoc) => {
            collection = { "name": "", "dataSize": 0, "storageSize": 0, "objects": 0, "freeBlocks": 0, "compression": 0, "indexSize": 0, "indexFree": 0 };
            collStats = db.getSiblingDB(dbName).getCollection(collDoc.name).stats({ "indexDetails" : true });
            collection.name = collStats.ns.substr(collStats.ns.indexOf('.') + 1);
            collection.objects = collStats.count;
            collection.dataSize = collStats.size;
            collection.storageSize = collStats.wiredTiger['block-manager']['file size in bytes'];
            Object.keys(collStats['indexDetails']).forEach((indexName) => {
                collection.indexSize += collStats['indexDetails'][indexName]['block-manager']['file size in bytes'];
                collection.indexFree += collStats['indexDetails'][indexName]['block-manager']['file bytes available for reuse'];
            });
            collection.freeBlocks = collStats.wiredTiger['block-manager']['file bytes available for reuse'];
            collection.compression = collection.dataSize / (collection.storageSize - collection.freeBlocks);
            printCollection();
            database.freeBlocks += collection.freeBlocks;
            database.indexFree += collection.indexFree;
        });
        database.compression = database.dataSize / (database.storageSize - database.freeBlocks);
        printDb();
        dbPath.dataSize += database.dataSize;
        dbPath.storageSize += database.storageSize;
        dbPath.objects += database.objects;
        dbPath.indexSize += database.indexSize;
        dbPath.indexFree += database.indexFree;
        dbPath.freeBlocks += database.freeBlocks;
    });
    dbPath.compression = dbPath.dataSize / (dbPath.storageSize - dbPath.freeBlocks);
    printDbPath();
}

function fmtUnit(metric) {
    /*
     *  Pretty format unit
     */
    return (metric / scale.factor).toFixed(scale.precision) + ' ' + scale.unit;
}

function fmtPct(numerator, denominator) {
    /*
     *  Pretty format percentage
     */
    return (numerator / denominator * 100).toFixed(scale.pctPoint) + '%';
}

function fmtRatio(metric) {
    /*
     *  Pretty format ratio
     */
    return (metric).toFixed(scale.precision) + ':1';
}

function printHeader() {
    /*
     *  Print table header
     */
    print('='.repeat(termWidth));
    print('Database:', database.name);
    print('-'.repeat(termWidth));
    print('Collection'.padEnd(rowHeader), 'Data size'.padStart(columnWidth),
        'Size on disk'.padStart(columnWidth), 'Object count'.padStart(columnWidth),
        'Free blocks (reuse)'.padStart(columnWidth + 8), 'Compression'.padStart(columnWidth)
    );
}

function printCollection() {
    /*
     *  Print collection level stats
     */
    print('-'.repeat(termWidth));
    print((' ' + collection.name).padEnd(rowHeader),
        fmtUnit(collection.dataSize).padStart(columnWidth),
        fmtUnit(collection.storageSize).padStart(columnWidth),
        collection.objects.toString().padStart(columnWidth),
        (fmtUnit(collection.freeBlocks) +
            ('(' + fmtPct(collection.freeBlocks, collection.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
        fmtRatio(collection.compression).padStart(columnWidth)
    );
}

function printDb() {
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
    print('DB Index subtotals'.padEnd(rowHeader),
        fmtUnit(database.indexSize).padStart(columnWidth),
        fmtUnit(database.indexSize).padStart(columnWidth),
        ''.padStart(columnWidth),
        (fmtUnit(database.indexFree).padStart(columnWidth) +
            ('(' + fmtPct(database.indexFree, database.indexSize) + ')').padStart(8)).padStart(columnWidth + 8)
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
}

function printDbPath() {
    /*
     *  Print total rollup stats
     */
    print('\n' + '='.repeat(termWidth));
    print('Rollup stats'.padEnd(rowHeader), 'Data size'.padStart(columnWidth),
        'Size on disk'.padStart(columnWidth), 'Object count'.padStart(columnWidth),
        'Free blocks (reuse)'.padStart(columnWidth + 8), 'Compression'.padStart(columnWidth)
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
        fmtUnit(dbPath.indexSize).padStart(columnWidth),
        fmtUnit(dbPath.indexSize).padStart(columnWidth),
        ''.padStart(columnWidth),
        (fmtUnit(dbPath.indexFree) +
            ('(' + fmtPct(dbPath.indexFree, dbPath.indexSize) + ')').padStart(8)).padStart(columnWidth + 8)
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
}

slaveOk();
getStats();

// EOF
