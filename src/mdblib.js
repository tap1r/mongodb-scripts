/*
 *  Name: "mdblib.js"
 *  Version: "0.7.1"
 *  Description: mongo/mongosh shell helper library
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

if (typeof __lib === 'undefined') (
   __lib = {
      "name": "mdblib.js",
      "version": "0.7.1"
});

/*
 *  Global defaults
 */

if (typeof bsonMax === 'undefined') (bsonMax = (hello()) ? hello().maxBsonObjectSize : 16 * Math.pow(1024, 2));
if (typeof maxWriteBatchSize === 'undefined') (
   maxWriteBatchSize = (typeof hello().maxWriteBatchSize === 'undefined')
                     ? 100000
                     : hello().maxWriteBatchSize
);
if (typeof idiomas === 'undefined') (
   idiomas = ['none', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'hu', 'it', 'nb', 'pt', 'ro', 'ru', 'es', 'sv', 'tr']
);
if (typeof pid === 'undefined') {
   if (db.serverStatus().ok)
      (pid = +db.serverStatus().pid);
   else
      (pid = $getRandInt(0, 99999));
};
if (typeof nonce === 'undefined') {
   (nonce = (+((db.adminCommand({ "features": 1 }).oidMachine).toString() + pid.toString())).toString(16).substring(0, 10));
};

/*
 *  Helper functions, derived from:
 *  https://github.com/uxitten/polyfill/blob/master/string.polyfill.js
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padStart
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padEnd
 *  https://github.com/tc39/proposal-object-values-entries
 */

if (typeof String.prototype.padStart === 'undefined') {
   /*
    *  Add to legacy shell
    */
   String.prototype.padStart = (targetLength, padString) => {
      targetLength = targetLength >> 0; // truncate if number, or convert non-number to 0
      padString = String(typeof padString !== 'undefined' ? padString : ' ');
      if (this.length >= targetLength)
         return String(this)
      else {
         targetLength = targetLength - this.length;
         if (targetLength > padString.length)
            padString += padString.repeat(targetLength / padString.length) // append to original to ensure we are longer than needed

         return padString.slice(0, targetLength) + String(this);
      }
   }
}

if (typeof String.prototype.padEnd === 'undefined') {
   /*
    *  Add to legacy shell
    */
   String.prototype.padEnd = (targetLength, padString) => {
      targetLength = targetLength >> 0; // truncate if number, or convert non-number to 0
      padString = String(typeof padString !== 'undefined' ? padString : ' ');
      if (this.length > targetLength)
         return String(this)
      else {
         targetLength = targetLength - this.length;
         if (targetLength > padString.length)
            padString += padString.repeat(targetLength / padString.length) // append to original to ensure we are longer than needed

         return String(this) + padString.slice(0, targetLength);
      }
   }
}

if (typeof Object.prototype.entries === 'undefined') {
   /*
    *  Add to legacy shell
    */
   Object.entries = obj => {
      let ownProps = Object.keys(obj),
         i = ownProps.length,
         entries = new Array(i); // preallocate the Array
      while (i--)
         entries[i] = [ownProps[i], obj[ownProps[i]]];

      return entries;
   }
}

if (typeof console === 'undefined') {
   /*
    *  legacy mongo detected
    */
   (console = {});
   console.log = print;
   console.clear = () => _runMongoProgram('clear');
   console.error = tojson;
   console.dir = tojson;
}

/*
 *  Helper classes
 */

class ScaleFactor {
   /*
    *  Scale formatting preferences
    */
   constructor(unit = 'MB') {
      // default to MB
      switch (unit.toUpperCase()) {
         case 'B':
            this.factor = { "name": "bytes", "unit": "B", "symbol": "", "factor": Math.pow(1024, 0), "precision": 0, "pctPoint": 1 };
            break;
         case 'KB':
            this.factor = { "name": "kilobytes", "unit": "KB", "symbol": "k", "factor": Math.pow(1024, 1), "precision": 2, "pctPoint": 1 };
            break;
         case 'MB':
            this.factor = { "name": "megabytes", "unit": "MB", "symbol": "M", "factor": Math.pow(1024, 2), "precision": 2, "pctPoint": 1 };
            break;
         case 'GB':
            this.factor = { "name": "gigabytes", "unit": "GB", "symbol": "G", "factor": Math.pow(1024, 3), "precision": 2, "pctPoint": 1 };
            break;
         case 'TB':
            this.factor = { "name": "terabytes", "unit": "TB", "symbol": "T", "factor": Math.pow(1024, 4), "precision": 2, "pctPoint": 1 };
            break;
         case 'PB':
            this.factor = { "name": "petabytes", "unit": "PB", "symbol": "P", "factor": Math.pow(1024, 5), "precision": 2, "pctPoint": 1 };
            break;
         case 'EB':
            this.factor = { "name": "exabytes", "unit": "EB", "symbol": "E", "factor": Math.pow(1024, 6), "precision": 2, "pctPoint": 1 };
            break;
         case 'ZB':
            this.factor = { "name": "zettabytes", "unit": "ZB", "symbol": "Z", "factor": Math.pow(1024, 7), "precision": 2, "pctPoint": 1 };
            break;
         case 'YB':
            this.factor = { "name": "yottabytes", "unit": "YB", "symbol": "Y", "factor": Math.pow(1024, 8), "precision": 2, "pctPoint": 1 };
            break;
         default: this.factor = { "name": "megabytes", "unit": "MB", "symbol": "M", "factor": Math.pow(1024, 2), "precision": 2, "pctPoint": 1 };
      }
      return this.factor;
   }
}

// class AutoFactor { // unused
//    /*
//     *  Determine scale factor automatically
//     */
//    constructor(input = Math.pow(1024, 2)) {
//       if (typeof input === 'number' && input >= 0) {
//          this.scale = $floor(Math.log2(input) / 10);
//          this.metric = this.metrics[this.scale];
//          this.format = (input / this.metric.factor).toFixed(this.metric.precision) + this.metric.unit;
//       } else {
//          throw new Error(`Invalid scale factor parameter: ${input}`);
//       }
//       // return this.format
//    }
//    // format(number) {
//    //    return (number / this.metric.factor).toFixed(this.metric.precision) + this.metric.unit;
//    // }
//    get metrics() {
//       // array indexed by scale
//       return [
//          { "name":      "bytes", "unit":  "B", "symbol":  "", "factor": Math.pow(1024, 0), "precision": 0, "pctPoint": 2 },
//          { "name":  "kilobytes", "unit": "KB", "symbol": "k", "factor": Math.pow(1024, 1), "precision": 2, "pctPoint": 1 },
//          { "name":  "megabytes", "unit": "MB", "symbol": "M", "factor": Math.pow(1024, 2), "precision": 2, "pctPoint": 1 },
//          { "name":  "gigabytes", "unit": "GB", "symbol": "G", "factor": Math.pow(1024, 3), "precision": 2, "pctPoint": 1 },
//          { "name":  "terabytes", "unit": "TB", "symbol": "T", "factor": Math.pow(1024, 4), "precision": 2, "pctPoint": 1 },
//          { "name":  "petabytes", "unit": "PB", "symbol": "P", "factor": Math.pow(1024, 5), "precision": 2, "pctPoint": 1 },
//          { "name":   "exabytes", "unit": "EB", "symbol": "E", "factor": Math.pow(1024, 6), "precision": 2, "pctPoint": 1 },
//          { "name": "zettabytes", "unit": "ZB", "symbol": "Z", "factor": Math.pow(1024, 7), "precision": 2, "pctPoint": 1 },
//          { "name": "yottabytes", "unit": "YB", "symbol": "Y", "factor": Math.pow(1024, 8), "precision": 2, "pctPoint": 1 }
//       ];
//    }
// }

