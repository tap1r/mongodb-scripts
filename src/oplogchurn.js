// Oplog churn rate script
// - created by luke.prochazka@mongodb.com

// Usage: "mongo [+options] --quiet oplogchurn.js"

/*
 *  Load helper lib (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save mdblib.js to local directory
 */

load('mdblib.js')

/*
 * Formatting preferences
 */

const scale = new ScaleFactor(); // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'
const termWidth = 50;
const columnWidth = 14;
const rowHeader = 35;

// Global defaults
var total = 0;
var docs = 0;
//
const hrs = 1 // set interval
const d = new Date();
const t1 = d.getTime()/1000;
const t2 = d.setHours(d.getHours() - hrs)/1000;
const agg = [ { $match: { ts: { $gte: Timestamp(t2, 1), $lte: Timestamp(t1, 1) } } }, { $project: { _id: 0 } } ]

/*
 * main
 */

db = db.getSiblingDB('local');
const oplog = db.oplog.rs.aggregate(agg)
oplog.forEach(function (op) {
    var msg = Object.bsonsize(op);
    total += msg;
    docs++;
});
//
const stats = db.oplog.rs.stats();
const freeBlocks = stats.wiredTiger['block-manager']['file bytes available for reuse'];
const ratio = (stats.size / (stats.storageSize - freeBlocks)).toFixed(2);
// Print results
print('='.repeat(termWidth));
print("Start time:".padEnd(rowHeader), (t1).toString().padStart(columnWidth));
print("End time:".padEnd(rowHeader), (t2).toString().padStart(columnWidth));
print("Interval:".padEnd(rowHeader), (hrs + "hr(s)").padStart(columnWidth));
print("Avg oplog compression ratio:".padEnd(rowHeader), (ratio + ":1").padStart(columnWidth))
print("Doc count:".padEnd(rowHeader), docs.toString().padStart(columnWidth))
print("Total Ops size:".padEnd(rowHeader), ((total/scale.factor).toFixed(2) + ' ' + scale.unit).padStart(columnWidth))
print("Estimated total Ops size on disk:".padEnd(rowHeader), ((total/(scale.factor*ratio)).toFixed(2) + ' ' + scale.unit).padStart(columnWidth))
print('-'.repeat(termWidth));
print("Estimated current oplog churn:".padEnd(rowHeader), ((total/(scale.factor*ratio*hrs)).toFixed(2) + ' ' + scale.unit + "/hr").padStart(columnWidth))
print('='.repeat(termWidth));
// EOF