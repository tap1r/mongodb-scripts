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
 * Global defaults
 */

// user defined parameters
let hrs = 1; // set interval

// init vars
var total = 0, docs = 0;
let d = new Date();
let t2 = Math.floor(d.getTime() / 1000.0); // end timestamp
let d2 = d.toISOString(); // end datetime
let t1 = Math.floor(d.setHours(d.getHours() - hrs) / 1000.0); // start timestamp
let d1 = d.toISOString(); // start datetime
let agg = [{
      $match: { "ts": {
                $gte: Timestamp(t1, 1),
                $lte: Timestamp(t2, 1)
            }
         }
    },{
      $project: { "_id": 0 }
}];

// Formatting preferences
const scale = new ScaleFactor(); // 'B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'
let termWidth = 80, columnWidth = 35, rowHeader = 44;

/*
 * main
 */

// Measure interval stats
slaveOk();
let oplog = db.getSiblingDB('local').getCollection('oplog.rs');

if (serverVer() >= 4.4) {
      // Use the v4.4 $bsonSize aggregation operator
      // print('Using the $bsonSize aggregation operator');
      oplog.aggregate([{
                  $match: { "ts": {
                              $gte: Timestamp(t1, 1),
                              $lte: Timestamp(t2, 1)
                        }
                  }
            },{
                  $project: { "_id": 0 }
            },{
                  $group: {
                        "_id": null,
                        "combined_object_size": { $sum: { $bsonSize: "$$ROOT" } },
                        "total_documents": { $sum: 1 }
            }
      }]).map(churnInfo => {
            total = churnInfo.combined_object_size;
            docs = churnInfo.total_documents;
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
print('='.repeat(termWidth));
print('Start time:'.padEnd(rowHeader), d1.padStart(columnWidth));
print('End time:'.padEnd(rowHeader), d2.padStart(columnWidth));
print('Interval:'.padEnd(rowHeader), (hrs + ' hr(s)').padStart(columnWidth));
print('Total oplog average compression ratio:'.padEnd(rowHeader),
      (ratio + ':1').padStart(columnWidth));
print('Interval document count:'.padEnd(rowHeader),
      docs.toString().padStart(columnWidth));
print('Interval Ops combined object size:'.padEnd(rowHeader),
      ((total / scale.factor).toFixed(2) + ' ' + scale.unit).padStart(columnWidth));
print('Estimated interval Ops combined disk size:'.padEnd(rowHeader),
      ((total / (scale.factor * ratio)).toFixed(2) + ' ' + scale.unit).padStart(columnWidth));
print('-'.repeat(termWidth));
print('Estimated current oplog churn:'.padEnd(rowHeader),
      ((total / (scale.factor * ratio * hrs)).toFixed(2) + ' ' + scale.unit + '/hr').padStart(columnWidth));
print('='.repeat(termWidth));

// EOF