class MetaStats {
   /*
    *  Storage statistics metadata class
    */
   constructor({
         name = '', dataSize = 0, storageSize = 4096, freeStorageSize = 0,
         objects = 0, orphans = 0, compressor = 'none', indexes = [], nindexes = -1,
         indexSize = 4096, totalIndexSize = 4096, totalIndexBytesReusable = 0,
         collections = 0, ncollections = 0, internalPageSize = 4096
      } = {}) {
      /*
       *  https://www.mongodb.com/docs/mongodb-shell/write-scripts/limitations/
       */
      // this.instance = (async() => { return await hello().me })();
      // this.hostname = (async() => { return hostInfo().system.hostname })();
      // this.proc = (async() => { return db.serverStatus().process })();
      // this.dbPath = (async() => { return (db.serverStatus().process === 'mongod') ? serverCmdLineOpts().parsed.storage.dbPath : null })();
      // this.shards = (async() => { return (db.serverStatus().process === 'mongos') ? db.adminCommand({ "listShards": 1 }).shards : null })();
      this.name = name;
      this.dataSize = dataSize;
      this.storageSize = storageSize;
      this.freeStorageSize = freeStorageSize;
      this.objects = +objects;
      this.orphans = +orphans;
      this.compressor = compressor;
      this.collections = []; // usurp dbStats counter for collections list
      this.ncollections = (collections === 0) ? ncollections : +collections; // merge collStats and dbStats n/collections counters
      this.indexes = indexes; // usurp dbStats counter for indexes list
      this.nindexes = (nindexes === -1) ? +indexes: nindexes; // merge collStats and dbStats n/indexes counters
      this.totalIndexBytesReusable = totalIndexBytesReusable;
      this.totalIndexSize = (indexSize === 0) ? totalIndexSize : indexSize; // merge collStats and dbStats index size counters
      this.totalIndexBytesReusable = totalIndexBytesReusable;
      // this.overhead = (typeof internalPageSize === 'number') ? internalPageSize : 4096; // 4KB min allocation block size
      this.overhead = 1024; // unused
   }
   init() { // https://www.mongodb.com/docs/mongodb-shell/write-scripts/limitations/
      this.instance = hello().me;
      this.hostname = hostInfo().system.hostname;
      // this.hostname = 'unknown';
      // this.proc = (db.serverStatus().ok) ? db.serverStatus().process : 'unknown';
      // this.dbPath = (db.serverStatus().process == 'mongod') ? db.serverCmdLineOpts().parsed.storage.dbPath : 'sharded';
      // this.shards = (db.serverStatus().process == 'mongos') ? db.adminCommand({ "listShards": 1 }).shards : null;
      this.proc = (db.serverStatus().ok) ? db.serverStatus().process : 'unknown'; //  db.adminCommand({ "listShards": 1 })
      this.dbPath = (this.proc == 'mongod') ? serverCmdLineOpts().parsed.storage.dbPath
                  : (this.proc == 'mongos') ? 'sharded'
                  : 'unknown';
      this.shards = (this.proc == 'mongos') ? db.adminCommand({ "listShards": 1 }).shards : null;
   }
   get compression() {
      return this.dataSize / (this.storageSize - this.freeStorageSize - this.overhead);
   }
   get totalSize() { // unused
      return this.storageSize + (this.totalIndexSize + this.overhead) * this.nindexes;
   }
}

function $rand() {
   /*
    *  Choose your preferred PRNG
    */
   if (typeof process !== 'undefined') {
      /*
       *  mongosh/nodejs detected
       */
      return crypto.webcrypto.getRandomValues(new Uint32Array(1))[0] / Uint32MaxVal;
   } else {
      // default PRNG
      return Math.random();
   }
   // return _rand(); // the shell's prng
   // return Math.abs(_srand()) / (Math.pow(2, 63) - 1); // SecureRandom() method
   // return Math.random(); // node's prng
   /*
      Random.setRandomSeed();
      return Random.rand(); // SecureRandom() method
   */
   /*
      let pipeline = [
         { "$collStats": {} },
         { "$project": { "random": { "$rand": {} } } }
      ],
      options = {
         "cursor": { "batchSize": 1 },
         "readConcern": { "level": "local" },
         "comment": "$rand number generator"
      };
      return db.getSiblingDB('admin').getCollection('any').aggregate(pipeline, options).toArray()[0].random;
   */
}

function $ceil(num) {
   /*
    *  Choose your preferred ceiling operator
    */
   return Math.ceil(num);
}

function $floor(num) {
   /*
    *  Choose your preferred floor operator
    */
   return Math.floor(num);
}

function isReplSet() {
   /*
    *  Determine if current host is a replSet member
    */
   return typeof hello().hosts !== 'undefined';
}

function isSharded() {
   /*
    *  Determine if current host is a mongos
    */
   let proc = (db.serverStatus().ok) ? db.serverStatus().process
            : (db.adminCommand({ "listShards": 1 }).shards) ? 'mongos'
            : 'unknown';
   return proc == 'mongos';
}

function getDBNames(dbFilter = /^.+/) {
   /*
    *  getDBNames substitues for db.getDBNames()
    */
   let filterOptions = 'i';
   let filterRegex = new RegExp(dbFilter, filterOptions);
   return db.adminCommand({
      "listDatabases": 1,
      "filter": { "name": filterRegex },
      "nameOnly": true,
      "authorizedDatabases": true,
      // "comment": "list databases" // fCV(4.4)
   }).databases.map(({ name }) => name);
};

function getAllNonSystemNamespaces() { // TBA
   /*
    *  getAllNonSystemNamespaces
    */
   let listDbOpts = [{
      "listDatabases": 1,
      "filter": { "name": /(?:^(?!(admin|config|local)$).+)/ },
      "nameOnly": true,
      "authorizedDatabases": true
   }];
   // db.runCommand({ "listCollections": 1, "authorizedCollections": true, "nameOnly": true });
   let listColOpts = [{
         "type": /^(?:collection|timeseries)$/,
         "name": /(?:^(?!(system\..+|replset\..+)$).+)/
      },
      true,
      true
   ];
   let listViewOpts = [{
         "type": "view",
         "name": /(?:^(?!system\..+$).+)/
      },
      true,
      true
   ];
   // return dbs = db.adminCommand(...listDbOpts).databases.map(dbName => dbName.name);
   return null;
}

function getAllNonSystemCollections() { // TBA
   /*
    *  getAllNonSystemCollections
    */
   return null;
}

function getAllNonSystemViews() { // TBA
   /*
    *  getAllNonSystemViews()
    */
   return null;
}

function getAllSystemNamespaces() { // TBA
   /*
    *  getAllSystemNamespaces
    */
   return null;
}

/*
 *  Versioned helper commands
 */

function serverVer(ver) {
   /*
    *  Evaluate server version
    */
   let svrVer = () => +db.version().match(/^\d+\.\d+/);
   return (typeof ver !== 'undefined' && ver <= svrVer()) ? true
        : (typeof ver !== 'undefined' && ver > svrVer()) ? false
        : svrVer();
}

function fCV(ver) { // update for shared tier compatibility
   /*
    *  Evaluate feature compatibility version
    */
   let featureVer = ver => {
      return (db.serverStatus().process == 'mongod')
           ? +db.adminCommand({
               "getParameter": 1,
               "featureCompatibilityVersion": 1
             }).featureCompatibilityVersion.version
           : serverVer(ver);
   }
   return (typeof ver !== 'undefined' && ver <= featureVer()) ? true
        : (typeof ver !== 'undefined' && ver > featureVer()) ? false
        : featureVer();
}

function shellVer(ver) {
   /*
    *  Evaluate shell version
    */
   let shell = () => +version().match(/^\d+\.\d+/);
   return (typeof ver !== 'undefined' && ver <= shell()) ? true
        : (typeof ver !== 'undefined' && ver > shell()) ? false
        : shell();
}

function slaveOk(readPref = 'primaryPreferred') {
   /*
    *  Backward compatibility with rs.slaveOk() and MONGOSH-910
    */
   return (typeof rs.slaveOk === 'undefined' && typeof rs.secondaryOk !== 'undefined')
        ? db.getMongo().setReadPref(readPref) // else if (shellVer() >= 4.4)
        : (typeof rs.secondaryOk === 'function') ? rs.secondaryOk()
        : rs.slaveOk();
}

function isMaster() {
   /*
    *  Backward compatibility with db.isMaster()
    */
   return (typeof db.prototype.hello === 'undefined')
        ? db.isMaster()
        : db.hello();
}

function hello() {
   /*
    *  Forward compatibility with db.hello()
    */
   return (typeof db.prototype.hello !== 'function')
        ? db.isMaster()
        : db.hello();
}

function hostInfo() {
   /*
    *  Forward compatibility with db.hostInfo()
    */
   let hostInfo = {};
   try {
      hostInfo = db.hostInfo();
   } catch(error) {
      console.error(`\x1b[31m[WARN] insufficient rights to execute db.hostInfo()\n${error}\x1b[0m`);
      hostInfo.system.hostname = hello().me.match(/(.*):/)[1];
   }
   return hostInfo;
}

function serverCmdLineOpts() {
   /*
    *  Forward compatibility with db.serverCmdLineOpts()
    */
   let serverCmdLineOpts = {};
   try {
      serverCmdLineOpts = db.serverCmdLineOpts();
   } catch(error) {
      console.error(`\x1b[31m[WARN] insufficient rights to execute db.serverCmdLineOpts()\n${error}\x1b[0m`);
      serverCmdLineOpts.parsed.storage.dbPath = 'undefined';
   }
   return serverCmdLineOpts;
}

