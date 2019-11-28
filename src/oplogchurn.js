// Oplog churn rate script
//
// Select scale
// const myScale = { name: "bytes", unit: "B", scale: Math.pow(1024, 0) };
const myScale = { name: "kilobytes", unit: "KB", scale: Math.pow(1024, 1) };
// const myScale = { name: "megabytes", unit: "MB", scale: Math.pow(1024, 2) };
// const myScale = { name: "gigabytes", unit: "GB", scale: Math.pow(1024, 3) };
// const myScale = { name: "terabytes", unit: "TB", scale: Math.pow(1024, 4) };
//
var total = 0;
var docs = 0;
//
const hrs = 1 // set interval
const d = new Date();
const t1 = d.getTime()/1000;
const t2 = d.setHours(d.getHours() - hrs)/1000;
const agg = [ { $match: { ts: { $gte: Timestamp(t2, 1), $lte: Timestamp(t1, 1) } } }, { $project: { _id: 0 } } ]
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
print("-------------------------------------------------------------------------------------------");
print("Start time:\t\t\t\t" + t1);
print("End time:\t\t\t\t" + t2);
print("Interval:\t\t\t\t" + hrs + " Hr(s)");
print("Avg oplog compression ratio:\t\t" + ratio + ":1")
print("Doc count:\t\t\t\t" + docs)
print("Total Ops size:\t\t\t\t" + (total/myScale.scale).toFixed(2) + myScale.unit)
print("Estimated total Ops size on disk:\t" + (total/(myScale.scale*ratio)).toFixed(2) + myScale.unit)
print("-------------------------------------------------------------------------------------------");
print("Estimated current oplog churn:\t\t" + (total/(myScale.scale*ratio*hrs)).toFixed(2) + " " + myScale.unit + "/Hr")
print("-------------------------------------------------------------------------------------------");
// EOF