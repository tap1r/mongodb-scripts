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
 *  Formatting preferences
 */

const scale = new ScaleFactor(); // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
let termWidth = 124, columnWidth = 15, rowHeader = 36;

/*
 *  main
 */

function getStats() {
    /*
     *  Gather DB stats (and print)
     */
    /* dbPath = { name: "", dataSize: 0, storageSize: 0, objects: 0, freeBlocks: 0,
            compression: function() { return this.dataSize / (this.storageSize - this.freeBlocks); },
            indexSize: 0, indexFree: 0
    }; */
    dbPath = new MetaStats();
    print(dbPath);
    db.getMongo().getDBNames().map(dbName => {
        dbStats = db.getSiblingDB(dbName).stats();
        database = new MetaStats();
        /* database = { name: dbStats.db, dataSize: 0, storageSize: 0, objects: 0, freeBlocks: 0,
                compression: function() { return this.dataSize / (this.storageSize - this.freeBlocks); },
                indexSize: 0, indexFree: 0
        }; */
        database.name = dbStats.db;
        database.objects = dbStats.objects;
        database.dataSize = dbStats.dataSize;
        database.storageSize = dbStats.storageSize;
        database.indexSize = dbStats.indexSize;
        printDbHeader(database.name);
        printCollHeader();
        db.getSiblingDB(dbName).getCollectionInfos({ type: "collection" }, true).map(collInfo => {
            collection = new MetaStats();
            /* collection = { name: collInfo.name, dataSize: 0, storageSize: 0, objects: 0, freeBlocks: 0,
                compression: function() { return this.dataSize / (this.storageSize - this.freeBlocks); },
                indexSize: 0, indexFree: 0
            }; */
            collStats = db.getSiblingDB(dbName).getCollection(collInfo.name).stats({ indexDetails: true });
            /* Object.keys(db.getSiblingDB(dbName).getCollection(collInfo.name).stats({ indexDetails: true })).map(collStats => {
                // collection.name = collStats.ns.substr(collStats.ns.indexOf('.') + 1);
                collection.name = collInfo.name;
                collection.objects = collStats.count;
                collection.dataSize = collStats.size;
                collection.storageSize = collStats.wiredTiger['block-manager']['file size in bytes'];
                Object.keys(collStats['indexDetails']).map(indexName => {
                    collection.indexSize += collStats['indexDetails'][indexName]['block-manager']['file size in bytes'];
                    collection.indexFree += collStats['indexDetails'][indexName]['block-manager']['file bytes available for reuse'];
                });
                collection.freeBlocks = collStats.wiredTiger['block-manager']['file bytes available for reuse'];
            }); */
            // collection.name = collStats.ns.substr(collStats.ns.indexOf('.') + 1);
            collection.name = collInfo.name;
            collection.objects = collStats.count;
            collection.dataSize = collStats.size;
            collection.storageSize = collStats.wiredTiger['block-manager']['file size in bytes'];
            Object.keys(collStats['indexDetails']).map(indexName => {
                collection.indexSize += collStats['indexDetails'][indexName]['block-manager']['file size in bytes'];
                collection.indexFree += collStats['indexDetails'][indexName]['block-manager']['file bytes available for reuse'];
            });
            collection.freeBlocks = collStats.wiredTiger['block-manager']['file bytes available for reuse'];
            printCollection(collection);
            database.freeBlocks += collection.freeBlocks;
            database.indexFree += collection.indexFree;
        });
        printViewHeader();
        db.getSiblingDB(dbName).getCollectionInfos({ type: "view" }, true).map(viewInfo => {
            printView(viewInfo.name);
        });
        printDb(database);
        dbPath.dataSize += database.dataSize;
        dbPath.storageSize += database.storageSize;
        dbPath.objects += database.objects;
        dbPath.indexSize += database.indexSize;
        dbPath.indexFree += database.indexFree;
        dbPath.freeBlocks += database.freeBlocks;
    });
    printDbPath(dbPath);
}

function formatUnit(metric) {
    /*
     *  Pretty format unit
     */
    return (metric / scale.factor).toFixed(scale.precision) + ' ' + scale.unit;
}

