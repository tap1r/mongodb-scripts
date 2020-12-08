/*
 *  Name: "mdblib.js"
 *  Version = "0.1.0"
 *  Description: mongo shell helper library
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

/*
 *  Global defaults
 */

if (typeof bsonMax === 'undefined') {
    var bsonMax = 16 * 1024 ** 2;
}
// Random.setRandomSeed(); 
// pcg32.srandom(42, 52); // seed

/*
 *  Helper functions, derived from:
 *  https://github.com/uxitten/polyfill/blob/master/string.polyfill.js
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padStart
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padEnd
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
            case 'B': return { "name": "bytes", "unit": "B", "symbol": "", "factor": 1024 ** 0, "precision": 0, "pctPoint": 2 };
            case 'KB': return { "name": "kilobytes", "unit": "KB", "symbol": "k", "factor": 1024 ** 1, "precision": 2, "pctPoint": 1 };
            case 'MB': return { "name": "megabytes", "unit": "MB", "symbol": "M", "factor": 1024 ** 2, "precision": 2, "pctPoint": 1 };
            case 'GB': return { "name": "gigabytes", "unit": "GB", "symbol": "G", "factor": 1024 ** 3, "precision": 2, "pctPoint": 1 };
            case 'TB': return { "name": "terabytes", "unit": "TB", "symbol": "T", "factor": 1024 ** 4, "precision": 2, "pctPoint": 1 };
            case 'PB': return { "name": "petabytes", "unit": "PB", "symbol": "P", "factor": 1024 ** 5, "precision": 2, "pctPoint": 1 };
            case 'EB': return { "name": "exabytes", "unit": "EB", "symbol": "E", "factor": 1024 ** 6, "precision": 2, "pctPoint": 1 };
            case 'ZB': return { "name": "zettabytes", "unit": "ZB", "symbol": "Z", "factor": 1024 ** 7, "precision": 2, "pctPoint": 1 };
            case 'YB': return { "name": "yottabytes", "unit": "YB", "symbol": "Y", "factor": 1024 ** 8, "precision": 2, "pctPoint": 1 };
            default: return { "name": "megabytes", "unit": "MB", "symbol": "M", "factor": 1024 ** 2, "precision": 2, "pctPoint": 1 };
        }
    }
}

class AutoFactor {
    /*
     *  Determine scale factor automatically
     */
    constructor(input) {
        this.B = this.metric('bytes', 'B', '', 0, 0, 2);
        this.KB = this.metric('kilobytes', 'KB', 'k', 1, 2, 1);
        this.MB = this.metric('megabytes', 'MB', 'M', 2, 2, 1);
        this.GB = this.metric('gigabytes', 'GB', 'G', 3, 2, 1);
        this.TB = this.metric('terabytes', 'TB', 'T', 4, 2, 1);
        this.PB = this.metric('petabytes', 'PB', 'P', 5, 2, 1);
        this.EB = this.metric('exabytes', 'EB', 'E', 6, 2, 1);
        this.ZB = this.metric('zettabytes', 'ZB', 'Z', 7, 2, 1);
        this.YB = this.metric('yottabytes', 'YB', 'Y', 8, 2, 1);

        if (typeof(input) === String) {
            switch (input.toUpperCase()) {
                case 'B': return this.B;
                case 'KB': return this.KB;
                case 'MB': return this.MB;
                case 'GB': return this.GB;
                case 'TB': return this.TB;
                case 'PB': return this.PB;
                case 'EB': return this.EB;
                case 'ZB': return this.ZB;
                case 'YB': return this.YB;
                default: return this.MB;
            }
        } else if (typeof(input) === Number && input >= 0) {
            let scale = Math.floor(Math.log2(input) / 10);
            return (input / 1024 ** scale).toFixed(2) + [this.B, this.KB, this.MB, this.GB, this.TB, this.PB, this.EB, this.ZB, this.YB][scale];
        } else {
            return print('Invalid parameter type');
        }
    }

    metric(name, unit, symbol, factor, precision, pctPoint) {
        return { "name": name, "unit": unit, "symbol": symbol, "factor": 1024 ** factor, "precision": precision, "pctPoint": pctPoint };
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
        // this.instance = db.isMaster().me;
        this.hostname = db.hostInfo().system.hostname;
        this.proc = db.serverStatus().process;
        db.serverStatus().process === 'mongod' ? this.dbPath = db.serverCmdLineOpts().parsed.storage.dbPath : this.dbPath = null;
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

/*
 *  Versioned helper commands
 */

function serverVer() {
    return +db.version().match(/^[0-9]+\.[0-9]+/);
}

function shellVer() {
    return +version().match(/^[0-9]+\.[0-9]+/);
}

function slaveOk() {
    if (shellVer() >= 4.4) {
        return rs.secondaryOk();
    } else {
        return rs.slaveOk();
    }
}

function rand() {
    /*
     *  Choose your preferred randomiser
     */
    // return _rand(); // the shell's prng
    return Math.random(); // node's prng
    // return pcg32.random() / (2 ** 32 - 1); // PCG-XSH-RR
    // return Math.abs(_srand()) / (2 ** 63 - 1); // SecureRandom() method
    // return Random.rand(); // SecureRandom() method
    // return Fortuna();
}

// EOF
