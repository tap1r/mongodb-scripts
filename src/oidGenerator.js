/*
 *  Name: "oidGenerator.js"
 *  Version: "0.1.2"
 *  Description: Aggregation based OID generator (requires v5.0+)
 *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
 */

let options = {
        "comment": "$oid generator",
        "let": {
            "nonce": (+((+db.adminCommand({ "features": 1 }).oidMachine).toString() + (+db.serverStatus().pid).toString())).toString(16).substring(0, 10)
        }
    },
    pipeline = [
        { "$documents": [ // sample timestamps for conversion
            { "timestamp": 0 },
            { "timestamp": "1000" },
            { "timestamp": 65536 },
            { "timestamp": Math.pow(2, 32) },
            { "timestamp": "$$NOW" }
        ] },
        { "$set": { "_epoch": { "$convert": { "input": "$timestamp", "to": "long" } } } }, // 4-byte _epoch timestamp
        { "$set": { "_epoch": { "$trunc": ["$_epoch", -3] } } },
        { "$set": { "_epoch": { "$divide": ["$_epoch", 1000] } } },
        { "$set": { "_epoch": { "$convert": { "input": "$_epoch", "to": "int" } } } },
        { "$set": {
            "_epoch": {
                "$reduce": {
                    "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$_epoch", 1] }, 16] } }]}, // scale
                    "initialValue": {
                        "quotient": { "$floor": { "$divide": ["$_epoch", 16] } }, // quotient
                        "remainder": { "$mod": ["$_epoch", 16] }, // remainder
                        "hexArray": []
                    },
                    "in": {
                        "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
                        "remainder": { "$mod": ["$$value.quotient", 16] },
                        "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
        } } } } },
        { "$set": {
            "_epoch": {
                "$map": {
                    "input": { "$reverseArray": "$_epoch.hexArray" },
                    "in": { 
                        "$switch": {
                            "branches": [
                                { "case": { "$eq": ["$$this", 10] }, "then": "a" },
                                { "case": { "$eq": ["$$this", 11] }, "then": "b" },
                                { "case": { "$eq": ["$$this", 12] }, "then": "c" },
                                { "case": { "$eq": ["$$this", 13] }, "then": "d" },
                                { "case": { "$eq": ["$$this", 14] }, "then": "e" },
                                { "case": { "$eq": ["$$this", 15] }, "then": "f" }
                            ],
                            "default": { "$toString": "$$this" }
        } } } } } },
        { "$set": {
            "_epoch": {
                "$reduce": {
                    "input": "$_epoch",
                    "initialValue": "",
                    "in": { "$concat": ["$$value", "$$this"] }
        } } } },
        { "$set": {
            "_epoch": {
                "$map": {
                    "input": ["$_epoch"],
                    "as": "epoch",
                    "in": { 
                        "$switch": {
                            "branches": [
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 7] }, "then": { "$concat": ["0", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 6] }, "then": { "$concat": ["00", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 5] }, "then": { "$concat": ["000", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 4] }, "then": { "$concat": ["0000", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 3] }, "then": { "$concat": ["00000", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 2] }, "then": { "$concat": ["000000", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 1] }, "then": { "$concat": ["0000000", "$$epoch"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$epoch" }, 0] }, "then": "00000000" }
                            ],
                            "default": "$$epoch"
        } } } } } },
        { "$set": { "_epoch": { "$first": "$_epoch" } } },
        { "$set": { "_nonce": "$$nonce" } }, // 5-byte machine nonce
        { "$set": { "_counter": { "$floor": { "$multiply": [{ "$rand": {} }, { "$pow": [2, 24] }] } } } }, // 3-byte counter
        { "$set": {
            "_counter": {
                "$reduce": {
                    "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$_counter", 1] }, 16] } }]}, // scale
                    "initialValue": {
                        "quotient": { "$floor": { "$divide": ["$_counter", 16] } }, // quotient
                        "remainder": { "$mod": ["$_counter", 16] }, // remainder
                        "hexArray": []
                    },
                    "in": {
                        "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
                        "remainder": { "$mod": ["$$value.quotient", 16] },
                        "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
        } } } } },
        { "$set": {
            "_counter": {
                "$map": {
                    "input": { "$reverseArray": "$_counter.hexArray" },
                    "in": { 
                        "$switch": {
                            "branches": [
                                { "case": { "$eq": ["$$this", 10] }, "then": "a" },
                                { "case": { "$eq": ["$$this", 11] }, "then": "b" },
                                { "case": { "$eq": ["$$this", 12] }, "then": "c" },
                                { "case": { "$eq": ["$$this", 13] }, "then": "d" },
                                { "case": { "$eq": ["$$this", 14] }, "then": "e" },
                                { "case": { "$eq": ["$$this", 15] }, "then": "f" }
                            ],
                            "default": { "$toString": "$$this" }
        } } } } } },
        { "$set": {
            "_counter": {
                "$reduce": {
                    "input": "$_counter",
                    "initialValue": "",
                    "in": { "$concat": ["$$value", "$$this"] }
        } } } },
        { "$set": {
            "_counter": {
                "$map": {
                    "input": ["$_counter"],
                    "in": { 
                        "$switch": {
                            "branches": [
                                { "case": { "$eq": [{ "$strLenCP": "$$this" }, 5] }, "then": { "$concat": ["0", "$$this"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$this" }, 4] }, "then": { "$concat": ["00", "$$this"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$this" }, 3] }, "then": { "$concat": ["000", "$$this"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$this" }, 2] }, "then": { "$concat": ["0000", "$$this"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$this" }, 1] }, "then": { "$concat": ["00000", "$$this"] } },
                                { "case": { "$eq": [{ "$strLenCP": "$$this" }, 0] }, "then": "000000" }
                            ],
                            "default": "$$this"
        } } } } } },
        { "$set": { "_counter": { "$first": "$_counter" } } },
        { "$set": { "ObjectId": { "$convert": { "input": { "$concat": ["$_epoch", "$$nonce", "$_counter"] }, "to": "objectId" } } } }
    ];

db.aggregate(pipeline, options);
