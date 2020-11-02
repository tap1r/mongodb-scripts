/*
 *  mdblib.js
 *  Description: Mongo shell helper functions
 *  Created by: luke.prochazka@mongodb.com
 */

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
    constructor(unit) {
        // default to MB
        switch (unit) {
            case 'B': return { name: "bytes", unit: "B", symbol: "", factor: 1024 ** 0, precision: 0, pctPoint: 2 };
            case 'KB': return { name: "kilobytes", unit: "KB", symbol: "k", factor: 1024 ** 1, precision: 2, pctPoint: 1 };
            case 'MB': return { name: "megabytes", unit: "MB", symbol: "M", factor: 1024 ** 2, precision: 2, pctPoint: 1 };
            case 'GB': return { name: "gigabytes", unit: "GB", symbol: "G", factor: 1024 ** 3, precision: 2, pctPoint: 1 };
            case 'TB': return { name: "terabytes", unit: "TB", symbol: "T", factor: 1024 ** 4, precision: 2, pctPoint: 1 };
            case 'PB': return { name: "petabytes", unit: "PB", symbol: "P", factor: 1024 ** 5, precision: 2, pctPoint: 1 };
            case 'EB': return { name: "exabytes", unit: "EB", symbol: "E", factor: 1024 ** 6, precision: 2, pctPoint: 1 };
            case 'ZB': return { name: "zettabytes", unit: "ZB", symbol: "Z", factor: 1024 ** 7, precision: 2, pctPoint: 1 };
            case 'YB': return { name: "yottabytes", unit: "YB", symbol: "Y", factor: 1024 ** 8, precision: 2, pctPoint: 1 };
            default: return { name: "megabytes", unit: "MB", symbol: "M", factor: 1024 ** 2, precision: 2, pctPoint: 1 };
        }
    }
}

class AutoFactor {
    /*
     *  Determine scaling automatically
     */
    constructor(metric) {
        //
        let scale = Math.floor(Math.log2(metric) / 10);
        return (metric / 1024 ** scale).toFixed(2) + ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'][scale];
    }
}

class MetaStats {
    /*
     *  Storage metadata class
     */
    constructor() {
        this.name = "";
        this.dataSize = 0;
        this.storageSize = 0;
        this.objects = 0;
        this.freeBlocks = 0;
        this.indexSize =0;
        this.indexFree = 0;
        this.compression = function() {
            return this.dataSize / (this.storageSize - this.freeBlocks);
        }
    }
}

/*
 *  Versioned helper commands
 */

switch (version().match(/^[0-9]+\.[0-9]+/)[0]) {
    case "4.4":
        slaveOk = rs.secondaryOk;
        break;
    default:
        slaveOk = rs.slaveOk;
}

// EOF
