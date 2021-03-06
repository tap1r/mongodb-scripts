/*
 *  Name: "mdblib.js"
 *  Version = "0.2.5"
 *  Description: mongo shell helper library
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

/*
 *  Global defaults
 */

var bsonMax = (typeof isMaster().maxBsonObjectSize === 'undefined') ? 16 * Math.pow(1024, 2) : isMaster().maxBsonObjectSize;
const idiomas = ['none', 'da', 'nl', 'en', 'fi', 'fr', 'de', 'hu', 'it', 'nb', 'pt', 'ro', 'ru', 'es', 'sv', 'tr'];

// Random.setRandomSeed(); 
// pcg32.srandom(42, 52); // seed

/*
 *  Helper functions, derived from:
 *  https://github.com/uxitten/polyfill/blob/master/string.polyfill.js
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padStart
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padEnd
 *  https://github.com/tc39/proposal-object-values-entries
 */

String.prototype.padStart = function padStart(targetLength, padString) {
    targetLength = targetLength >> 0; // truncate if number, or convert non-number to 0
    padString = String(typeof padString !== 'undefined' ? padString : ' ');
    if (this.length >= targetLength) {
        return String(this);
    } else {
        targetLength = targetLength - this.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength / padString.length); // append to original to ensure we are longer than needed
        }
        return padString.slice(0, targetLength) + String(this);
    }
};

String.prototype.padEnd = function padEnd(targetLength, padString) {
    targetLength = targetLength >> 0; // floor if number or convert non-number to 0;
    padString = String(typeof padString !== 'undefined' ? padString : ' ');
    if (this.length > targetLength) {
        return String(this);
    } else {
        targetLength = targetLength - this.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength / padString.length); // append to original to ensure we are longer than needed
        }
        return String(this) + padString.slice(0, targetLength);
    }
};

if (!Object.entries) {
    Object.entries = function(obj){
        var ownProps = Object.keys(obj),
            i = ownProps.length,
            resArray = new Array(i); // preallocate the Array
        while (--i)
            resArray[i] = [ownProps[i], obj[ownProps[i]]];

        return resArray;
    };
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
            case  'B': return { "name": "bytes",      "unit":  "B", "symbol":  "", "factor": Math.pow(1024, 0), "precision": 0, "pctPoint": 2 };
            case 'KB': return { "name": "kilobytes",  "unit": "KB", "symbol": "k", "factor": Math.pow(1024, 1), "precision": 2, "pctPoint": 1 };
            case 'MB': return { "name": "megabytes",  "unit": "MB", "symbol": "M", "factor": Math.pow(1024, 2), "precision": 2, "pctPoint": 1 };
            case 'GB': return { "name": "gigabytes",  "unit": "GB", "symbol": "G", "factor": Math.pow(1024, 3), "precision": 2, "pctPoint": 1 };
            case 'TB': return { "name": "terabytes",  "unit": "TB", "symbol": "T", "factor": Math.pow(1024, 4), "precision": 2, "pctPoint": 1 };
            case 'PB': return { "name": "petabytes",  "unit": "PB", "symbol": "P", "factor": Math.pow(1024, 5), "precision": 2, "pctPoint": 1 };
            case 'EB': return { "name": "exabytes",   "unit": "EB", "symbol": "E", "factor": Math.pow(1024, 6), "precision": 2, "pctPoint": 1 };
            case 'ZB': return { "name": "zettabytes", "unit": "ZB", "symbol": "Z", "factor": Math.pow(1024, 7), "precision": 2, "pctPoint": 1 };
            case 'YB': return { "name": "yottabytes", "unit": "YB", "symbol": "Y", "factor": Math.pow(1024, 8), "precision": 2, "pctPoint": 1 };
            default:   return { "name": "megabytes",  "unit": "MB", "symbol": "M", "factor": Math.pow(1024, 2), "precision": 2, "pctPoint": 1 };
        }
    }
}

class AutoFactor {
    /*
     *  Determine scale factor automatically
     */
    constructor(input) {
        this.B  = this.metric('bytes',       'B',  '', 0, 0, 2);
        this.KB = this.metric('kilobytes',  'KB', 'k', 1, 2, 1);
        this.MB = this.metric('megabytes',  'MB', 'M', 2, 2, 1);
        this.GB = this.metric('gigabytes',  'GB', 'G', 3, 2, 1);
        this.TB = this.metric('terabytes',  'TB', 'T', 4, 2, 1);
        this.PB = this.metric('petabytes',  'PB', 'P', 5, 2, 1);
        this.EB = this.metric('exabytes',   'EB', 'E', 6, 2, 1);
        this.ZB = this.metric('zettabytes', 'ZB', 'Z', 7, 2, 1);
        this.YB = this.metric('yottabytes', 'YB', 'Y', 8, 2, 1);

        if (typeof(input) === String) {
            switch (input.toUpperCase()) {
                case  'B': return this.B;
                case 'KB': return this.KB;
                case 'MB': return this.MB;
                case 'GB': return this.GB;
                case 'TB': return this.TB;
                case 'PB': return this.PB;
                case 'EB': return this.EB;
                case 'ZB': return this.ZB;
                case 'YB': return this.YB;
                default:   return this.MB;
            }
        } else if (typeof(input) === Number && input >= 0) {
            let scale = (Math.log2(input) / 10)|0;
            return (input / Math.pow(1024, scale)).toFixed(2) + [this.B, this.KB, this.MB, this.GB, this.TB, this.PB, this.EB, this.ZB, this.YB][scale];
        } else {
            return print('Invalid parameter type');
        }
    }

