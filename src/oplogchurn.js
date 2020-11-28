/*
 *  Name: "oplogchurn.js"
 *  Version = "0.1.0"
 *  Description: oplog churn rate script
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongo [connection options] --quiet oplogchurn.js"

/*
 *  Load helper lib (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save mdblib.js to the current working directory
 */

load('mdblib.js');

/*
 *  User defined parameters
 */

if (hrs === undefined) {
    // set interval in hours
    var hrs = 1;
}

if (scale === undefined) {
    // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
    var scale = new ScaleFactor();
}

/*
 *  Global defaults
 */

let termWidth = 60, columnWidth = 25, rowHeader = 34; // formatting preferences

function main() {
    /*
     *  main
     */
    var total = 0, docs = 0;
    let date = new Date();
    let t2 = Math.floor(date.getTime() / 1000.0); // end timestamp
    let d2 = date.toISOString(); // end datetime
    let t1 = Math.floor(date.setHours(date.getHours() - hrs) / 1000.0); // start timestamp
    let d1 = date.toISOString(); // start datetime
    let agg = [{
        "$match": {
            "ts": {
                "$gte": Timestamp(t1, 1),
                "$lte": Timestamp(t2, 1)
            }
        }
    },{
        "$project": { "_id": 0 }
    }];

    // Measure interval stats
    slaveOk();
    let oplog = db.getSiblingDB('local').getCollection('oplog.rs');

    if (serverVer() >= 4.4) {
        // Use the v4.4 $bsonSize aggregation operator
        // print('Using the $bsonSize aggregation operator');
        agg.push({
            "$group": {
                "_id": null,
                "bson_data_size": { "$sum": { "$bsonSize": "$$ROOT" }},
                "document_count": { "$sum": 1 }
                }
        });
        oplog.aggregate(agg).map(churnInfo => {
            total = churnInfo.bson_data_size;
            docs = churnInfo.document_count;
        });
    } else {
        print('Warning: Using the legacy client side calculation technique');
        oplog.aggregate(agg).forEach((op) => {
            total += Object.bsonsize(op);
            ++docs;
        });
    }

    // Get oplog stats
    let stats = oplog.stats();
    let blocksFree = stats.wiredTiger['block-manager']['file bytes available for reuse'];
    let ratio = (stats.size / (stats.storageSize - blocksFree)).toFixed(2);

    // Print results
    print('\n');
    print('='.repeat(termWidth));
    print('Start time:'.padEnd(rowHeader), d1.padStart(columnWidth));
    print('End time:'.padEnd(rowHeader), d2.padStart(columnWidth));
    print('Interval duration:'.padEnd(rowHeader), (hrs + ' hr(s)').padStart(columnWidth));
    print('Average oplog compression ratio:'.padEnd(rowHeader),
          (ratio + ':1').padStart(columnWidth));
    print('Interval document count:'.padEnd(rowHeader),
          docs.toString().padStart(columnWidth));
    print('Interval data size:'.padEnd(rowHeader),
          ((total / scale.factor).toFixed(2) + ' ' + scale.unit).padStart(columnWidth));
    print('Estimated interval storage size:'.padEnd(rowHeader),
          ((total / (scale.factor * ratio)).toFixed(2) + ' ' + scale.unit).padStart(columnWidth));
    print('-'.repeat(termWidth));
    print('Estimated current oplog churn:'.padEnd(rowHeader),
          ((total / (scale.factor * ratio * hrs)).toFixed(2) + ' ' + scale.unit + '/hr').padStart(columnWidth));
    print('='.repeat(termWidth));
    print('\n');
}

main();

// EOF