function isAtlasPlatform(type) {
   /*
    *  Evaluate Atlas deployment platform type
    */
   return (hello().msg === 'isdbgrid' && db.adminCommand({ "atlasVersion": 1 }).ok === 1) ? 'serverless'
        : (type === 'serverless' && hello().msg === 'isdbgrid' && db.adminCommand({ "atlasVersion": 1 }).ok === 1) ? true
        : (hello().msg !== 'isdbgrid' && db.adminCommand({ "atlasVersion": 1 }).ok === 1) ? 'sharedTier||dedicatedReplicaSet'
        : (hello().msg === 'isdbgrid' && typeof db.serverStatus().atlasVersion === 'undefined') ? 'dedicatedShardedCluster'
        : false;
}

if (typeof db.prototype.isMaster === 'undefined') {
   /*
    *  Backward compatibility with db.isMaster()
    */
   db.isMaster = () => this.hello();
}

if (typeof db.prototype.hello === 'undefined') {
   /*
    *  Forward compatibility with db.hello()
    */
   db.hello = () => this.isMaster();
}

if (typeof bsonsize === 'undefined') {
   /*
    *  Forward compatibility with bsonsize()
    */
   bsonsize = arg => Object.prototype.bsonsize(arg);
}

if (typeof process !== 'undefined') {
   /*
    *  mongosh wrappers
    */
   if (typeof Object.getPrototypeOf(UUID()).base64 === 'undefined') {
      /*
       *  Backward compatibility with UUID().base64()
       */
      UUID.prototype.base64 = () => this.toString('base64');
   }

   if (typeof hex_md5 === 'undefined') {
      /*
       *  Backward compatibility with hex_md5()
       */
      hex_md5 = arg => crypto.createHash('md5').update(arg).digest('hex');
   }
}

if (typeof tojson === 'undefined') {
   /*
    *  Compatibility with tojson()
    */
   tojson = arg => util.inspect(arg, { "depth": null, "colors": true });
}

/*
 *  Helper functions
 */

const K = 273.15;
const int32MinVal = -Math.pow(2, 31);
const int32MaxVal = Math.pow(2, 31) - 1;
const Uint32MaxVal = Math.pow(2, 32) - 1;
const int64MinVal = -Math.pow(2, 63);
const int64MaxVal = Math.pow(2, 63) - 1;
const dec128MinVal = -10 * Math.pow(2, 110);
const dec128MaxVal = 10 * Math.pow(2, 110) - 1;

function $NumberLong(arg) {
   /*
    *  NumberLong() wrapper
    */
   return (typeof process !== 'undefined')
        ? Long.fromNumber(arg)
        : NumberLong(arg);
}

function $NumberDecimal(arg) {
   /*
    *  NumberDecimal() wrapper
    */
   return (typeof process !== 'undefined')
        ? Decimal128.fromString(arg.toString())
        : NumberDecimal(arg);
}

function $NumberInt(arg) {
   /*
    *  NumberInt() wrapper
    */
   return (typeof process !== 'undefined')
        ? NumberInt(arg)
        : NumberInt(arg);
}

function $getRandRegex() {
   /*
    *  generate random regex
    */
   let regexes = [
      /[a-z0-9]/,
      /[a-z]/,
      /[A-Z]/,
      /[0-9]/,
      /[A-Z0-9]/,
      /[a-zA-Z0-9]/,
      /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?/,
      /[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}/
   ];

   return regexes[$getRandInt(0, regexes.length)];
}

function $getRandNum(min = 0, max = 1) {
   /*
    *  generate random number
    */
   return $rand() * (max - min) + min;
}

function $getRandExp(exponent = 0) {
   /*
    *  generate random exponential number
    */
   return $ceil($getRandNum(0, 9) * Math.pow(10, exponent));
}

function $getRandInt(min = 0, max = 1) {
   /*
    *  generate random integer
    */
   min = $ceil(min);
   max = $floor(max);

   return $floor($rand() * (max - min) + min);
}

function $getRandIntInc(min = 0, max = 1) {
   /*
    *  generate random integer inclusive of the maximum
    */
   min = $ceil(min);
   max = $floor(max);

   return $floor($rand() * (max - min + 1) + min);
}

function $getRandRatioInt(ratios = [1]) {
   /*
    *  generate ratioed random integer
    */
   let weightedIndex = [];
   ratios.forEach((ratio, idx) => {
      for (let i = 0; i < ratio; ++i) {
         weightedIndex.push(idx);
      }
   });

   return weightedIndex[$floor($rand() * weightedIndex.length)];
}

function $genRandHex(len = 1) {
   /*
    *  generate random hexadecimal string
    */
   let res = '';
   for (let i = 0; i < len; ++i) {
      res += ($floor($rand() * 16)).toString(16);
   }

   return res;
}

function $genRandStr(len = 1) {
   /*
    *  generate random alpha-numeric string
    */
   let res = '';
   let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
   for (let i = 0; i < len; ++i) {
      res += chars.charAt($floor($rand() * chars.length));
   }

   return res;
}

function $genRandWord() { // TBA
   /*
    *  generate random word from a dictionary
    */
   let dict = '/usr/share/dict/words';  // /path/to/dictionary
   let word = '';

   return word;
}

function $genRandAlpha(len = 1) {
   /*
    *  generate random alpha-character string
    */
   let res = '';
   let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
   for (let i = 0; i < len; ++i) {
      res += chars.charAt($getRandInt(0, chars.length));
   }

   return res;
}

function $genRandSymbol() {
   /*
    *  generate random symbol
    */
   let symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

   return symbol.charAt($floor($rand() * symbol.length));
}

function $genRandCurrency() {
   /*
    *  generate random curreny symbol
    */
   let currencies = ['$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱zł', '₲', '฿', '₴', '₫'];

   return currencies[$getRandInt(0, currencies.length)];
}

function $genArrayElements(len) {
   /*
    *  generate array of random strings
    */
   let array = [];
   for (let i = 0; i < len; ++i) {
      array.push($genRandStr($getRandIntInc(6, 24)));
   }

   return array;
}

function $genArrayStrings(len) {
   /*
    *  generate array of random strings
    */
   let array = [];
   for (let i = 0; i < len; ++i) {
      array.push($genRandStr($getRandIntInc(6, 24)));
   }

   return array;
}

function $genArrayInts(len) {
   /*
    *  generate array of random integers
    */
   let array = [];
   for (let i = 0; i < len; ++i) {
      array.push($getRandIntInc(1, 1000));
   }

   return array;
}

function $genRandIncPareto(min, alpha = 1.161) {
   /*
    *  min is the lowest possible value that can be returned
    *  alpha controls the "shape" of the distribution
    */
   let u = 1.0 - $rand();

   return min / Math.pow(u, (1.0 / alpha));
}

function $genRandIntIncPareto(min, max, alpha = 1.161) {
   /*
    *  min is the lowest possible value that can be returned
    *  alpha controls the "shape" of the distribution
    */
   let k = max * (1.0 - $rand()) + min;
   let v = Math.pow(k, alpha);

   return v + min;
}

function $genNormal(mu, sigma) {
   /*
    *  mu = mean
    *  sigma = standard deviation
    */
   let x = Math.sqrt(-2.0 * Math.log($rand())) * Math.cos(Math.PI * 2 * $rand());

   return x * sigma + mu;
}

function $genExponential(lambda = 1) {
   /*
    *  exponential distribution function
    */
   return -Math.log(1.0 - $rand()) / lambda;
}

