(() => {
   /*
    *  Name: "connStats.js"
    *  Version: "0.2.7"
    *  Description: "report detailed connection pooling statistics"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
    *
    *  Legacy archive line: v0.1.14 is the snapshot for the whole-tree freeze.
    *  Live mongosh line is v0.2.7. Handshake labels are in
    *  "Client handshake metadata.md".
    *
    *  v0.2.0 summary tag:
    *  - "client": an application MongoClient pool (pool, SDAM, and RTT together)
    *  - "internal": cluster egress. "class" is one NetworkInterfaceTL-* driver
    *    name, or the MongoDB Internal Client application name (MongoDB Shell,
    *    OplogFetcher, BenchRun, mongod-GRPCClient, mongos-GRPCClient, …)
    *
    *  v0.2.1: a pool whose authenticated users are only the srvatlas.sh
    *  hello probe users is internal. "class" is that user when the
    *  handshake did not already set one. A pool that also has an
    *  application user stays "client".
    *
    *  v0.2.2 retries $currentOp when the server rejects an option
    *  ("arg=<name> isn't allowed"). That option is dropped and the aggregate
    *  runs again. allUsers and idleConnections stay on when accepted.
    *  A missing inprog privilege still falls back to allUsers: false.
    *
    *  v0.2.3: unauth follows the same user@db string as authenticatedUsers.
    *  An empty effectiveUsers array is unprivileged, not authenticated.
    *
    *  v0.2.4 names the group's monitor mode before the per-socket rule:
    *  internal, streaming, poll, or quiet. The counts are unchanged.
    *
    *  v0.2.5 keeps those probe users in internalUsers, the one array
    *  $setIsSubset checks. The classification is unchanged.
    *
    *  v0.2.6 waits until this client's awaitable hello is visible, so the
    *  sample includes that socket's opid. The wait is bounded.
    *
    *  v0.2.7 splits a user-rule internal pool by application name. Those
    *  rows keep that name as appName. class stays the internal user.
    *  A handshake class is not split.
    */

   /*
    *  Notes:
    *  - mongosh only
    *  - requires "inprog" privileges to capture all connections, but supports fallback
    *  - a server that rejects a $currentOp option by name is retried without it
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
      /*
       *  srvatlas.sh hello probe users, stored here as user@db.
       *  __system@local is on-prem replication (local.__system).
       *  mms-automation@admin is Atlas and Atlas-gov automation
       *  (admin.mms-automation).
       */
      internalUsers = ["__system@local", "mms-automation@admin"],
      /*
       *  The monitor handshake makes the server selectable, then the driver
       *  waits minHeartbeatFrequencyMS (default 500) before the awaitable
       *  hello. This script can run in that gap. Poll until that hello is
       *  visible so its opid is in the sample.
       */
      monitorWaitMs = 1500,
      monitorPollMs = 100,
      aggOpts = {
         "comment": "connStats.js v0.2.7"
      },
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
            /*
             *  One user@db string. $concat is null when user or db is missing,
             *  including an empty effectiveUsers array, so that socket is
             *  unprivileged. unauth below is this string, not the raw path.
             */
            "user": {
               "$ifNull": [
                  { "$concat": [
                     { "$first": "$effectiveUsers.user" },
                     "@",
                     { "$first": "$effectiveUsers.db" }
                  ] },
                  "unprivileged"
               ]
            },
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
            "unauth": { "$eq": ["$user", "unprivileged"] }
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
                  "user": "$user"
            } }
         } },
         { "$set": {
            /*
             *  Decide the user-rule split before the sockets are separated.
             *  Idle mongot sockets omit effectiveUsers, so the split keeps
             *  the parent user list for those rows.
             */
            "authenticatedUsers": {
               "$setDifference": [
                  { "$setIntersection": [
                     "$connections.user",
                     "$connections.user"
                  ] },
                  ["unprivileged"]
               ]
            }
         } },
         { "$set": {
            "internalByUser": {
               "$and": [
                  { "$gt": [{ "$size": "$authenticatedUsers" }, 0] },
                  { "$setIsSubset": [
                     "$authenticatedUsers",
                     internalUsers
                  ] }
               ]
            }
         } },
         { "$unwind": "$connections" },
         { "$group": {
            "_id": {
               "host": "$_id.host",
               "client": "$_id.client",
               /*
                *  A user-rule internal pool has no handshake class. mongot's
                *  Java clients share endpoint, version, platform, and os, and
                *  differ by application name. Split those pools on that name.
                *  A handshake class, or a pool with an application user, stays
                *  one row so a custom appName does not separate its monitors.
                */
               "applicationName": {
                  "$cond": [
                     { "$and": [
                        "$internalByUser",
                        { "$eq": ["$_id.client.class", null] }
                     ] },
                     "$connections.applicationName",
                     null
                  ]
               }
            },
            "connections": { "$push": "$connections" },
            "parentInternalByUser": { "$first": "$internalByUser" },
            "parentUsers": { "$first": "$authenticatedUsers" }
         } },
         { "$set": {
            "host": "$_id.host",
            "srcIP": "$_id.client.endpoint",
            "driverVersion": "$_id.client.driverVersion",
            "platform": "$_id.client.platform",
            "os": "$_id.client.os",
            /*
             *  user@db from the sampled op. Idle sockets often have no
             *  effectiveUsers, so they stay "unprivileged" and drop out here.
             */
            "authenticatedUsers": {
               "$setDifference": [
                  { "$setIntersection": [
                     "$connections.user",
                     "$connections.user"
                  ] },
                  ["unprivileged"]
               ]
            },
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
             *  A pool that authenticates only as internalUsers is an
             *  internal system. An application user in the same pool
             *  keeps the client tag.
             */
            "internalByUser": {
               "$and": [
                  { "$gt": [{ "$size": "$authenticatedUsers" }, 0] },
                  { "$setIsSubset": [
                     "$authenticatedUsers",
                     internalUsers
                  ] }
               ]
            }
         } },
         { "$set": {
            "internal": {
               "$or": [
                  { "$ne": ["$_id.client.class", null] },
                  "$internalByUser",
                  "$parentInternalByUser"
               ]
            },
            /*
             *  Handshake class wins. Otherwise the internal user is the class.
             *  A split row whose own sockets are idle keeps the parent users.
             *  One user is the usual case. Several join in sample order.
             */
            "class": {
               "$let": {
                  "vars": {
                     "users": {
                        "$cond": [
                           "$internalByUser",
                           "$authenticatedUsers",
                           { "$cond": [
                              "$parentInternalByUser",
                              "$parentUsers",
                              []
                           ] }
                        ]
                     }
                  },
                  "in": {
                     "$cond": [
                        { "$ne": ["$_id.client.class", null] },
                        "$_id.client.class",
                        { "$cond": [
                           { "$gt": [{ "$size": "$$users" }, 0] },
                           { "$reduce": {
                              "input": "$$users",
                              "initialValue": "",
                              "in": {
                                 "$cond": [
                                    { "$eq": ["$$value", ""] },
                                    "$$this",
                                    { "$concat": ["$$value", ",", "$$this"] }
                                 ]
                              }
                           } },
                           null
                        ] }
                     ]
                  }
               }
            }
         } },
         { "$set": {
            /*
             *  One mode for the group, named before the per-socket rule.
             *  - internal: egress, or a pool that authenticates only as a
             *    system user. Hellos are not driver SDAM or RTT, so pools is 0.
             *  - streaming: any socket is an awaitable hello, or purpose sdam.
             *    Those sockets are sdam. Other unauthenticated sockets are
             *    idle RTT when the group also has an authenticated user;
             *    otherwise only a bare hello is RTT.
             *  - poll: nothing streaming, and the group has an authenticated
             *    user. Every unauthenticated socket is a poll-mode monitor.
             *  - quiet: nothing streaming and no authenticated user. Only a
             *    bare hello is a monitor. Idle sockets stay in the pool.
             */
            "mode": {
               "$switch": {
                  "branches": [
                     { "case": "$internal", "then": "internal" },
                     { "case": "$hasStreaming", "then": "streaming" },
                     { "case": "$hasAuth", "then": "poll" }
                  ],
                  "default": "quiet"
               }
            }
         } },
         { "$set": {
            "rows": {
               "$map": {
                  "input": "$connections",
                  "as": "connection",
                  "in": {
                     "$mergeObjects": [
                        "$$connection",
                        { "$switch": {
                           "branches": [
                              {
                                 "case": { "$eq": ["$mode", "internal"] },
                                 "then": { "sdam": false, "rtt": false }
                              },
                              {
                                 "case": { "$eq": ["$mode", "streaming"] },
                                 "then": {
                                    "sdam": "$$connection.streaming",
                                    "rtt": { "$and": [
                                       "$$connection.unauth",
                                       { "$not": "$$connection.streaming" },
                                       { "$or": ["$hasAuth", "$$connection.bare"] }
                                    ] }
                                 }
                              },
                              {
                                 "case": { "$eq": ["$mode", "poll"] },
                                 "then": { "sdam": "$$connection.unauth", "rtt": false }
                              }
                           ],
                           "default": { "sdam": "$$connection.bare", "rtt": false }
                        } }
                     ]
                  }
               }
            }
         } },
         { "$set": {
            "tag": { "$cond": ["$internal", "internal", "client"] },
            "appName": {
               "$cond": [
                  "$internal",
                  { "$ifNull": ["$_id.applicationName", "$class"] },
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
                           { "$max": "$rows.applicationName" }
                        ]
                     }
                  } }
               ]
            },
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
            "pools": { // SDAM sockets; poll mode can count two; 0 on an internal row
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
         // { "$match": { // post filter on the output document
            // "tag": "client",
            // "class": "NetworkInterfaceTL-ReplCoordExternNetwork",
            // "appName": { "$in": [/^greedyApp/, null] },
            // "appName": { "$in": [/^(?:mongosh|MongoDB Shell)/, null] }
         // } },
         { "$sort": { "totalConnections": -1 } },
         { "$unset": ["_id", "connections", "rows", "internal", "internalByUser", "parentInternalByUser", "parentUsers", "hasStreaming", "hasAuth", "mode"] }
      ];

   /*
    *  Atlas shared tiers name the rejected $currentOp field:
    *  "arg=<name> isn't allowed in this atlas tier".
    *  Drop that field and retry. Leave every other option in place.
    */
   function errorText(error) {
      return String((error && (error.errmsg || error.message)) || error);
   }

   function disallowedCurrentOpArg(error) {
      const found = errorText(error).match(/arg=([A-Za-z]+) isn't allowed/);
      if (!found) return null;
      const arg = found[1];
      if (!Object.prototype.hasOwnProperty.call(pipeline[0].$currentOp, arg)) return null;
      return arg;
   }

   function lacksInprog(error) {
      if (error && (error.code === 13 || error.codeName === "Unauthorized")) return true;
      const text = errorText(error);
      return /not authorized/i.test(text) || /requires authentication/i.test(text);
   }

   const omitted = [];
   let ownOpsOnly = false;

   function clientEndpoint(client) {
      const text = String(client || "");
      const bracket = text.match(/^\[([^\]]+)\]/);
      if (bracket) return bracket[1];
      const host = text.match(/^([^:]+)/);
      return host ? host[1] : "";
   }

   function sameHandshake(doc, self) {
      const left = doc.clientMetadata || {};
      const right = self.clientMetadata || {};
      const leftDriver = left.driver || {};
      const rightDriver = right.driver || {};
      const leftApp = left.application || {};
      const rightApp = right.application || {};
      return leftDriver.name === rightDriver.name
         && leftDriver.version === rightDriver.version
         && leftApp.name === rightApp.name
         && left.platform === right.platform
         && clientEndpoint(doc.client) === clientEndpoint(self.client);
   }

   function awaitableHello(doc) {
      const command = doc.command || {};
      if (command.maxAwaitTimeMS == null) return false;
      return !!(command.hello || command.isMaster || command.ismaster);
   }

   /*
    *  The probe is a separate aggregate so its comment identifies this
    *  client. Assign toArray() inside the try, same as the sample below.
    *  A tier or privilege error skips the wait; the sample retries it.
    */
   function ownMonitorIsWaiting() {
      let docs;
      try {
         docs = namespace.aggregate(
            [{ "$currentOp": pipeline[0].$currentOp }],
            { "comment": aggOpts.comment + " wait" }
         ).toArray();
      } catch (error) {
         return null;
      }
      const mark = aggOpts.comment + " wait";
      const self = docs.find(doc => doc.command && doc.command.comment === mark);
      if (!self) return false;
      return docs.some(doc => doc !== self && sameHandshake(doc, self) && awaitableHello(doc));
   }

   function waitForOwnMonitor() {
      const deadline = Date.now() + monitorWaitMs;
      for (;;) {
         const waiting = ownMonitorIsWaiting();
         if (waiting === null || waiting === true) return;
         if (Date.now() >= deadline) {
            console.error(
               "awaitable hello for this client was not visible within "
               + monitorWaitMs + "ms, sampling anyway"
            );
            return;
         }
         sleep(monitorPollMs);
      }
   }

   waitForOwnMonitor();

   /*
    *  The server validates $currentOp when the cursor is read.
    *  Assign toArray() inside the try. Returning the call lets mongosh
    *  await that promise outside the catch, so the retry never sees it.
    */
   function loadDocs() {
      const seen = {};
      for (;;) {
         try {
            const docs = namespace.aggregate(pipeline, aggOpts).toArray();
            return docs;
         } catch (error) {
            const arg = disallowedCurrentOpArg(error);
            if (arg && !seen[arg]) {
               seen[arg] = true;
               delete pipeline[0].$currentOp[arg];
               omitted.push(arg);
               console.error("$currentOp option " + arg + " is not allowed on this tier, retrying without it");
               continue;
            }
            if (pipeline[0].$currentOp.allUsers === true && lacksInprog(error)) {
               pipeline[0].$currentOp.allUsers = false;
               ownOpsOnly = true;
               console.error('User has no inprog privilege, falling back to { "allUsers": false }');
               continue;
            }
            throw error;
         }
      }
   }

   const docs = loadDocs();
   if (ownOpsOnly) console.log("PARTIAL: own ops only");
   if (omitted.length) console.log("PARTIAL: omitted " + omitted.join(", "));
   const scope = pipeline[0].$currentOp.allUsers === true ? "allUsers" : "ownOps";
   docs.forEach(doc => {
      console.log({ scope, ...doc });
   });
})();

// EOF
