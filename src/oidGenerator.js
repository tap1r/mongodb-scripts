/*
 *  Name: "oidGenerator.js"
 *  Version: "0.2.5"
 *  Description: Aggregation based OID generator (requires v5.0+)
 *  Disclaimer: https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md
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
         { "timestamp": "1234" },
         { "timestamp": 65536 },
         { "timestamp": Math.pow(2, 32) },
         { "timestamp": "$$NOW" }
      ] },
      // 4-byte epoch timestamp
      { "$set": {
         "_epoch": {
            "$convert": {
               "input": {
                  "$divide": [
                     { "$trunc": [
                        { "$convert": { "input": "$timestamp", "to": "long" } },
                        -3
                     ] },
                     1000
                  ] },
               "to": "int"
      } } } },
      { "$set": {
         "_epoch": {
            "$reduce": {
               "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$_epoch", 1] }, 16] } }] }, // scale
               "initialValue": {
                  "quotient": { "$floor": { "$divide": ["$_epoch", 16] } },
                  "remainder": { "$mod": ["$_epoch", 16] },
                  "hexArray": []
               },
               "in": {
                  "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
                  "remainder": { "$mod": ["$$value.quotient", 16] },
                  "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
      } } } } },
      { "$set": {
         "_epoch": {
            "$first": {
               "$map": {
                  "input": [{
                     "$reduce": {
                        "input": {
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
                        } } } },
                        "initialValue": "",
                        "in": { "$concat": ["$$value", "$$this"] }
                  } }],
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
      } } } } } } },
      // 5-byte machine nonce - set via $let option
      // { "$set": { "_nonce": "$$nonce" } }, // alternatively set directly
      // 3-byte randomly initialised 'counter'
      { "$set": { "_counter": { "$floor": { "$multiply": [{ "$rand": {} }, { "$pow": [2, 24] }] } } } },
      { "$set": {
         "_counter": {
            "$reduce": {
               "input": { "$range": [0, { "$ceil": { "$log": [{ "$add": ["$_counter", 1] }, 16] } }] }, // scale
               "initialValue": {
                  "quotient": { "$floor": { "$divide": ["$_counter", 16] } },
                  "remainder": { "$mod": ["$_counter", 16] },
                  "hexArray": []
               },
               "in": {
                  "quotient": { "$floor": { "$divide": ["$$value.quotient", 16] } },
                  "remainder": { "$mod": ["$$value.quotient", 16] },
                  "hexArray": { "$concatArrays": ["$$value.hexArray", [{ "$floor": "$$value.remainder" }]] }
      } } } } },
      { "$set": {
         "_counter": {
            "$first": {
               "$map": {
                  "input": [{
                     "$reduce": {
                        "input": {
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
                        } } } },
                        "initialValue": "",
                        "in": { "$concat": ["$$value", "$$this"] }
                  } }],
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
      } } } } } } },
      { "$set": { "ObjectId": { "$convert": { "input": { "$concat": ["$_epoch", "$$nonce", "$_counter"] }, "to": "objectId" } } } },
      { "$unset": ["_epoch", "_nonce", "_counter"] }
    ];

db.aggregate(pipeline, options);