function $genLuhnNumber(input) {
   /*
    *  generate number with Luhn check digit
    */

   // Step 1: Remove the last digit from the input
   // let inputWithoutLastDigit = input.toString().slice(0, -1);

   // Step 2: Double every second digit, starting from the right
   // let digits = inputWithoutLastDigit.split('').map(Number);
   let digits = input.split('').map(Number),
      sum = 0,
      shouldDouble = false;

   for (let i = digits.length - 1; i >= 0; i--) {
      let digit = digits[i];
      if (shouldDouble) {
         digit *= 2;
         if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
   }

   // Step 3: Calculate the check digit
   let checkDigit = (10 - (sum % 10)) % 10;

   // Step 4: Return the input with the check digit appended
   // return inputWithoutLastDigit + checkDigit;
   return input + checkDigit;
}

function $genIin({ iin }) {
   /*
    *  basic fake IIN generator
    */

   let countryCode = $getRandCountry()['numeric code'];
   return ((iin[$getRandIntInc(0, (iin.length - 1))]).toString() + countryCode.replace(/^0+/, '') + $getRandInt(0, Math.pow(10, 6))).toString().padEnd(8, '0').substring(0, 8);
}

function $genPan() {
   /*
    *  basic fake PAN generator
    */

   return ($getRandInt(0, Math.pow(10, 7))).toString().padStart(7, '0').substring(0, 7);
}

function $genRandCardNumber(type = 'rnd', card = '') {
   /*
    *  basic fake card generator
    */

   let cards = [
      { "type": "amex", "iin": [34, 37], "digits": 15, "weight": 10 },
      { "type": "discover", "iin": [6011, ...$range(644, 649, 1), 65], "digits": 16, "weight": 5 },
      { "type": "mastercard", "iin": [...$range(51, 55, 1), ...$range(2221, 2720, 1)], "digits": 16, "weight": 25 },
      { "type": "visa", "iin": [4], "digits": 16, "weight": 50 }
   ];

   if (type == 'rnd') {
      type = ['amex', 'discover', 'mastercard', 'visa'][
         $getRandRatioInt([10, 5, 25, 50])
      ];
   }
   card = cards.find(card => card.type == type);
   // Card format = BIN prefix (IIN + country code padded to 8) + PAN (pad to card length -1) + luhn check digit

   let iin = $genIin(card);
   let pan = $genPan();
   return $genLuhnNumber(iin + pan);
}

function $range(start, stop, step) {
   /*
    *  return array of inclusive number range
    */
   return Array.from(
      { "length": (stop - start) / step + 1 },
      (_, idx) => start + idx * step
   );
};

function $getRandCountry() {
   /*
    *  return country code
    */

   let codes = [
      { "name": "Afghanistan", "alpha-2 code": "AF", "alpha-3 code": "AFG", "numeric code": "004" },
      { "name": "Albania", "alpha-2 code": "AL", "alpha-3 code": "ALB", "numeric code": "008" },
      { "name": "Antarctica", "alpha-2 code": "AQ", "alpha-3 code": "ATA", "numeric code": "010" },
      { "name": "Algeria", "alpha-2 code": "DZ", "alpha-3 code": "DZA", "numeric code": "012" },
      { "name": "American Samoa", "alpha-2 code": "AS", "alpha-3 code": "ASM", "numeric code": "016" },
      { "name": "Andorra", "alpha-2 code": "AD", "alpha-3 code": "AND", "numeric code": "020" },
      { "name": "Angola", "alpha-2 code": "AO", "alpha-3 code": "AGO", "numeric code": "024" },
      { "name": "Antigua and Barbuda", "alpha-2 code": "AG", "alpha-3 code": "ATG", "numeric code": "028" },
      { "name": "Azerbaijan", "alpha-2 code": "AZ", "alpha-3 code": "AZE", "numeric code": "031" },
      { "name": "Argentina", "alpha-2 code": "AR", "alpha-3 code": "ARG", "numeric code": "032" },
      { "name": "Australia", "alpha-2 code": "AU", "alpha-3 code": "AUS", "numeric code": "036" },
      { "name": "Austria", "alpha-2 code": "AT", "alpha-3 code": "AUT", "numeric code": "040" },
      { "name": "Bahamas", "alpha-2 code": "BS", "alpha-3 code": "BHS", "numeric code": "044" },
      { "name": "Bahrain", "alpha-2 code": "BH", "alpha-3 code": "BHR", "numeric code": "048" },
      { "name": "Bangladesh", "alpha-2 code": "BD", "alpha-3 code": "BGD", "numeric code": "050" },
      { "name": "Armenia", "alpha-2 code": "AM", "alpha-3 code": "ARM", "numeric code": "051" },
      { "name": "Barbados", "alpha-2 code": "BB", "alpha-3 code": "BRB", "numeric code": "052" },
      { "name": "Belgium", "alpha-2 code": "BE", "alpha-3 code": "BEL", "numeric code": "056" },
      { "name": "Bermuda", "alpha-2 code": "BM", "alpha-3 code": "BMU", "numeric code": "060" },
      { "name": "Bhutan", "alpha-2 code": "BT", "alpha-3 code": "BTN", "numeric code": "064" },
      { "name": "Bolivia", "alpha-2 code": "BO", "alpha-3 code": "BOL", "numeric code": "068" },
      { "name": "Bosnia and Herzegovina", "alpha-2 code": "BA", "alpha-3 code": "BIH", "numeric code": "070" },
      { "name": "Botswana", "alpha-2 code": "BW", "alpha-3 code": "BWA", "numeric code": "072" },
      { "name": "Bouvet Island", "alpha-2 code": "BV", "alpha-3 code": "BVT", "numeric code": "074" },
      { "name": "Brazil", "alpha-2 code": "BR", "alpha-3 code": "BRA", "numeric code": "076" },
      { "name": "Belize", "alpha-2 code": "BZ", "alpha-3 code": "BLZ", "numeric code": "084" },
      { "name": "British Indian Ocean Territory", "alpha-2 code": "IO", "alpha-3 code": "IOT", "numeric code": "086" },
      { "name": "Solomon Islands", "alpha-2 code": "SB", "alpha-3 code": "SLB", "numeric code": "090" },
      { "name": "Virgin Islands (British)", "alpha-2 code": "VG", "alpha-3 code": "VGB", "numeric code": "092" },
      { "name": "Brunei Darussalam", "alpha-2 code": "BN", "alpha-3 code": "BRN", "numeric code": "096" },
      { "name": "Bulgaria", "alpha-2 code": "BG", "alpha-3 code": "BGR", "numeric code": "100" },
      { "name": "Myanmar", "alpha-2 code": "MM", "alpha-3 code": "MMR", "numeric code": "104" },
      { "name": "Burundi", "alpha-2 code": "BI", "alpha-3 code": "BDI", "numeric code": "108" },
      { "name": "Belarus", "alpha-2 code": "BY", "alpha-3 code": "BLR", "numeric code": "112" },
      { "name": "Cambodia", "alpha-2 code": "KH", "alpha-3 code": "KHM", "numeric code": "116" },
      { "name": "Cameroon", "alpha-2 code": "CM", "alpha-3 code": "CMR", "numeric code": "120" },
      { "name": "Canada", "alpha-2 code": "CA", "alpha-3 code": "CAN", "numeric code": "124" },
      { "name": "Cabo Verde", "alpha-2 code": "CV", "alpha-3 code": "CPV", "numeric code": "132" },
      { "name": "Cayman Islands", "alpha-2 code": "KY", "alpha-3 code": "CYM", "numeric code": "136" },
      { "name": "Central African Republic", "alpha-2 code": "CF", "alpha-3 code": "CAF", "numeric code": "140" },
      { "name": "Sri Lanka", "alpha-2 code": "LK", "alpha-3 code": "LKA", "numeric code": "144" },
      { "name": "Chad", "alpha-2 code": "TD", "alpha-3 code": "TCD", "numeric code": "148" },
      { "name": "Chile", "alpha-2 code": "CL", "alpha-3 code": "CHL", "numeric code": "152" },
      { "name": "China", "alpha-2 code": "CN", "alpha-3 code": "CHN", "numeric code": "156" },
      { "name": "Taiwan", "alpha-2 code": "TW", "alpha-3 code": "TWN", "numeric code": "158" },
      { "name": "Christmas Island", "alpha-2 code": "CX", "alpha-3 code": "CXR", "numeric code": "162" },
      { "name": "Cocos (Keeling) Islands", "alpha-2 code": "CC", "alpha-3 code": "CCK", "numeric code": "166" },
      { "name": "Colombia", "alpha-2 code": "CO", "alpha-3 code": "COL", "numeric code": "170" },
      { "name": "Comoros", "alpha-2 code": "KM", "alpha-3 code": "COM", "numeric code": "174" },
      { "name": "Mayotte", "alpha-2 code": "YT", "alpha-3 code": "MYT", "numeric code": "175" },
      { "name": "Congo", "alpha-2 code": "CG", "alpha-3 code": "COG", "numeric code": "178" },
      { "name": "Congo, Democratic Republic of the", "alpha-2 code": "CD", "alpha-3 code": "COD", "numeric code": "180" },
      { "name": "Cook Islands", "alpha-2 code": "CK", "alpha-3 code": "COK", "numeric code": "184" },
      { "name": "Costa Rica", "alpha-2 code": "CR", "alpha-3 code": "CRI", "numeric code": "188" },
      { "name": "Croatia", "alpha-2 code": "HR", "alpha-3 code": "HRV", "numeric code": "191" },
      { "name": "Cuba", "alpha-2 code": "CU", "alpha-3 code": "CUB", "numeric code": "192" },
      { "name": "Cyprus[b]", "alpha-2 code": "CY", "alpha-3 code": "CYP", "numeric code": "196" },
      { "name": "Czechia", "alpha-2 code": "CZ", "alpha-3 code": "CZE", "numeric code": "203" },
      { "name": "Benin", "alpha-2 code": "BJ", "alpha-3 code": "BEN", "numeric code": "204" },
      { "name": "Denmark", "alpha-2 code": "DK", "alpha-3 code": "DNK", "numeric code": "208" },
      { "name": "Dominica", "alpha-2 code": "DM", "alpha-3 code": "DMA", "numeric code": "212" },
      { "name": "Dominican Republic", "alpha-2 code": "DO", "alpha-3 code": "DOM", "numeric code": "214" },
      { "name": "Ecuador", "alpha-2 code": "EC", "alpha-3 code": "ECU", "numeric code": "218" },
      { "name": "El Salvador", "alpha-2 code": "SV", "alpha-3 code": "SLV", "numeric code": "222" },
      { "name": "Equatorial Guinea", "alpha-2 code": "GQ", "alpha-3 code": "GNQ", "numeric code": "226" },
      { "name": "Ethiopia", "alpha-2 code": "ET", "alpha-3 code": "ETH", "numeric code": "231" },
      { "name": "Eritrea", "alpha-2 code": "ER", "alpha-3 code": "ERI", "numeric code": "232" },
      { "name": "Estonia", "alpha-2 code": "EE", "alpha-3 code": "EST", "numeric code": "233" },
      { "name": "Faroe Islands", "alpha-2 code": "FO", "alpha-3 code": "FRO", "numeric code": "234" },
      { "name": "Falkland Islands", "alpha-2 code": "FK", "alpha-3 code": "FLK", "numeric code": "238" },
      { "name": "South Georgia and the South Sandwich Islands", "alpha-2 code": "GS", "alpha-3 code": "SGS", "numeric code": "239" },
      { "name": "Fiji", "alpha-2 code": "FJ", "alpha-3 code": "FJI", "numeric code": "242" },
      { "name": "Finland", "alpha-2 code": "FI", "alpha-3 code": "FIN", "numeric code": "246" },
      { "name": "Åland Islands", "alpha-2 code": "AX", "alpha-3 code": "ALA", "numeric code": "248" },
      { "name": "France", "alpha-2 code": "FR", "alpha-3 code": "FRA", "numeric code": "250" },
      { "name": "French Guiana", "alpha-2 code": "GF", "alpha-3 code": "GUF", "numeric code": "254" },
      { "name": "French Polynesia", "alpha-2 code": "PF", "alpha-3 code": "PYF", "numeric code": "258" },
      { "name": "French Southern Territories", "alpha-2 code": "TF", "alpha-3 code": "ATF", "numeric code": "260" },
      { "name": "Djibouti", "alpha-2 code": "DJ", "alpha-3 code": "DJI", "numeric code": "262" },
      { "name": "Gabon", "alpha-2 code": "GA", "alpha-3 code": "GAB", "numeric code": "266" },
      { "name": "Georgia", "alpha-2 code": "GE", "alpha-3 code": "GEO", "numeric code": "268" },
      { "name": "Gambia", "alpha-2 code": "GM", "alpha-3 code": "GMB", "numeric code": "270" },
      { "name": "Palestine", "alpha-2 code": "PS", "alpha-3 code": "PSE", "numeric code": "275" },
      { "name": "Germany", "alpha-2 code": "DE", "alpha-3 code": "DEU", "numeric code": "276" },
      { "name": "Ghana", "alpha-2 code": "GH", "alpha-3 code": "GHA", "numeric code": "288" },
      { "name": "Gibraltar", "alpha-2 code": "GI", "alpha-3 code": "GIB", "numeric code": "292" },
      { "name": "Kiribati", "alpha-2 code": "KI", "alpha-3 code": "KIR", "numeric code": "296" },
      { "name": "Greece", "alpha-2 code": "GR", "alpha-3 code": "GRC", "numeric code": "300" },
      { "name": "Greenland", "alpha-2 code": "GL", "alpha-3 code": "GRL", "numeric code": "304" },
      { "name": "Grenada", "alpha-2 code": "GD", "alpha-3 code": "GRD", "numeric code": "308" },
      { "name": "Guadeloupe", "alpha-2 code": "GP", "alpha-3 code": "GLP", "numeric code": "312" },
      { "name": "Guam", "alpha-2 code": "GU", "alpha-3 code": "GUM", "numeric code": "316" },
      { "name": "Guatemala", "alpha-2 code": "GT", "alpha-3 code": "GTM", "numeric code": "320" },
      { "name": "Guinea", "alpha-2 code": "GN", "alpha-3 code": "GIN", "numeric code": "324" },
      { "name": "Guyana", "alpha-2 code": "GY", "alpha-3 code": "GUY", "numeric code": "328" },
      { "name": "Haiti", "alpha-2 code": "HT", "alpha-3 code": "HTI", "numeric code": "332" },
      { "name": "Heard Island and McDonald Islands", "alpha-2 code": "HM", "alpha-3 code": "HMD", "numeric code": "334" },
      { "name": "Holy See", "alpha-2 code": "VA", "alpha-3 code": "VAT", "numeric code": "336" },
      { "name": "Honduras", "alpha-2 code": "HN", "alpha-3 code": "HND", "numeric code": "340" },
      { "name": "Hong Kong", "alpha-2 code": "HK", "alpha-3 code": "HKG", "numeric code": "344" },
      { "name": "Hungary", "alpha-2 code": "HU", "alpha-3 code": "HUN", "numeric code": "348" },
      { "name": "Iceland", "alpha-2 code": "IS", "alpha-3 code": "ISL", "numeric code": "352" },
      { "name": "India", "alpha-2 code": "IN", "alpha-3 code": "IND", "numeric code": "356" },
      { "name": "Indonesia", "alpha-2 code": "ID", "alpha-3 code": "IDN", "numeric code": "360" },
      { "name": "Iran", "alpha-2 code": "IR", "alpha-3 code": "IRN", "numeric code": "364" },
      { "name": "Iraq", "alpha-2 code": "IQ", "alpha-3 code": "IRQ", "numeric code": "368" },
      { "name": "Ireland", "alpha-2 code": "IE", "alpha-3 code": "IRL", "numeric code": "372" },
      { "name": "Israel", "alpha-2 code": "IL", "alpha-3 code": "ISR", "numeric code": "376" },
      { "name": "Italy", "alpha-2 code": "IT", "alpha-3 code": "ITA", "numeric code": "380" },
      { "name": "Côte d'Ivoire", "alpha-2 code": "CI", "alpha-3 code": "CIV", "numeric code": "384" },
      { "name": "Jamaica", "alpha-2 code": "JM", "alpha-3 code": "JAM", "numeric code": "388" },
      { "name": "Japan", "alpha-2 code": "JP", "alpha-3 code": "JPN", "numeric code": "392" },
      { "name": "Kazakhstan", "alpha-2 code": "KZ", "alpha-3 code": "KAZ", "numeric code": "398" },
      { "name": "Jordan", "alpha-2 code": "JO", "alpha-3 code": "JOR", "numeric code": "400" },
      { "name": "Kenya", "alpha-2 code": "KE", "alpha-3 code": "KEN", "numeric code": "404" },
      { "name": "North Korea", "alpha-2 code": "KP", "alpha-3 code": "PRK", "numeric code": "408" },
      { "name": "South Korea", "alpha-2 code": "KR", "alpha-3 code": "KOR", "numeric code": "410" },
      { "name": "Kuwait", "alpha-2 code": "KW", "alpha-3 code": "KWT", "numeric code": "414" },
      { "name": "Kyrgyzstan", "alpha-2 code": "KG", "alpha-3 code": "KGZ", "numeric code": "417" },
      { "name": "Lao People's Democratic Republic", "alpha-2 code": "LA", "alpha-3 code": "LAO", "numeric code": "418" },
      { "name": "Lebanon", "alpha-2 code": "LB", "alpha-3 code": "LBN", "numeric code": "422" },
      { "name": "Lesotho", "alpha-2 code": "LS", "alpha-3 code": "LSO", "numeric code": "426" },
      { "name": "Latvia", "alpha-2 code": "LV", "alpha-3 code": "LVA", "numeric code": "428" },
      { "name": "Liberia", "alpha-2 code": "LR", "alpha-3 code": "LBR", "numeric code": "430" },
      { "name": "Libya", "alpha-2 code": "LY", "alpha-3 code": "LBY", "numeric code": "434" },
      { "name": "Liechtenstein", "alpha-2 code": "LI", "alpha-3 code": "LIE", "numeric code": "438" },
      { "name": "Lithuania", "alpha-2 code": "LT", "alpha-3 code": "LTU", "numeric code": "440" },
      { "name": "Luxembourg", "alpha-2 code": "LU", "alpha-3 code": "LUX", "numeric code": "442" },
      { "name": "Macao", "alpha-2 code": "MO", "alpha-3 code": "MAC", "numeric code": "446" },
      { "name": "Madagascar", "alpha-2 code": "MG", "alpha-3 code": "MDG", "numeric code": "450" },
      { "name": "Malawi", "alpha-2 code": "MW", "alpha-3 code": "MWI", "numeric code": "454" },
      { "name": "Malaysia", "alpha-2 code": "MY", "alpha-3 code": "MYS", "numeric code": "458" },
      { "name": "Maldives", "alpha-2 code": "MV", "alpha-3 code": "MDV", "numeric code": "462" },
      { "name": "Mali", "alpha-2 code": "ML", "alpha-3 code": "MLI", "numeric code": "466" },
      { "name": "Malta", "alpha-2 code": "MT", "alpha-3 code": "MLT", "numeric code": "470" },
      { "name": "Martinique", "alpha-2 code": "MQ", "alpha-3 code": "MTQ", "numeric code": "474" },
      { "name": "Mauritania", "alpha-2 code": "MR", "alpha-3 code": "MRT", "numeric code": "478" },
      { "name": "Mauritius", "alpha-2 code": "MU", "alpha-3 code": "MUS", "numeric code": "480" },
      { "name": "Mexico", "alpha-2 code": "MX", "alpha-3 code": "MEX", "numeric code": "484" },
      { "name": "Monaco", "alpha-2 code": "MC", "alpha-3 code": "MCO", "numeric code": "492" },
      { "name": "Mongolia", "alpha-2 code": "MN", "alpha-3 code": "MNG", "numeric code": "496" },
      { "name": "Moldova", "alpha-2 code": "MD", "alpha-3 code": "MDA", "numeric code": "498" },
      { "name": "Montenegro", "alpha-2 code": "ME", "alpha-3 code": "MNE", "numeric code": "499" },
      { "name": "Montserrat", "alpha-2 code": "MS", "alpha-3 code": "MSR", "numeric code": "500" },
      { "name": "Morocco", "alpha-2 code": "MA", "alpha-3 code": "MAR", "numeric code": "504" },
      { "name": "Mozambique", "alpha-2 code": "MZ", "alpha-3 code": "MOZ", "numeric code": "508" },
      { "name": "Oman", "alpha-2 code": "OM", "alpha-3 code": "OMN", "numeric code": "512" },
      { "name": "Namibia", "alpha-2 code": "NA", "alpha-3 code": "NAM", "numeric code": "516" },
      { "name": "Nauru", "alpha-2 code": "NR", "alpha-3 code": "NRU", "numeric code": "520" },
      { "name": "Nepal", "alpha-2 code": "NP", "alpha-3 code": "NPL", "numeric code": "524" },
      { "name": "Netherlands", "alpha-2 code": "NL", "alpha-3 code": "NLD", "numeric code": "528" },
      { "name": "Curaçao", "alpha-2 code": "CW", "alpha-3 code": "CUW", "numeric code": "531" },
      { "name": "Aruba", "alpha-2 code": "AW", "alpha-3 code": "ABW", "numeric code": "533" },
      { "name": "Sint Maarten", "alpha-2 code": "SX", "alpha-3 code": "SXM", "numeric code": "534" },
      { "name": "Bonaire, Sint Eustatius and Saba", "alpha-2 code": "BQ", "alpha-3 code": "BES", "numeric code": "535" },
      { "name": "New Caledonia", "alpha-2 code": "NC", "alpha-3 code": "NCL", "numeric code": "540" },
      { "name": "Vanuatu", "alpha-2 code": "VU", "alpha-3 code": "VUT", "numeric code": "548" },
      { "name": "New Zealand", "alpha-2 code": "NZ", "alpha-3 code": "NZL", "numeric code": "554" },
      { "name": "Nicaragua", "alpha-2 code": "NI", "alpha-3 code": "NIC", "numeric code": "558" },
      { "name": "Niger", "alpha-2 code": "NE", "alpha-3 code": "NER", "numeric code": "562" },
      { "name": "Nigeria", "alpha-2 code": "NG", "alpha-3 code": "NGA", "numeric code": "566" },
      { "name": "Niue", "alpha-2 code": "NU", "alpha-3 code": "NIU", "numeric code": "570" },
      { "name": "Norfolk Island", "alpha-2 code": "NF", "alpha-3 code": "NFK", "numeric code": "574" },
      { "name": "Norway", "alpha-2 code": "NO", "alpha-3 code": "NOR", "numeric code": "578" },
      { "name": "Northern Mariana Islands", "alpha-2 code": "MP", "alpha-3 code": "MNP", "numeric code": "580" },
      { "name": "United States Minor Outlying Islands", "alpha-2 code": "UM", "alpha-3 code": "UMI", "numeric code": "581" },
      { "name": "Micronesia", "alpha-2 code": "FM", "alpha-3 code": "FSM", "numeric code": "583" },
      { "name": "Marshall Islands", "alpha-2 code": "MH", "alpha-3 code": "MHL", "numeric code": "584" },
      { "name": "Palau", "alpha-2 code": "PW", "alpha-3 code": "PLW", "numeric code": "585" },
      { "name": "Pakistan", "alpha-2 code": "PK", "alpha-3 code": "PAK", "numeric code": "586" },
      { "name": "Panama", "alpha-2 code": "PA", "alpha-3 code": "PAN", "numeric code": "591" },
      { "name": "Papua New Guinea", "alpha-2 code": "PG", "alpha-3 code": "PNG", "numeric code": "598" },
      { "name": "Paraguay", "alpha-2 code": "PY", "alpha-3 code": "PRY", "numeric code": "600" },
      { "name": "Peru", "alpha-2 code": "PE", "alpha-3 code": "PER", "numeric code": "604" },
      { "name": "Philippines", "alpha-2 code": "PH", "alpha-3 code": "PHL", "numeric code": "608" },
      { "name": "Pitcairn", "alpha-2 code": "PN", "alpha-3 code": "PCN", "numeric code": "612" },
      { "name": "Poland", "alpha-2 code": "PL", "alpha-3 code": "POL", "numeric code": "616" },
      { "name": "Portugal", "alpha-2 code": "PT", "alpha-3 code": "PRT", "numeric code": "620" },
      { "name": "Guinea-Bissau", "alpha-2 code": "GW", "alpha-3 code": "GNB", "numeric code": "624" },
      { "name": "Timor-Leste", "alpha-2 code": "TL", "alpha-3 code": "TLS", "numeric code": "626" },
      { "name": "Puerto Rico", "alpha-2 code": "PR", "alpha-3 code": "PRI", "numeric code": "630" },
      { "name": "Qatar", "alpha-2 code": "QA", "alpha-3 code": "QAT", "numeric code": "634" },
      { "name": "Réunion", "alpha-2 code": "RE", "alpha-3 code": "REU", "numeric code": "638" },
      { "name": "Romania", "alpha-2 code": "RO", "alpha-3 code": "ROU", "numeric code": "642" },
      { "name": "Russian Federation", "alpha-2 code": "RU", "alpha-3 code": "RUS", "numeric code": "643" },
      { "name": "Rwanda", "alpha-2 code": "RW", "alpha-3 code": "RWA", "numeric code": "646" },
      { "name": "Saint Barthélemy", "alpha-2 code": "BL", "alpha-3 code": "BLM", "numeric code": "652" },
      { "name": "Saint Helena, Ascension and Tristan da Cunha", "alpha-2 code": "SH", "alpha-3 code": "SHN", "numeric code": "654" },
      { "name": "Saint Kitts and Nevis", "alpha-2 code": "KN", "alpha-3 code": "KNA", "numeric code": "659" },
      { "name": "Anguilla", "alpha-2 code": "AI", "alpha-3 code": "AIA", "numeric code": "660" },
      { "name": "Saint Lucia", "alpha-2 code": "LC", "alpha-3 code": "LCA", "numeric code": "662" },
      { "name": "Saint Martin", "alpha-2 code": "MF", "alpha-3 code": "MAF", "numeric code": "663" },
      { "name": "Saint Pierre and Miquelon", "alpha-2 code": "PM", "alpha-3 code": "SPM", "numeric code": "666" },
      { "name": "Saint Vincent and the Grenadines", "alpha-2 code": "VC", "alpha-3 code": "VCT", "numeric code": "670" },
      { "name": "San Marino", "alpha-2 code": "SM", "alpha-3 code": "SMR", "numeric code": "674" },
      { "name": "Sao Tome and Principe", "alpha-2 code": "ST", "alpha-3 code": "STP", "numeric code": "678" },
      { "name": "Saudi Arabia", "alpha-2 code": "SA", "alpha-3 code": "SAU", "numeric code": "682" },
      { "name": "Senegal", "alpha-2 code": "SN", "alpha-3 code": "SEN", "numeric code": "686" },
      { "name": "Serbia", "alpha-2 code": "RS", "alpha-3 code": "SRB", "numeric code": "688" },
      { "name": "Seychelles", "alpha-2 code": "SC", "alpha-3 code": "SYC", "numeric code": "690" },
      { "name": "Sierra Leone", "alpha-2 code": "SL", "alpha-3 code": "SLE", "numeric code": "694" },
      { "name": "Singapore", "alpha-2 code": "SG", "alpha-3 code": "SGP", "numeric code": "702" },
      { "name": "Slovakia", "alpha-2 code": "SK", "alpha-3 code": "SVK", "numeric code": "703" },
      { "name": "Viet Nam", "alpha-2 code": "VN", "alpha-3 code": "VNM", "numeric code": "704" },
      { "name": "Slovenia", "alpha-2 code": "SI", "alpha-3 code": "SVN", "numeric code": "705" },
      { "name": "Somalia", "alpha-2 code": "SO", "alpha-3 code": "SOM", "numeric code": "706" },
      { "name": "South Africa", "alpha-2 code": "ZA", "alpha-3 code": "ZAF", "numeric code": "710" },
      { "name": "Zimbabwe", "alpha-2 code": "ZW", "alpha-3 code": "ZWE", "numeric code": "716" },
      { "name": "Spain", "alpha-2 code": "ES", "alpha-3 code": "ESP", "numeric code": "724" },
      { "name": "South Sudan", "alpha-2 code": "SS", "alpha-3 code": "SSD", "numeric code": "728" },
      { "name": "Sudan", "alpha-2 code": "SD", "alpha-3 code": "SDN", "numeric code": "729" },
      { "name": "Western Sahara", "alpha-2 code": "EH", "alpha-3 code": "ESH", "numeric code": "732" },
      { "name": "Suriname", "alpha-2 code": "SR", "alpha-3 code": "SUR", "numeric code": "740" },
      { "name": "Svalbard and Jan Mayen", "alpha-2 code": "SJ", "alpha-3 code": "SJM", "numeric code": "744" },
      { "name": "Eswatini", "alpha-2 code": "SZ", "alpha-3 code": "SWZ", "numeric code": "748" },
      { "name": "Sweden", "alpha-2 code": "SE", "alpha-3 code": "SWE", "numeric code": "752" },
      { "name": "Switzerland", "alpha-2 code": "CH", "alpha-3 code": "CHE", "numeric code": "756" },
      { "name": "Syrian Arab Republic", "alpha-2 code": "SY", "alpha-3 code": "SYR", "numeric code": "760" },
      { "name": "Tajikistan", "alpha-2 code": "TJ", "alpha-3 code": "TJK", "numeric code": "762" },
      { "name": "Thailand", "alpha-2 code": "TH", "alpha-3 code": "THA", "numeric code": "764" },
      { "name": "Togo", "alpha-2 code": "TG", "alpha-3 code": "TGO", "numeric code": "768" },
      { "name": "Tokelau", "alpha-2 code": "TK", "alpha-3 code": "TKL", "numeric code": "772" },
      { "name": "Tonga", "alpha-2 code": "TO", "alpha-3 code": "TON", "numeric code": "776" },
      { "name": "Trinidad and Tobago", "alpha-2 code": "TT", "alpha-3 code": "TTO", "numeric code": "780" },
      { "name": "United Arab Emirates", "alpha-2 code": "AE", "alpha-3 code": "ARE", "numeric code": "784" },
      { "name": "Tunisia", "alpha-2 code": "TN", "alpha-3 code": "TUN", "numeric code": "788" },
      { "name": "Türkiye", "alpha-2 code": "TR", "alpha-3 code": "TUR", "numeric code": "792" },
      { "name": "Turkmenistan", "alpha-2 code": "TM", "alpha-3 code": "TKM", "numeric code": "795" },
      { "name": "Turks and Caicos Islands", "alpha-2 code": "TC", "alpha-3 code": "TCA", "numeric code": "796" },
      { "name": "Tuvalu", "alpha-2 code": "TV", "alpha-3 code": "TUV", "numeric code": "798" },
      { "name": "Uganda", "alpha-2 code": "UG", "alpha-3 code": "UGA", "numeric code": "800" },
      { "name": "Ukraine", "alpha-2 code": "UA", "alpha-3 code": "UKR", "numeric code": "804" },
      { "name": "North Macedonia", "alpha-2 code": "MK", "alpha-3 code": "MKD", "numeric code": "807" },
      { "name": "Egypt", "alpha-2 code": "EG", "alpha-3 code": "EGY", "numeric code": "818" },
      { "name": "United Kingdom of Great Britain and Northern Ireland", "alpha-2 code": "GB", "alpha-3 code": "GBR", "numeric code": "826" },
      { "name": "Guernsey", "alpha-2 code": "GG", "alpha-3 code": "GGY", "numeric code": "831" },
      { "name": "Jersey", "alpha-2 code": "JE", "alpha-3 code": "JEY", "numeric code": "832" },
      { "name": "Isle of Man", "alpha-2 code": "IM", "alpha-3 code": "IMN", "numeric code": "833" },
      { "name": "Tanzania, United Republic of", "alpha-2 code": "TZ", "alpha-3 code": "TZA", "numeric code": "834" },
      { "name": "United States of America", "alpha-2 code": "US", "alpha-3 code": "USA", "numeric code": "840" },
      { "name": "Virgin Islands (U.S.)", "alpha-2 code": "VI", "alpha-3 code": "VIR", "numeric code": "850" },
      { "name": "Burkina Faso", "alpha-2 code": "BF", "alpha-3 code": "BFA", "numeric code": "854" },
      { "name": "Uruguay", "alpha-2 code": "UY", "alpha-3 code": "URY", "numeric code": "858" },
      { "name": "Uzbekistan", "alpha-2 code": "UZ", "alpha-3 code": "UZB", "numeric code": "860" },
      { "name": "Venezuela", "alpha-2 code": "VE", "alpha-3 code": "VEN", "numeric code": "862" },
      { "name": "Wallis and Futuna", "alpha-2 code": "WF", "alpha-3 code": "WLF", "numeric code": "876" },
      { "name": "Samoa", "alpha-2 code": "WS", "alpha-3 code": "WSM", "numeric code": "882" },
      { "name": "Yemen", "alpha-2 code": "YE", "alpha-3 code": "YEM", "numeric code": "887" },
      { "name": "Zambia", "alpha-2 code": "ZM", "alpha-3 code": "ZMB", "numeric code": "894" }
   ];

   return codes[$getRandIntInc(0, codes.length - 1)];
}

function $ftoc(fahrenheit) {
   /*
    *  convert Fahrenheit to Celsius temparature unit
    */
   return (fahrenheit - 32) / 1.8;
}

function $ctof(celsius) {
   /*
    *  convert Celsius to Fahrenheit temparature unit
    */
   return celsius * 1.8 + 32;
}

function $ctok(celsius) {
   /*
    *  convert Celsius to Kelvin temparature unit
    */
   return celsius + K;
}

function $ktoc(kelvin) {
   /*
    *  convert Kelvin to Celsius temparature unit
    */
   return kelvin - K;
}

function $ftok(fahrenheit) {
   /*
    *  convert Fahrenheit to Kelvin temparature unit
    */
   return ((fahrenheit - 32) / 1.8) + K;
}

function $ktof(kelvin) {
   /*
    *  convert Kelvin to Fahrenheit temparature unit
    */
   return (kelvin - K) * 1.8 + 32;
}

function $bool(chance = 0.5) {
   /*
    *  return true/false
    */
   return $rand() < chance;
}

function $benford() {
   /*
    *  Benford's law (experimental)
    */
   array => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      val => [val, array.reduce(
         (sum, item) => sum + (item[0] == val), 0
      ) / array.length, Math.log10(1 + (1 / val))
   ]);

   return array;
}

