/*
 *  Name: "oid-sampler.js"
 *  Version = "0.1.0"
 *  Description: OID sampler
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

// Usage: "mongo [connection options] --quiet oid-sampler.js"

/*
 *  Load helper lib (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save mdblib.js to the current working directory
 */

load('mdblib.js');

/*
 *  User defined parameters
 */

if (typeof hrs === 'undefined') {
    // set interval in hours
    var hrs = 1;
}

/*
 *  Global defaults
 */

let termWidth = 60, columnWidth = 25, rowHeader = 34; // formatting preferences

function main() {
    sampler();
}

function oplog() {
    /*
     *  oplog
     */
    var total = 0, docs = 0;
    let date = new Date();
    let t2 = (date.getTime() / 1000.0)|0; // end timestamp
    let d2 = date.toISOString(); // end datetime
    let t1 = (date.setHours(date.getHours() - hrs) / 1000.0)|0; // start timestamp
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
        },{
            "$group": {
                "_id": null,
                "bson_data_size": { "$sum": { "$bsonSize": "$$ROOT" } },
                "document_count": { "$sum": 1 }
            }
    }];
}

function sampler() {
    var firstOid = '';
    var lastOid = '';
    let dbName = 'database', collName = 'collection';
    let options = { "allowDiskUse": true };
    let agg1 = [{
            "$match": {}
        },{
            "$sort": { "_id": 1 }
        },{
            "$limit": 1
    }];
    let agg2 = [{
            "$match": {}
        },{
            "$sort": { "_id": -1 }
        },{
            "$limit": 1
    }];
    let agg3 = [{
        $collStats: { count: {} }
    }];
    slaveOk();
    db.getSiblingDB(dbName).getCollection(collName).aggregate(agg1, options).map(oid => {
        firstOid = oid._id;
    });
    var t1 = oidToTs(firstOid);
    print('1st OID', firstOid.valueOf(), t1);
    db.getSiblingDB(dbName).getCollection(collName).aggregate(agg2, options).map(oid => {
        lastOid = oid._id;
    });
    var t2 = oidToTs(lastOid);
    print('Lst OID', lastOid.valueOf(), t2);
    var count = 0;
    db.getSiblingDB(dbName).getCollection(collName).aggregate(agg3, options).map(res => {
        count = res.count;
    });
    print('Total OIDs in range:', count);
    let d1 = new Date(t1);
    let d2 = new Date(t2);
    let oad = new Date(1);
    oad.setFullYear(0000);
    print('d1', d1);
    print('d2', d2);
    print('0 AD', oad);
    var diff = new Date((d2.getTime() - d1.getTime()) + oad.getTime());
    print('diff', diff);
    print('Range:', diff.getUTCFullYear(), 'year(s),',
                    diff.getUTCMonth(), 'month(s),',
                    diff.getUTCDate(), 'day(s),',
                    diff.getUTCHours(), 'hour(s),',
                    diff.getUTCMinutes(), 'minute(s),',
                    diff.getUTCSeconds(), 'second(s)');
    // var interval = range/count;
    // print('Bucket size:', interval);
}

function bucket() {
    let dbName = 'local', collName = 'oplog.rs';
    let options = { "allowDiskUse": true };
    // let groups = idStamps;
    let boundaries = [60, 120, ...3600];
    let agg = [{
        "$bucket": {
            "groupBy": groups,
            "boundaries": boundaries,
            "default": "Other",
            "output": {
                "bson_data_size": { "$sum": { "$bsonSize": "$$ROOT" } },
                "document_count": { "$sum": 1 }
            }
        }
    }];
    slaveOk();
    print(db.getSiblingDB(dbName).getCollection(collName).aggregate(agg, options).pretty());
}

function tsToOid(ts) {
    /*
     *  convert timestamp to OID
     */
    return new ObjectId(Math.floor(ts - (dateOffset)).toString(16).padEnd(16, '0'));
}

function oidToTs(oid) {
    /*
     *  convert OID to timestamp
     */
    // return oid.valueOf().slice(0, 8);
    return oid.getTimestamp();
}

main();

// EOF
