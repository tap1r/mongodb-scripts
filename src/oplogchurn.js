/*
 *  oplogchurn.js
 *  Description: oplog churn rate script
 *  Created by: luke.prochazka@mongodb.com
 */

// Usage: "mongo [+connection options] --quiet oplogchurn.js"

/*
 *  Load helper lib (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save mdblib.js to local directory
 */

load('mdblib.js');

/*
 * Formatting preferences
 */

const scale = new ScaleFactor(); // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
let termWidth = 80;
let columnWidth = 35;
let rowHeader = 44;

// Global defaults

var total = 0;
var docs = 0;
let hrs = 1; // set interval
let d = new Date();
let t2 = d.getTime() / 1000;
let d2 = d.toISOString();
let t1 = d.setHours(d.getHours() - hrs) / 1000;
let d1 = d.toISOString();
let agg = [{
    $match: { ts: {
                $gte: Timestamp(t1, 1),
                $lte: Timestamp(t2, 1)
            }
        }
    },{
    $project: { _id: 0 }
}];

/*
 * main
 */

slaveOk();
db = db.getSiblingDB('local');
let oplog = db.oplog.rs.aggregate(agg);
oplog.forEach((op) => {
    total += Object.bsonsize(op);
    docs++;
});
//
let stats = db.oplog.rs.stats();
let freeBlocks = stats.wiredTiger['block-manager']['file bytes available for reuse'];
let ratio = (stats.size / (stats.storageSize - freeBlocks)).toFixed(2);
// Print results
print('='.repeat(termWidth));
print('Start time:'.padEnd(rowHeader), d1.padStart(columnWidth));
print('End time:'.padEnd(rowHeader), d2.padStart(columnWidth));
print('Interval:'.padEnd(rowHeader), (hrs + ' hr(s)').padStart(columnWidth));
print('Total oplog average compression ratio:'.padEnd(rowHeader),
 (ratio + ':1').padStart(columnWidth));
print('Doc count:'.padEnd(rowHeader), docs.toString().padStart(columnWidth));
print('Interval Ops combined object size:'.padEnd(rowHeader),
 ((total / scale.factor).toFixed(2) + ' ' + scale.unit).padStart(columnWidth));
print('Estimated interval Ops combined disk size:'.padEnd(rowHeader),
 ((total / (scale.factor * ratio)).toFixed(2) + ' ' + scale.unit).padStart(columnWidth));
print('-'.repeat(termWidth));
print('Estimated current oplog churn:'.padEnd(rowHeader),
 ((total / (scale.factor * ratio * hrs)).toFixed(2) + ' ' + scale.unit + '/hr').padStart(columnWidth));
print('='.repeat(termWidth));

// EOF