function $stats(dbName = db.getName()) {
   /*
    *  stats() wrapper
    */
   let stats = db.getSiblingDB(dbName).stats( // max precision due to SERVER-69036
      // MONGOSH-1108 (mongosh v1.2.0) & SERVER-62277 (mongod v5.0.6)
      (serverVer(5.0) && (shellVer() >= 5.0 || (typeof process !== 'undefined' && shellVer() >= 1.1))) ? { "freeStorage": 1, "scale": 1 } : 1
   );
   stats.name = dbName;
   if (stats.hasOwnProperty('raw')) {
      stats.collections = 0;
      stats.views = 0;
      for (let key in stats.raw) {
         if (stats.raw.hasOwnProperty(key)) {
            stats.collections += +stats.raw[key].collections;
            stats.views += +stats.raw[key].views;
         }
      }
   }
   stats.namespaces = stats.collections + stats.views;

   return stats;
}

function $collStats(dbName = db.getName(), collName = '') {
   /*
    *  $collStats wrapper
    */
   let namespace = db.getSiblingDB(dbName).getCollection(collName);
   let options = {
         "allowDiskUse": true,
         "cursor": { "batchSize": 0 },
         "readConcern": { "level": "local" },
         "comment": `run by ${__lib.name} sharding compatible $collStats wrapper`
      },
      pipeline = [
         { "$collStats": { "storageStats": { "scale": 1 } } },
         { "$set": {
            "storageStats.wiredTiger.creationStrings": {
               "$arrayElemAt": [{
                  "$regexFindAll": {
                     "input": "$storageStats.wiredTiger.creationString",
                     "regex": /block_compressor=(\w+).+internal_page_max=(\d+).+leaf_page_max=(\d+)/
                  } },
                  0
            ] },
            "storageStats.indexStats": { "$objectToArray": "$storageStats.indexDetails" }
         } },
         { "$set": {
            "storageStats.wiredTiger.compressor": {
               "$ifNull": [{ "$arrayElemAt": ["$storageStats.wiredTiger.creationStrings.captures", 0] }, "undef"]
            },
            "storageStats.wiredTiger.internalPageSize": {
               "$multiply": [
                  { "$toInt": {
                     "$ifNull": [{ "$arrayElemAt": ["$storageStats.wiredTiger.creationStrings.captures", 1] }, 4]
                  } }, 1024
            ] },
            "storageStats.wiredTiger.dataPageSize": {
               "$multiply": [
                  { "$toInt": {
                     "$ifNull": [{ "$arrayElemAt": ["$storageStats.wiredTiger.creationStrings.captures", 2] }, 32]
                  } }, 1024
            ] },
            "storageStats.indexes": {
               "$map": {
                  "input": "$storageStats.indexStats",
                  "as": "indexes",
                  "in": {
                     "$arrayToObject": [[
                        { "k": "name", "v": "$$indexes.k" },
                        { "k": "uri", "v": { "$ifNull": ["$$indexes.v.uri", "statistics:table:index-0-0000000000000000000"] } },
                        { "k": "file size in bytes", "v": { "$ifNull": ["$$indexes.v.block-manager.file size in bytes", 4096] } },
                        { "k": "file bytes available for reuse", "v": { "$ifNull": ["$$indexes.v.block-manager.file bytes available for reuse", 0] } },
                        { "k": "file allocation unit size", "v": { "$ifNull": ["$$indexes.v.block-manager.file allocation unit size", 4096] } }
            ]] } } },
            "storageStats.indexDetails.file size in bytes": {
               "$reduce": {
                  "input": "$storageStats.indexStats",
                  "initialValue": 0,
                  "in": { "$sum": ["$$value", "$$this.v.block-manager.file size in bytes"] }
            } },
            "storageStats.indexDetails.file bytes available for reuse": {
               "$reduce": {
                  "input": "$storageStats.indexStats",
                  "initialValue": 0,
                  "in": { "$sum": ["$$value", "$$this.v.block-manager.file bytes available for reuse"] }
            } }
         } },
         { "$group": {
            "_id": null,
            "name": { "$push": "$ns" },
            "nodes": { "$sum": 1 },
            "shards": { "$push": "$shard" },
            "dataSize": { "$sum": "$storageStats.size" },
            "objects": { "$sum": "$storageStats.count" },
            "avgObjSize": { "$avg": "$storageStats.avgObjSize" },
            "orphans": { "$sum": "$storageStats.numOrphanDocs" }, // Available starting in MongoDB 6.0
            "storageSize": { "$sum": "$storageStats.storageSize" },
            "freeStorageSize": { "$sum": "$storageStats.wiredTiger.block-manager.file bytes available for reuse" },
            "compressor": { "$push": "$storageStats.wiredTiger.compressor" },
            "internalPageSize": { "$push": "$storageStats.wiredTiger.internalPageSize" },
            "dataPageSize": { "$push": "$storageStats.wiredTiger.dataPageSize" },
            "uri": { "$push": "$storageStats.wiredTiger.uri" },
            "file allocation unit size": { "$push": { "$ifNull": ["$storageStats.wiredTiger.block-manager.file allocation unit size", "$storageStats.wiredTiger.internalPageSize"] } },
            "file bytes available for reuse": { "$push": { "$ifNull": ["$storageStats.wiredTiger.block-manager.file bytes available for reuse", "$storageStats.freeStorageSize"] } },
            "file size in bytes": { "$push": { "$ifNull": ["$storageStats.wiredTiger.block-manager.file size in bytes", { "$sum": "$storageStats.storageSize" }] } },
            "nindexes": { "$sum": "$storageStats.nindexes" },
            "indexes": { "$push": "$storageStats.indexes" },
            "indexes size in bytes": { "$sum": "$storageStats.indexDetails.file size in bytes" },
            "indexes bytes available for reuse": { "$sum": "$storageStats.indexDetails.file bytes available for reuse" }
         } },
         { "$set": {
            "name": { 
               "$regexFind": {
                  "input": { "$arrayElemAt": ["$name", 0] },
                  "regex": /^[^.]+\.(.+)$/
            } },
            "wiredTiger": {
               "block-manager": {
                  "file size in bytes": "$file size in bytes",
                  "file bytes available for reuse": "$file bytes available for reuse",
                  "file allocation unit size": "$file allocation unit size"
               },
               "compressor": "$compressor",
               "dataPageSize": "$dataPageSize",
               "internalPageSize": "$internalPageSize",
               "uri": "$uri",
               "indexes": "$indexes"
            },
            "totalIndexSize": "$indexes size in bytes",
            "totalIndexBytesReusable": "$indexes bytes available for reuse"
         } },
         { "$set": {
            "name": { "$arrayElemAt": ["$name.captures", 0] },
            "dataPageSize": {
               "$reduce": {
                  "input": "$wiredTiger.dataPageSize",
                  "initialValue": { "$arrayElemAt": ["$wiredTiger.dataPageSize", 0] },
                  "in": { "$cond": [{ "$eq": ["$$value", "$$this"] }, "$$value", "mixed"] }
            } },
            "compressor": {
               "$reduce": {
                  "input": "$wiredTiger.compressor",
                  "initialValue": { "$arrayElemAt": ["$wiredTiger.compressor", 0] },
                  "in": { "$cond": [{ "$eq": ["$$value", "$$this"] }, "$$value", "mixed"] }
            } },
            "internalPageSize": {
               "$reduce": {
                  "input": "$wiredTiger.internalPageSize",
                  "initialValue": { "$arrayElemAt": ["$wiredTiger.internalPageSize", 0] },
                  "in": { "$cond": [{ "$eq": ["$$value", "$$this"] }, "$$value", "mixed"] }
            } },
            "indexes": {
               "$reduce": {
                  "input": {
                     "$reverseArray": {
                        "$reduce": {
                           "input": {
                              "$reduce": {
                                 "input": "$indexes",
                                 "initialValue": [],
                                 "in": { "$concatArrays": ["$$value", "$$this"] }
                           } },
                           "initialValue": [],
                           "in": {
                              "$let": {
                                 "vars": {
                                    "sorted": {
                                       "$filter": {
                                          "input": "$$value",
                                          "as": "idx",
                                          "cond": { "$lt": ["$$this", "$$idx"] }
                                 } } },
                                 "in": {
                                    "$concatArrays": [
                                       "$$sorted",
                                       ["$$this"],
                                       { "$setDifference": ["$$value", "$$sorted"] }
                  ] } } } } } },
                  "initialValue": [],
                  "in": {
                     "$cond": {
                        "if": {
                           "$eq": [
                              { "$arrayElemAt": ["$$value.name", -1] },
                              "$$this.name"
                        ] },
                        "then": {
                           "$concatArrays": [
                              { "$slice": [
                                 "$$value",
                                 { "$subtract": [{ "$size": "$$value" }, 1] }
                              ] },
                              [{
                                 "name": "$$this.name",
                                 "file size in bytes": { "$sum": [{ "$arrayElemAt": ["$$value.file size in bytes", -1] }, "$$this.file size in bytes"] },
                                 "file bytes available for reuse": { "$sum": [{ "$arrayElemAt": ["$$value.file bytes available for reuse", -1] }, "$$this.file bytes available for reuse"] }
                        }]] },
                        "else": {
                           "$concatArrays": ["$$value", ["$$this"]]
         } } } } } } },
         { "$unset": [
            "_id",
            "file allocation unit size",
            "file size in bytes",
            "file bytes available for reuse",
            "indexes.file allocation unit size",
            "indexes.uri",
            "indexes bytes available for reuse",
            "indexes size in bytes",
            "uri"
         ] }
      ];

   return namespace.aggregate(pipeline, options).toArray()[0];
}

// EOF