    metric(name, unit, symbol, factor, precision, pctPoint) {
        return { "name": name, "unit": unit, "symbol": symbol, "factor": Math.pow(1024, factor), "precision": precision, "pctPoint": pctPoint };
    }

    static formatted(number) {
        return (number / this.factor).toFixed(this.precision) + this.unit;
    }
}

class MetaStats {
    /*
     *  Storage statistics metadata class
     */
    constructor(name = '', dataSize = 0, storageSize = 0, objects = 0, blocksFree = 0, compressor = '', indexSize = 0, indexFree = 0) {
        /*
         * detect shell type
         */
        if (typeof process !== 'undefined' && process.title.match(/^mongosh/)[0] === 'mongosh') {
            // workaround mongosh async constructor limits
            // this.instance = (async() => db.hello().me)();
            this.hostname = (async() => db.hostInfo().system.hostname)();
            this.proc = (async() => db.serverStatus().process)();
            this.dbPath = ((async() => db.serverStatus().process === 'mongod')()) ? (async() => db.serverCmdLineOpts().parsed.storage.dbPath)() : null;
        } else {
            // legacy shell sync methods
            // this.instance = isMaster().me;
            this.hostname = db.hostInfo().system.hostname;
            this.proc = db.serverStatus().process;
            this.dbPath = (db.serverStatus().process === 'mongod') ? db.serverCmdLineOpts().parsed.storage.dbPath : null;
        }

        this.name = name;
        this.dataSize = dataSize;
        this.storageSize = storageSize;
        this.objects = objects;
        this.blocksFree = blocksFree;
        this.indexSize = indexSize;
        this.indexFree = indexFree;
        this.compressor = compressor;
    }

    compression() {
        return this.dataSize / (this.storageSize - this.blocksFree);
    }

    totalSize() {
        return this.storageSize + this.indexSize;
    }
}

function rand() {
    /*
     *  Choose your preferred randomiser
     */
    // return _rand(); // the shell's prng
    return Math.random(); // node's prng
    // return pcg32.random() / (Math.pow(2, 32) - 1); // PCG-XSH-RR // load('pcg-xsh-rr.js');
    // return Math.abs(_srand()) / (Math.pow(2, 63) - 1); // SecureRandom() method
    // return Random.rand(); // SecureRandom() method
    // return Fortuna();
}

function isReplSet() {
    /*
     *  Determine if current host is a replSet member
     */
    return (typeof isMaster().hosts !== 'undefined')
}

/*
 *  Versioned helper commands
 */

function serverVer(ver) {
    /*
     *  Evaluate server version
     */
    if (ver !== 'undefined' && ver <= +db.version().match(/^[0-9]+\.[0-9]+/)) {
        return true;
    } else if (ver !== 'undefined' && ver > +db.version().match(/^[0-9]+\.[0-9]+/)) {
        return false;
    } else {
        return +db.version().match(/^[0-9]+\.[0-9]+/);
    }
}

function shellVer() {
    /*
     *  Evaluate shell version
     */
    return +version().match(/^[0-9]+\.[0-9]+/);
}

function slaveOk(readPref = 'primaryPreferred') {
    /*
     *  Backward compatability with rs.slaveOk()
     */
    if (typeof rs.slaveOk === 'undefined' && typeof rs.secondaryOk === 'undefined') {
        return db.getMongo().setReadPref(readPref);
    } else if (shellVer() >= 4.4) {
        return rs.secondaryOk();
    } else {
        return rs.slaveOk();
    }
}

function isMaster() {
    /*
     *  Backward compatability with db.isMaster()
     */
    if (typeof db.hello === 'undefined') {
        return db.isMaster();
    } else {
        return db.hello();
    }
}

/*
 *  Backward compatability with UUID().base64()
 */
if (typeof UUID().base64 === 'undefined') UUID.prototype.base64 = function() { return this.toString('base64'); }

/*
 *  Helper functions
 */

