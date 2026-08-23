/*
 *  Name: "oid-sampler.js"
 *  Version = "0.1.4"
 *  Description: OID sampler
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

/*
 *  Notes:
 *  - mongosh only
 */

// Usage: "mongosh [connection options] [--quiet] [-f|--file] </path/to/>oid-sampler.js"

/*
 *  Load helper mdblib.js (https://github.com/tap1r/mongodb-scripts/blob/master/src/mdblib.js)
 *  Save libs to the $MDBLIB or other valid search path
 */

(() => {
   const __script = { "name": "oid-sampler", "version": "0.1.4" };
   if (typeof __lib === 'undefined') {
      /*
       *  Load helper library mdblib.js
       */
      let __lib = { "name": "mdblib.js", "paths": null, "path": null };
      if (typeof _getEnv !== 'undefined') { // newer legacy shell _getEnv() method
         __lib.paths = [_getEnv('MDBLIB'), `${_getEnv('HOME')}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fileExists(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else if (typeof process !== 'undefined') { // mongosh process.env attribute
         __lib.paths = [process.env.MDBLIB, `${process.env.HOME}/.mongodb`, '.'];
         __lib.path = `${__lib.paths.find(path => fs.existsSync(`${path}/${__lib.name}`))}/${__lib.name}`;
      } else {
         print(`[WARN] Legacy shell methods detected, must load ${__lib.name} from the current working directory`);
         __lib.path = __lib.name;
      }
      load(__lib.path);
      // Fix: Namespace the library. Instead of global.$stats = ..., use global.mdblib = { $stats: ..., MetaStats: ... } and access via mdblib.$stats
   }
   let __comment = `#### Running script ${__script.name} v${__script.version}`;
   __comment += ` with ${__lib.name} v${__lib.version}`;
   __comment += ` on shell v${version()}`;
   // console.clear();
   console.log(`\n\n[yellow]${__comment}[/]`);
   if (shellVer(serverVer()) && !isMongosh()) console.log(`\n[red][WARN] Possibly incompatible legacy shell version detected: ${version()}[/]`);
   if (!shellVer(1.9) && isMongosh()) console.log(`\n[red][WARN] Possible incompatible non-GA shell version detected: ${version()}[/]`);
   if (!serverVer(4.2)) console.log(`\n[red][ERROR] Unsupported mongod/s version detected: ${db.version()}[/]`);
})();

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

var termWidth = 60, columnWidth = 25, rowHeader = 34; // formatting preferences

(() => {
   //
   function oplog() {
      /*
      *  oplog
      */
      const total = 0, docs = 0;
      const date = new Date();
      const t2 = (date.getTime() / 1000)|0; // end timestamp
      const d2 = date.toISOString(); // end datetime
      const t1 = (date.setHours(date.getHours() - hrs) / 1000)|0; // start timestamp
      const d1 = date.toISOString(); // start datetime
      const agg = [
         { "$match": {
            "ts": {
               "$gte": Timestamp(t1, 1),
               "$lte": Timestamp(t2, 1)
         } } },
         { "$project": { "_id": 0 } },
         { "$group": {
            "_id": null,
            "bson_data_size": { "$sum": { "$bsonSize": "$$ROOT" } },
            "document_count": { "$sum": 1 }
         } }
      ];
   }

   function sampler() {
      let firstOid = '';
      let lastOid = '';
      const dbName = 'database', collName = 'collection';
      const options = { "allowDiskUse": true };
      const agg1 = [{
            "$match": {}
         },{
            "$sort": { "_id": 1 }
         },{
            "$limit": 1
      }];
      const agg2 = [{
            "$match": {}
         },{
            "$sort": { "_id": -1 }
         },{
            "$limit": 1
      }];
      const agg3 = [{
         "$collStats": { "count": {} }
      }];
      slaveOk();
      db.getSiblingDB(dbName).getCollection(collName).aggregate(agg1, options).map(oid => {
         firstOid = oid._id;
      });
      let t1 = oidToTs(firstOid);
      console.log('1st OID', firstOid.valueOf(), t1);
      db.getSiblingDB(dbName).getCollection(collName).aggregate(agg2, options).map(oid => {
         lastOid = oid._id;
      });
      let t2 = oidToTs(lastOid);
      console.log('Lst OID', lastOid.valueOf(), t2);
      let count = 0;
      db.getSiblingDB(dbName).getCollection(collName).aggregate(agg3, options).map(res => {
         count = res.count;
      });
      console.log('Total OIDs in range:', count);
      let d1 = new Date(t1);
      let d2 = new Date(t2);
      let oad = new Date(1);
      oad.setFullYear('0000');
      console.log('d1', d1);
      console.log('d2', d2);
      console.log('0 AD', oad);
      let diff = new Date((d2.getTime() - d1.getTime()) + oad.getTime());
      console.log('diff', diff);
      console.log('Range:', diff.getUTCFullYear(), 'year(s),',
         diff.getUTCMonth(), 'month(s),',
         diff.getUTCDate(), 'day(s),',
         diff.getUTCHours(), 'hour(s),',
         diff.getUTCMinutes(), 'minute(s),',
         diff.getUTCSeconds(), 'second(s)'
      );
      // const interval = range/count;
      // console.log('Bucket size:', interval);
   }

   function bucket() {
      const dbName = 'local', collName = 'oplog.rs';
      const options = { "allowDiskUse": true };
      // const groups = idStamps;
      const boundaries = [60, 120, ...3600];
      const agg = [
         { "$bucket": {
            "groupBy": groups,
            "boundaries": boundaries,
            "default": "Other",
            "output": {
               "bson_data_size": { "$sum": { "$bsonSize": "$$ROOT" } },
               "document_count": { "$sum": 1 }
         } } }
      ];
      slaveOk();
      console.log(db.getSiblingDB(dbName).getCollection(collName).aggregate(agg, options).pretty());
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

   function main() {
      sampler();
   }

   main();
})();

// EOF
