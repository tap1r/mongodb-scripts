/*
 *  Name: "oidGenerator.js"
 *  Version: "0.1.0"
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
            { "timestamp": "$$NOW" },
        ] },
        { "$set": { "epoch": { "$convert": { "input": "$timestamp", "to": "long" } } } }, // 4-byte epoch timestamp
        { "$set": { "epoch": { "$trunc": ["$epoch", -3] } } },
        { "$set": { "epoch": { "$divide": ["$epoch", 1000] } } },
        { "$set": { "epoch": { "$convert": { "input": "$epoch", "to": "int" } } } },
        { "$set": {
            "epoch": {
                "$reduce": {
                    "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": [{ "$abs": "$epoch" }, 1] }, 16] } }]}, // scale
                    "initialValue": {
                        "quotient": { "$floor": { "$divide": ["$epoch", 16] } }, // quotient
                        "remainder": { "$mod": ["$epoch", 16] }, // remainder
                        "hexArray": []
                    },
                    "in": {
                        "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
                        "remainder": { "$mod": ["$$value.quotient", 16] },
                        "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
        } } } } },
        { "$set": {
            "epoch": {
                "$map": {
                    "input": { "$reverseArray": "$epoch.hexArray" },
                    "as": "digit",
                    "in": { 
                        "$switch": {
                            "branches": [
                                { "case": { "$eq": ["$$digit", 10] }, "then": "a" },
                                { "case": { "$eq": ["$$digit", 11] }, "then": "b" },
                                { "case": { "$eq": ["$$digit", 12] }, "then": "c" },
                                { "case": { "$eq": ["$$digit", 13] }, "then": "d" },
                                { "case": { "$eq": ["$$digit", 14] }, "then": "e" },
                                { "case": { "$eq": ["$$digit", 15] }, "then": "f" }
                            ],
                            "default": { "$toString": "$$digit" }
        } } } } } },
        { "$set": {
            "epoch": {
                "$reduce": {
                    "input": "$epoch",
                    "initialValue": "",
                    "in": { "$concat": ["$$value", "$$this"] }
        } } } },
        { "$set": {
            "epoch": {
                "$map": {
                        "input": ["$epoch"],
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
        { "$set": { "epoch": { "$first": "$epoch" } } },
        { "$set": { "nonce": "$$nonce" } }, // 5-byte machine nonce
        { "$set": { "counter": { "$floor": { "$multiply": [{ "$rand": {} }, { "$pow": [2, 24] }] } } } }, // 3-byte counter
        { "$set": {
            "counter": {
                "$reduce": {
                    "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$counter", 1] }, 16] } }]}, // scale
                    "initialValue": {
                        "quotient": { "$floor": { "$divide": ["$counter", 16] } }, // quotient
                        "remainder": { "$mod": ["$counter", 16] }, // remainder
                        "hexArray": []
                    },
                    "in": {
                        "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
                        "remainder": { "$mod": ["$$value.quotient", 16] },
                        "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
        } } } } },
        { "$set": {
            "counter": {
                "$map": {
                    "input": { "$reverseArray": "$counter.hexArray" },
                    "as": "digit",
                    "in": { 
                        "$switch": {
                            "branches": [
                                { "case": { "$eq": ["$$digit", 10] }, "then": "a" },
                                { "case": { "$eq": ["$$digit", 11] }, "then": "b" },
                                { "case": { "$eq": ["$$digit", 12] }, "then": "c" },
                                { "case": { "$eq": ["$$digit", 13] }, "then": "d" },
                                { "case": { "$eq": ["$$digit", 14] }, "then": "e" },
                                { "case": { "$eq": ["$$digit", 15] }, "then": "f" }
                            ],
                            "default": { "$toString": "$$digit" }
        } } } } } },
        { "$set": {
            "counter": {
                "$reduce": {
                    "input": "$counter",
                    "initialValue": "",
                    "in": { "$concat": ["$$value", "$$this"] }
        } } } },
        { "$set": {
            "counter": {
                "$map": {
                        "input": ["$counter"],
                        "as": "counter",
                        "in": { 
                            "$switch": {
                                "branches": [
                                    { "case": { "$eq": [{ "$strLenCP": "$$counter" }, 5] }, "then": { "$concat": ["0", "$$counter"] } },
                                    { "case": { "$eq": [{ "$strLenCP": "$$counter" }, 4] }, "then": { "$concat": ["00", "$$counter"] } },
                                    { "case": { "$eq": [{ "$strLenCP": "$$counter" }, 3] }, "then": { "$concat": ["000", "$$counter"] } },
                                    { "case": { "$eq": [{ "$strLenCP": "$$counter" }, 2] }, "then": { "$concat": ["0000", "$$counter"] } },
                                    { "case": { "$eq": [{ "$strLenCP": "$$counter" }, 1] }, "then": { "$concat": ["00000", "$$counter"] } },
                                    { "case": { "$eq": [{ "$strLenCP": "$$counter" }, 0] }, "then": "000000" }
                                ],
                                "default": "$$counter"
        } } } } } },
        { "$set": { "counter": { "$first": "$counter" } } },
        { "$set": { "ObjectId": { "$convert": { "input": { "$concat": ["$epoch", "$$nonce", "$counter"] }, "to": "objectId" } } } }
    ];

db.aggregate(pipeline, options);
