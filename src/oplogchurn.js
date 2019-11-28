// Oplog churn rate script
// - created by luke.prochazka@mongodb.com

// Usage: "mongo [+options] --quiet oplogchurn.js"

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
    // Scale formatting preferences
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