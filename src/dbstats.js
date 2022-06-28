/*
 *  Name: "dbstats.js"
 *  Version: "0.2.14"
 *  Description: DB storage stats uber script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "[mongo|mongosh] [connection options] --quiet dbstats.js"

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

let __script = { "name": "dbstats.js", "version": "0.2.14" };
var __comment = '\n Running script ' + __script.name + ' v' + __script.version;
if (typeof __lib === 'undefined') {
    /*
     *  Load helper library mdblib.js
     */
    let __lib = { "name": "mdblib.js", "paths": null, "path": null };
    if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
        __lib.paths = [_getEnv('MDBLIB'), _getEnv('HOME') + '/.mongodb', '.'];
        __lib.path = __lib.paths.find(path => fileExists(path + '/' + __lib.name)) + '/' + __lib.name;
    } else if (typeof process !== 'undefined') { // mongosh process.env[] method
        __lib.paths = [process.env.MDBLIB, process.env.HOME + '/.mongodb', '.'];
        __lib.path = __lib.paths.find(path => fs.existsSync(path + '/' + __lib.name)) + '/' + __lib.name;
    } else {
        print('[WARN] Legacy shell methods detected, must load', __lib.name, 'from the current working directory');
        __lib.path = __lib.name;
    }

    load(__lib.path);
}

__comment += ' with ' + __lib.name + ' v' + __lib.version;
print(__comment);

/*
 *  User defined parameters
 */

if (typeof scale === 'undefined') {
    // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
    var scale = new ScaleFactor();
}

/*
 *  Global defaults
 */

// formatting preferences
if (typeof termWidth === 'undefined') var termWidth = 124;
if (typeof columnWidth === 'undefined') var columnWidth = 14;
if (typeof rowHeader === 'undefined') var rowHeader = 40;

// connection preferences
if (typeof readPref === 'undefined') var readPref = (hello().secondary === false) ? 'primaryPreferred': 'secondaryPreferred';

function main() {
    /*
     *  main
     */
    slaveOk(readPref);
    // db.getMongo().setReadPref(readPref);
    let stats = getStats();
    printDbPath(stats);
}

function getStats() {
    /*
     *  Gather DB stats (and print)
     */
    let dbPath = new MetaStats();
    dbPath.init();
    db.getMongo().getDBNames().map(dbName => {
        let dbStats = db.getSiblingDB(dbName).stats();
        let database = new MetaStats(dbStats.db, dbStats.dataSize, dbStats.storageSize, dbStats.objects, 0, '', dbStats.indexSize);
        database.init();
        let collections = db.getSiblingDB(dbName).getCollectionInfos({ "type": "collection" }, true);
        printDbHeader(database.name);
        printCollHeader(collections.length);
        collections.map(collInfo => {
            let collStats = db.getSiblingDB(dbName).getCollection(collInfo.name).stats({ "indexDetails": true });
            let collection = new MetaStats(collInfo.name, collStats.size, collStats.wiredTiger['block-manager']['file size in bytes'],
                                           collStats.count, collStats.wiredTiger['block-manager']['file bytes available for reuse'],
                                           collStats.wiredTiger.creationString.match(/block_compressor=(?<compressor>\w+)/).groups.compressor);
            collection.init();
            Object.keys(collStats.indexDetails).map(indexName => {
                collection.indexSize += collStats.indexDetails[indexName]['block-manager']['file size in bytes'];
                collection.indexFree += collStats.indexDetails[indexName]['block-manager']['file bytes available for reuse'];
            });
            printCollection(collection);
            database.blocksFree += collection.blocksFree;
            database.indexFree += collection.indexFree;
        });
        let views = db.getSiblingDB(dbName).getCollectionInfos({ "type": "view" }, true);
        printViewHeader(views.length);
        views.map(viewInfo => printView(viewInfo.name));
        printDb(database);
        dbPath.dataSize += database.dataSize;
        dbPath.storageSize += database.storageSize;
        dbPath.objects += database.objects;
        dbPath.indexSize += database.indexSize;
        dbPath.indexFree += database.indexFree;
        dbPath.blocksFree += database.blocksFree;
    });

    return dbPath;
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
    print(('Database: ' + databaseName).padEnd(rowHeader),
           'Data size'.padStart(columnWidth),
           'Compression'.padStart(columnWidth + 1),
           'Size on disk'.padStart(columnWidth),
           'Free blocks (reuse)'.padStart(columnWidth + 8),
           'Object count'.padStart(columnWidth)
    );
}