const K = 273.15;

function getRandomNumber(min = 0, max = 1) {
    /*
     *  generate random number
     */
    return rand() * (max - min) + min;
}

function getRandomExp(exponent = 0) {
    /*
     *  generate random exponential number
     */
    return Math.ceil(getRandomNumber(1, 10) * Math.pow(10, exponent));
}

function getRandomInt(min = 0, max = 1) {
    /*
     *  generate random integer
     */
    min = Math.ceil(min);
    max = Math.floor(max);

    return (rand() * (max - min) + min)|0;
}

function getRandomIntInclusive(min = 0, max = 1) {
    /*
     *  generate random integer inclusive of the maximum
     */
    min = Math.ceil(min);
    max = Math.floor(max);

    return (rand() * (max - min + 1) + min)|0;
}

function getRandomRatioInt(ratios = [1]) {
    /*
     *  generate ratioed random integer
     */
    let weightedIndex = [];
    ratios.forEach((ratio, idx) => {
        for (let i = 0; i < ratio; ++i) {
            weightedIndex.push(idx);
        }
    });

    return weightedIndex[rand() * weightedIndex.length|0];
}

function genRandomHex(len = 1) {
    /*
     *  generate random hexadecimal string
     */
    let res = '';
    for (let i = 0; i < len; ++i) {
        res += (rand() * 16|0).toString(16);
    }

    return res;
}

function genRandomString(len = 1) {
    /*
     *  generate random alpha-numeric string
     */
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(rand() * chars.length|0);
    }

    return res;
}

function genRandomAlpha(len = 1) {
    /*
     *  generate random alpha-character string
     */
    let res = '';
    let chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < len; ++i) {
       res += chars.charAt(getRandomInt(0, chars.length));
    }

    return res;
}

function genRandomSymbol() {
    /*
     *  generate random symbol
     */
    let symbol = '!#%&\'()+,-;=@[]^_`{}~¡¢£¤¥¦§¨©ª«¬­®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ';

    return symbol.charAt(rand() * symbol.length|0);
}

function genRandomCurrency() {
    /*
     *  generate random curreny symbol
     */
    let currencies = ['$', '€', '₡', '£', '₪', '₹', '¥', '₩', '₦', '₱zł', '₲', '฿', '₴', '₫'];

    return currencies[getRandomInt(0, currencies.length)];
}

function genArrayElements(len) {
    /*
     *  generate array of random strings
     */
    let array = [];
    for (let i = 0; i < len; ++i) {
        array.push(genRandomString(getRandomIntInclusive(6, 24)));
    }

    return array;
}

function genRandomInclusivePareto(min, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the "shape" of the distribution
     */
    let u = 1.0 - rand();

    return min / Math.pow(u, (1.0 / alpha));
}

function genRandomIntInclusivePareto(min, max, alpha = 1.161) {
    /*
     *  min is the lowest possible value that can be returned
     *  alpha controls the "shape" of the distribution
     */
    let k = max * (1.0 - rand()) + min
    let v = Math.pow(k, alpha);

    return v + min;
}

function genNormal(mu, sigma) {
    /*
     *  mu = mean
     *  sigma = standard deviation
     */
    let x = Math.sqrt(-2.0 * Math.log(rand())) * Math.cos(Math.PI*2 * rand());

    return x * sigma + mu;
}

function genExponential(lambda = 1) {
    /*
     *  exponential distribution function
     */
    return -Math.log(1.0 - rand()) / lambda;
}

function ftoc(fahrenheit) {
    /*
     *  convert Fahrenheit to Celsius temparature unit
     */
    return (fahrenheit - 32) / 1.8;
}

function ctof(celsius) {
    /*
     *  convert Celsius to Fahrenheit temparature unit
     */
    return celsius * 1.8 + 32;
}

function ctok(celsius) {
    /*
     *  convert Celsius to Kelvin temparature unit
     */
    return celsius + K;
}

function ktoc(kelvin) {
    /*
     *  convert Kelvin to Celsius temparature unit
     */
    return kelvin - K;
}

function ftok(fahrenheit) {
    /*
     *  convert Fahrenheit to Kelvin temparature unit
     */
    return ((fahrenheit - 32) / 1.8) + K;
}

function ktof(kelvin) {
    /*
     *  convert Kelvin to Fahrenheit temparature unit
     */
    return (kelvin - K) * 1.8 + 32;
}

function bool(chance = 0.5) {
    /*
     *  return true/false
     */
    return rand() < chance;
}

function benford() {
    /*
     *  benford law
     */
    array => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
        val => [val, array.reduce(
                (sum, item) => sum + (
                    item [0] === val
                ),
                0
            ) / array.length, Math.log10(1 + 1 / val)
        ]);
    
        return array;
}

// EOF