function formatPct(numerator, denominator) {
    /*
     *  Pretty format percentage
     */
    return (numerator / denominator * 100).toFixed(scale.pctPoint) + '%';
}

function formatRatio(metric) {
    /*
     *  Pretty format ratio
     */
    return (metric).toFixed(scale.precision) + ':1';
}

function printDbHeader(databaseName) {
    /*
     *  Print DB table header
     */
    print('\n');
    print('='.repeat(termWidth));
    print(('Database: ' + databaseName).padEnd(rowHeader), 'Data size'.padStart(columnWidth),
        'Size on disk'.padStart(columnWidth), 'Object count'.padStart(columnWidth),
        'Free blocks (reuse)'.padStart(columnWidth + 8), 'Compression'.padStart(columnWidth)
    );
}

function printCollHeader() {
    /*
     *  Print collection table header
     */
    print('-'.repeat(termWidth));
    print('Collection(s)');
}

function printViewHeader() {
    /*
     *  Print view table header
     */
    print('-'.repeat(termWidth));
    print('View(s)'.padEnd(rowHeader));
}

function printCollection(collection) {
    /*
     *  Print collection level stats
     */
    print('-'.repeat(termWidth));
    print((' ' + collection.name).padEnd(rowHeader),
        formatUnit(collection.dataSize).padStart(columnWidth),
        formatUnit(collection.storageSize).padStart(columnWidth),
        collection.objects.toString().padStart(columnWidth),
        (formatUnit(collection.freeBlocks) +
            ('(' + formatPct(collection.freeBlocks,
            collection.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
        formatRatio(collection.compression()).padStart(columnWidth)
    );
}

function printView(view) {
    /*
     *  Print view names
     */
    print('-'.repeat(termWidth));
    print((' ' + view).padEnd(rowHeader));
}

function printDb(database) {
    /*
     *  Print DB level rollup stats
     */
    print('-'.repeat(termWidth));
    print('Collections subtotal:'.padEnd(rowHeader),
        formatUnit(database.dataSize).padStart(columnWidth),
        formatUnit(database.storageSize).padStart(columnWidth),
        database.objects.toString().padStart(columnWidth),
        (formatUnit(database.freeBlocks).padStart(columnWidth) +
            ('(' + formatPct(database.freeBlocks,
            database.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
        formatRatio(database.compression()).padStart(columnWidth)
    );
    print('Indexes subtotal:'.padEnd(rowHeader),
    ''.padStart(columnWidth),
        formatUnit(database.indexSize).padStart(columnWidth),
        ''.padStart(columnWidth),
        (formatUnit(database.indexFree).padStart(columnWidth) +
            ('(' + formatPct(database.indexFree,
            database.indexSize) + ')').padStart(8)).padStart(columnWidth + 8)
    );
    print('='.repeat(termWidth));
}

function printDbPath(dbPath) {
    /*
     *  Print total dbPath rollup stats
     */
    print('\n'),
    print('='.repeat(termWidth));
    print('dbPath totals'.padEnd(rowHeader), 'Data size'.padStart(columnWidth),
        'Size on disk'.padStart(columnWidth), 'Object count'.padStart(columnWidth),
        'Free blocks (reuse)'.padStart(columnWidth + 8), 'Compression'.padStart(columnWidth)
    );
    print('-'.repeat(termWidth));
    print('All DBs:'.padEnd(rowHeader),
        formatUnit(dbPath.dataSize).padStart(columnWidth),
        formatUnit(dbPath.storageSize).padStart(columnWidth),
        dbPath.objects.toString().padStart(columnWidth),
        (formatUnit(dbPath.freeBlocks) +
            ('(' + formatPct(dbPath.freeBlocks,
            dbPath.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
        formatRatio(dbPath.compression()).padStart(columnWidth)
    );
    print('All indexes:'.padEnd(rowHeader),
        ''.padStart(columnWidth),
        formatUnit(dbPath.indexSize).padStart(columnWidth),
        ''.padStart(columnWidth),
        (formatUnit(dbPath.indexFree) +
            ('(' + formatPct(dbPath.indexFree,
            dbPath.indexSize) + ')').padStart(8)).padStart(columnWidth + 8)
    );
    print('='.repeat(termWidth));
}

slaveOk();
getStats();

// EOF