function printCollHeader(collTotal = 0) {
    /*
     *  Print collection table header
     */
    print('-'.repeat(termWidth));
    print(('Collection' + ((collTotal === 1) ? '' : 's') + ':\t' + collTotal).padEnd(rowHeader));
}

function printViewHeader(viewTotal = 0) {
    /*
     *  Print view table header
     */
    print('-'.repeat(termWidth));
    print(('View' + ((viewTotal === 1) ? '' : 's') + ':\t\t' + viewTotal).padEnd(rowHeader));
}

function printCollection(collection) {
    /*
     *  Print collection level stats
     */
    print('-'.repeat(termWidth));
    print((' ' + collection.name).padEnd(rowHeader),
          formatUnit(collection.dataSize).padStart(columnWidth),
          (formatRatio(collection.compression()) +
              (collection.compressor).padStart(7)).padStart(columnWidth + 1),
          formatUnit(collection.storageSize).padStart(columnWidth),
          (formatUnit(collection.blocksFree) +
              ('(' + formatPct(collection.blocksFree,
              collection.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          collection.objects.toString().padStart(columnWidth)
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
          formatRatio(database.compression()).padStart(columnWidth + 1),
          formatUnit(database.storageSize).padStart(columnWidth),
          (formatUnit(database.blocksFree).padStart(columnWidth) +
              ('(' + formatPct(database.blocksFree,
              database.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          database.objects.toString().padStart(columnWidth)
    );
    print('Indexes subtotal:'.padEnd(rowHeader),
          ''.padStart(columnWidth),
          ''.padStart(columnWidth + 1),
          formatUnit(database.indexSize).padStart(columnWidth),
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
    print('\n');
    print('='.repeat(termWidth));
    print('dbPath totals'.padEnd(rowHeader),
          'Data size'.padStart(columnWidth),
          'Compression'.padStart(columnWidth + 1),
          'Size on disk'.padStart(columnWidth),
          'Free blocks (reuse)'.padStart(columnWidth + 8),
          'Object count'.padStart(columnWidth)
    );
    print('-'.repeat(termWidth));
    print('All DBs:'.padEnd(rowHeader),
          formatUnit(dbPath.dataSize).padStart(columnWidth),
          formatRatio(dbPath.compression()).padStart(columnWidth + 1),
          formatUnit(dbPath.storageSize).padStart(columnWidth),
          (formatUnit(dbPath.blocksFree) +
              ('(' + formatPct(dbPath.blocksFree,
              dbPath.storageSize) + ')').padStart(8)).padStart(columnWidth + 8),
          dbPath.objects.toString().padStart(columnWidth)
    );
    print('All indexes:'.padEnd(rowHeader),
          ''.padStart(columnWidth),
          ''.padStart(columnWidth + 1),
          formatUnit(dbPath.indexSize).padStart(columnWidth),
          (formatUnit(dbPath.indexFree) +
              ('(' + formatPct(dbPath.indexFree,
          dbPath.indexSize) + ')').padStart(8)).padStart(columnWidth + 8)
    );
    print('='.repeat(termWidth));
    print('Host:', dbPath.hostname, '\tType:', dbPath.proc, '\tdbPath:', dbPath.dbPath);
    print('='.repeat(termWidth));
    print('\n');
}

main();

// EOF
