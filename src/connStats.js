(() => {
   /*
    *  Name: "connStats.js"
    *  Version: "0.2.0"
    *  Description: "report detailed connection pooling statistics"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Legacy archive line: v0.1.14 is the snapshot for the whole-tree freeze.
    *  Live mongosh line is v0.2.0. Handshake labels are in
    *  "Client handshake metadata.md".
    *
    *  v0.2.0 summary tag:
    *  - "client": an application MongoClient pool (pool, SDAM, and RTT together)
    *  - "internal": cluster egress. "class" is one NetworkInterfaceTL-* driver
    *    name, or the MongoDB Internal Client application name (MongoDB Shell,
    *    OplogFetcher, BenchRun, mongod-GRPCClient, mongos-GRPCClient, …)
    */

   /*
    *  Notes:
    *  - mongosh only
    *  - requires "inprog" privileges to capture all connections, but supports fallback
    *  - statistics are per mongos/mongod as determined by the connection URI and readPreference
    *  - $currentOp client addresses: IPv4/hostname as host:port; IPv6 always bracketed as [addr]:port
    *  - empty "|" segments are dropped from driver.version before grouping, so an
    *    async PyMongo monitor joins its operation pool
    *  - client.purpose "sdam" / "rtt" wins when present (DRIVERS-3027). Absent today
    *  - libmongoc poll mode keeps two unauthenticated sockets per client until purpose
    *    distinguishes them, so "pools" can be double in that mode
    *
    *  TODO:
    *  - incorporate db.runCommand({ "whatsmyuri": 1}).you;
    *  - mongos targetAllNodes
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>connStats.js

   const namespace = db.getSiblingDB('admin'),
      aggOpts = {
         "comment": "connStats.js v0.2.0"
      },
      inprog = [
         { "$currentOp": { "allUsers": true } },
         { "$limit": 1 }
      ],
      pipeline = [
         { "$currentOp": {
            "allUsers": true,
            "localOps": (db.hello().msg === 'isdbgrid') ? true : false, // sharded option
            "idleConnections": true,
            "idleCursors": true,
            "idleSessions": true,
            // "targetAllNodes": (db.hello().msg === 'isdbgrid') ? true : false // TBA: sharded option for future feature on aggreaggte cluster connections
         } },
         { "$match": {
            "client": { "$exists": true } // minimum requirement to capture network client details
            // use post match filter for any other criteria to avoid bypassing the pool matching heuristics
         } },
         { "$set": {
            /*
             *  Parse $currentOp "client" into endpoint + ephemeralPort.
             *  Assumes IPv6 is always bracketed ([2001:db8::1]:54321); IPv4/host use a single host:port colon.
             */
            "clientParsed": {
               "$let": {
                  "vars": {
                     "m": {
                        "$regexFind": {
                           "input": "$client",
                           "regex": /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/
                  } } },
                  "in": {
                     "endpoint": {
                        "$ifNull": [
                           { "$arrayElemAt": ["$$m.captures", 0] }, // bracketed IPv6 (group 1)
                           { "$arrayElemAt": ["$$m.captures", 1] }  // IPv4 or hostname (group 2)
                     ] },
                     "ephemeralPort": {
                        "$toInt": { "$arrayElemAt": ["$$m.captures", 2] }
            } } } },
            /*
             *  Drop empty "|" version segments. Async PyMongo writes "VER|" or
             *  "VER||" on the operation pool and "VER" or "VER|" on the monitor.
             */
            "driverVersionKey": {
               "$let": {
                  "vars": {
                     "parts": {
                        "$split": [
                           { "$ifNull": ["$clientMetadata.driver.version", ""] },
                           "|"
                        ]
                     }
                  },
                  "in": {
                     "$reduce": {
                        "input": "$$parts",
                        "initialValue": "",
                        "in": {
                           "$cond": [
                              { "$eq": ["$$this", ""] },
                              "$$value",
                              { "$cond": [
                                 { "$eq": ["$$value", ""] },
                                 "$$this",
                                 { "$concat": ["$$value", "|", "$$this"] }
                              ] }
                           ]
                        }
                     }
                  }
               }
            },
            /*
             *  null for an application driver. A string splits cluster egress
             *  into one row per class. NetworkInterfaceTL is a prefix, not an
             *  exact driver name. MongoDB Internal Client classes differ by
             *  application name.
             */
            "poolClass": {
               "$let": {
                  "vars": {
                     "driverName": { "$ifNull": ["$clientMetadata.driver.name", ""] }
                  },
                  "in": {
                     "$switch": {
                        "branches": [
                           {
                              "case": {
                                 "$regexMatch": {
                                    "input": "$$driverName",
                                    "regex": /^NetworkInterfaceTL/
                                 }
                              },
                              "then": "$$driverName"
                           },
                           {
                              "case": { "$eq": ["$$driverName", "MongoDB Internal Client"] },
                              "then": {
                                 "$ifNull": [
                                    "$clientMetadata.application.name",
                                    "MongoDB Internal Client"
                                 ]
                              }
                           }
                        ],
                        "default": null
                     }
                  }
               }
            }
         } },
         { "$set": {
            "unauth": { "$not": { "$ifNull": ["$effectiveUsers.user", false] } },
            "hello": {
               "$or": [
                  "$command.hello",
                  "$command.isMaster",
                  "$command.ismaster"
               ]
            },
            "awaiting": { "$ifNull": ["$command.maxAwaitTimeMS", false] },
            "purpose": { "$ifNull": ["$clientMetadata.purpose", null] }
         } },
         { "$set": {
            // purpose wins over the command shape. ping is not a driver RTT signal.
            "streaming": {
               "$or": [
                  { "$eq": ["$purpose", "sdam"] },
                  { "$and": [
                     { "$ne": ["$purpose", "rtt"] },
                     "$unauth",
                     "$hello",
                     "$awaiting"
                  ] }
               ]
            },
            "bare": {
               "$or": [
                  { "$eq": ["$purpose", "rtt"] },
                  { "$and": [
                     { "$ne": ["$purpose", "sdam"] },
                     "$unauth",
                     "$hello",
                     { "$not": "$awaiting" }
                  ] }
               ]
            }
         } },
         { "$group": {
            "_id": {
               "host": "$host",
               "client": {
                  "endpoint": "$clientParsed.endpoint",
                  "driverVersion": "$driverVersionKey",
                  "platform": "$clientMetadata.platform",
                  "os": "$clientMetadata.os",
                  /*
                   *  Application drivers omit class. driver.name and
                   *  application.name can already differ inside one MongoClient,
                   *  and must not split the pool from its monitors.
                   *  Internal egress sets class, so each server pool stays its own row.
                   */
                  "class": "$poolClass"
            } },
            "connections": {
               "$push": {
                  "applicationName": { "$ifNull": ["$clientMetadata.application.name", "$clientMetadata.driver.name"] },
                  "driverName": { "$ifNull": ["$clientMetadata.driver.name", null] },
                  "connectionId": { "$ifNull": ["$connectionId", null] },
                  "ephemeralPort": "$clientParsed.ephemeralPort",
                  "opid": { "$ifNull": ["$opid", null] },
                  "active": "$active",
                  "secs_running": { "$ifNull": ["$secs_running", null] },
                  "streaming": "$streaming",
                  "bare": "$bare",
                  "unauth": "$unauth",
                  "user": {
                     "$ifNull": [
                        { "$concat": [
                           { "$first": "$effectiveUsers.user" },
                           "@",
                           { "$first": "$effectiveUsers.db" }
                        ] },
                        "unprivileged"
                  ] }
            } }
         } },
         { "$set": {
            "host": "$_id.host",
            "srcIP": "$_id.client.endpoint",
            "driverVersion": "$_id.client.driverVersion",
            "platform": "$_id.client.platform",
            "os": "$_id.client.os",
            "internal": { "$ne": ["$_id.client.class", null] },
            "hasStreaming": { "$anyElementTrue": "$connections.streaming" },
            "hasAuth": {
               "$anyElementTrue": {
                  "$map": {
                     "input": "$connections",
                     "as": "connection",
                     "in": { "$not": "$$connection.unauth" }
                  }
               }
            }
         } },
         { "$set": {
            /*
             *  Client rows only. Internal rows stay a pool of that class:
             *  their hellos are not driver SDAM or RTT.
             *  - any streaming socket: those are sdam. Other unauthenticated
             *    sockets are idle RTT when the group also has an authenticated
             *    user; otherwise only a bare hello is RTT.
             *  - no streaming socket, group has an authenticated user: every
             *    unauthenticated socket is a poll-mode monitor.
             *  - no streaming socket, no authenticated user: only a bare hello
             *    is a monitor. Idle sockets stay in the pool.
             */
            "rows": {
               "$map": {
                  "input": "$connections",
                  "as": "connection",
                  "in": {
                     "$mergeObjects": [
                        "$$connection",
                        { "$cond": [
                           "$internal",
                           { "sdam": false, "rtt": false },
                           { "$cond": [
                              "$hasStreaming",
                              {
                                 "sdam": "$$connection.streaming",
                                 "rtt": { "$and": [
                                    "$$connection.unauth",
                                    { "$not": "$$connection.streaming" },
                                    { "$or": ["$hasAuth", "$$connection.bare"] }
                                 ] }
                              },
                              { "$cond": [
                                 "$hasAuth",
                                 { "sdam": "$$connection.unauth", "rtt": false },
                                 { "sdam": "$$connection.bare", "rtt": false }
                              ] }
                           ] }
                        ] }
                     ]
                  }
               }
            }
         } },
         { "$set": {
            "tag": { "$cond": ["$internal", "internal", "client"] },
            "class": { "$cond": ["$internal", "$_id.client.class", null] },
            "appName": {
               "$cond": [
                  "$internal",
                  "$_id.client.class",
                  { "$let": {
                     "vars": {
                        "pooled": {
                           "$map": {
                              "input": {
                                 "$filter": {
                                    "input": "$rows",
                                    "as": "connection",
                                    "cond": { "$not": { "$or": ["$$connection.sdam", "$$connection.rtt"] } }
                                 }
                              },
                              "as": "connection",
                              "in": "$$connection.applicationName"
                           }
                        }
                     },
                     "in": {
                        "$cond": [
                           { "$gt": [{ "$size": "$$pooled" }, 0] },
                           { "$max": "$$pooled" },
                           { "$max": {
                              "$map": {
                                 "input": {
                                    "$filter": {
                                       "input": "$rows",
                                       "as": "connection",
                                       "cond": {
                                          "$not": {
                                             "$regexMatch": {
                                                "input": { "$ifNull": ["$$connection.driverName", ""] },
                                                "regex": /^NetworkInterfaceTL/
                                             }
                                          }
                                       }
                                    }
                                 },
                                 "as": "connection",
                                 "in": "$$connection.applicationName"
                              }
                           } }
                        ]
                     }
                  } }
               ]
            },
            "authenticatedUsers": {
               "$setDifference": [
                  { "$setIntersection": [
                     "$connections.user",
                     "$connections.user"
                  ] },
                  ["unprivileged"]
            ] },
            "activePooledConnections": {
               "$sum": {
                  "$map": {
                     "input": "$rows",
                     "as": "connection",
                     "in": {
                        "$cond": [
                           { "$and": [
                              { "$not": { "$or": ["$$connection.sdam", "$$connection.rtt"] } },
                              "$$connection.active"
                           ] },
                           1, 0
            ] } } } },
            "idlePooledConnections": {
               "$sum": {
                  "$map": {
                     "input": "$rows",
                     "as": "connection",
                     "in": {
                        "$cond": [
                           { "$and": [
                              { "$not": { "$or": ["$$connection.sdam", "$$connection.rtt"] } },
                              { "$not": "$$connection.active" }
                           ] },
                           1, 0
            ] } } } },
            "adminConnections": {
               "$sum": {
                  "$map": {
                     "input": "$rows",
                     "as": "connection",
                     "in": {
                        "$cond": [
                           { "$or": ["$$connection.sdam", "$$connection.rtt"] },
                           1, 0
            ] } } } },
            "pools": { // distinct MongoClient() instances; 0 on an internal row
               "$sum": {
                  "$map": {
                     "input": "$rows",
                     "as": "connection",
                     "in": { "$cond": ["$$connection.sdam", 1, 0] }
            } } },
            "MongoClientOpids": {
               "$map": {
                  "input": {
                     "$filter": {
                        "input": "$rows",
                        "as": "connection",
                        "cond": "$$connection.sdam"
                     } },
                  "as": "sdam",
                  "in": "$$sdam.opid"
            } },
            "sdamConnectionIds": {
               "$map": {
                  "input": {
                     "$filter": {
                        "input": "$rows",
                        "as": "connection",
                        "cond": "$$connection.sdam"
                     } },
                  "as": "sdam",
                  "in": "$$sdam.connectionId"
            } },
            "rttConnectionIds": {
               "$map": {
                  "input": {
                     "$filter": {
                        "input": "$rows",
                        "as": "connection",
                        "cond": "$$connection.rtt"
                     } },
                  "as": "rtt",
                  "in": "$$rtt.connectionId"
            } },
            "totalConnections": { "$size": "$connections" }
         } },
         // { "$match": { // post filter recommended on derived pool metrics
            // "tag": "client",
            // "class": "NetworkInterfaceTL-ReplCoordExternNetwork",
            // "appName": { "$in": [/^greedyApp/, null] },
            // "appName": { "$in": [/^(?:mongosh|MongoDB Shell)/, null] },
            // "ns": /^admin/,
            // "secs_running": { "$gte": 0 }
         // } },
         { "$sort": { "totalConnections": -1 } },
         { "$unset": ["_id", "connections", "rows", "internal", "hasStreaming", "hasAuth"] }
      ];

   function hasInprog() {
      try {
         namespace.aggregate(inprog, aggOpts).toArray();
         return true;
      } catch(e) {
         return false;
      }
   }

   const allUsers = hasInprog();
   if (!allUsers) {
      console.error('User has no inprog privilege, falling back to { "allUsers": false }');
      console.log('PARTIAL: own ops only');
      pipeline[0].$currentOp.allUsers = false;
   }

   const scope = allUsers ? "allUsers" : "ownOps";
   namespace.aggregate(pipeline, aggOpts).forEach(doc => {
      console.log({ scope, ...doc });
   });
})();

// EOF
