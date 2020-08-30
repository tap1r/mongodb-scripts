/*
 *  mdblib.js
 *  Mongo shell helper functions
 *  created by luke.prochazka@mongodb.com
 */

/*
 *  Helper functions, derived from:
 *  https://github.com/uxitten/polyfill/blob/master/string.polyfill.js
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padStart
 *  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/padEnd
 */

String.prototype.padStart = function padStart(targetLength, padString) {
    targetLength = targetLength >> 0; // truncate if number, or convert non-number to 0;
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
    targetLength = targetLength >> 0; //floor if number or convert non-number to 0;
    padString = String((typeof padString !== 'undefined' ? padString : ' '));
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
     * Scale formatting preferences
     */
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

// EOF
