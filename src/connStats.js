(() => {
   /*
    *  Name: "connStats.js"
    *  Version: "0.2.14"
    *  Description: "report detailed connection pooling statistics"
    *  Disclaimer: "https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/DISCLAIMER.md"
    *  Authors: ["tap1r <luke.prochazka@gmail.com>"]
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
    *  - rows that share a client ephemeral port are gRPC streams on one channel.
    *    "channels" counts those ports. A channel is not a pool, so its streams
    *    are left out of activePooledConnections, idlePooledConnections,
    *    adminConnections, and pools. A channel with any active stream is an
    *    active channel. "sockets" still includes the channel. "streams" counts
    *    the shared rows. A row alone is a socket and not a channel.
    *    "totalConnections" remains the row count
    *  - tag is cluster, fabric, or client. cluster is native mongos/mongod
    *    sharding and replication. fabric is an in-deployment service.
    *    A rollup sums sockets for the sample and for each tag
    *  - application name "MongoDB Shell" on driver "MongoDB Internal Client" is
    *    a client. Other Internal Client names are cluster classes
    *  - an application name "mongot" or "mongot …", or a driver.name segment
    *    mongot-sync, is fabric. The class is the application name when set
    *  - Spark, Kafka, and the database tools keep a named class and are tagged
    *    client: the segment from mongo-spark, mongo-spark-connector, or
    *    mongo-kafka through the end of driver.name, or the application name
    *    mongodump, mongorestore, mongoexport, mongoimport, mongostat, mongotop,
    *    mongofiles. mongosh and Compass stay application clients
    *  - a pool that authenticates only as __system@local is cluster, unless the
    *    handshake already said fabric. mms-automation@admin alone is fabric
    *  - a non-interactive application client sourced from this process is fabric.
    *    The address list is hello.me, this member's host and horizons, non-wildcard
    *    bindIp, and loopback. Peer members are omitted. Hostnames are not resolved.
    *    mongosh, MongoDB Shell, and Compass stay client
    *  - a cluster row forces pools to 0. A fabric row keeps driver SDAM
    *
    *  TODO:
    *  - incorporate db.runCommand({ "whatsmyuri": 1}).you;
    *  - mongos targetAllNodes
    */

   // Usage: mongosh [connection options] [--quiet] [-f|--file] </path/to/>connStats.js

   /*
    *  Host or host:port, or a bracketed IPv6 address. Wildcard binds are not
    *  this process. localhost and 127.0.0.1 name the same loopback source.
    */
   function endpointHost(value) {
      const text = String(value || "").trim();
      if (!text) return "";
      const bracket = text.match(/^\[([^\]]+)\](?::\d+)?$/);
      if (bracket) return bracket[1];
      const single = text.match(/^([^:]+):(\d+)$/);
      if (single) return single[1];
      return text;
   }

   function addAddr(found, value) {
      const host = endpointHost(value).toLowerCase();
      if (!host || host === "0.0.0.0" || host === "::" || host === "*") return;
      found.add(host);
      if (host === "localhost") found.add("127.0.0.1");
      if (host === "127.0.0.1") found.add("localhost");
   }

   /*
    *  Addresses of this process only. hello.me selects the rs.conf member;
    *  other members stay out of the list. A hostname is stored as written.
    *  Resolving it here would use the shell's DNS view, which is not the
    *  server's private address when the shell is remote. getCmdLineOpts and
    *  rs.conf() are optional. A failure leaves loopback, and metadata still
    *  classifies the row. bindIpAll does not enumerate interface addresses.
    */
   function discoverLocalAddrs() {
      const found = new Set(["127.0.0.1", "::1", "localhost"]);
      let me = "";
      try {
         me = String((db.hello() || {}).me || "");
         addAddr(found, me);
      } catch (error) {
         me = "";
      }
      try {
         const opts = db.adminCommand({ "getCmdLineOpts": 1 });
         const net = (opts && opts.parsed && opts.parsed.net) || {};
         const bindIp = net.bindIp;
         if (typeof bindIp === "string") {
            bindIp.split(/[,\s]+/).forEach(part => addAddr(found, part));
         } else if (Array.isArray(bindIp)) {
            bindIp.forEach(part => addAddr(found, part));
         }
      } catch (error) {
         // unauthorized or unsupported
      }
      try {
         const conf = rs.conf();
         const members = (conf && conf.members) || [];
         const self = me
            ? members.find(member => member && String(member.host).toLowerCase() === me.toLowerCase())
            : null;
         if (self) {
            addAddr(found, self.host);
            const horizons = self.horizons || {};
            Object.keys(horizons).forEach(name => addAddr(found, horizons[name]));
         }
      } catch (error) {
         // mongos and standalones have no replica set config
      }
      return [...found];
   }

   const namespace = db.getSiblingDB('admin'),
      /*
       *  srvatlas.sh hello probe users, stored here as user@db.
       *  __system@local is on-prem replication (local.__system).
       *  A pool that authenticates only as this user is cluster when the
       *  handshake did not already say fabric.
       */
      clusterUsers = ["__system@local"],
      /*
       *  mms-automation@admin is Atlas and Atlas-gov automation
       *  (admin.mms-automation). Alone, that pool is fabric.
       */
      fabricUsers = ["mms-automation@admin"],
      /*
       *  Either system user still splits an application pool by name.
       *  A pool that also has an application user stays a client.
       */
      systemUsers = clusterUsers.concat(fabricUsers),
      /*
       *  Handshake class for an application driver. Cluster egress replaces
       *  it with the NetworkInterfaceTL name or the Internal Client role.
       *  Fabric metadata replaces it with the mongot application name.
       *  The user rule can still replace the printed class with the user
       *  when the handshake class stays application.
       */
      applicationClass = "application",
      /*
       *  Database tools force this application name (mongo-tools options.New).
       *  A customer URI that copies one of these names takes the same class.
       */
      productAppNames = [
         "mongodump",
         "mongorestore",
         "mongoexport",
         "mongoimport",
         "mongostat",
         "mongotop",
         "mongofiles"
      ],
      /*
       *  The monitor handshake makes the server selectable, then the driver
       *  waits minHeartbeatFrequencyMS (default 500) before the awaitable
       *  hello. This script can run in that gap. Poll until that hello is
       *  visible so its opid is in the sample.
       */
      monitorWaitMs = 1500,
      monitorPollMs = 100,
      /*
       *  This process's own addresses. A non-interactive application client
       *  sourced from one of these is fabric. Peer replica-set members are
       *  not included. Hostnames are kept as written and are not resolved.
       */
      localAddrs = discoverLocalAddrs(),
      aggOpts = {
         "comment": "connStats.js v0.2.14"
      },
      pipeline = [
         {
            "$currentOp": {
               "allUsers": true,
               "localOps": (db.hello().msg === 'isdbgrid') ? true : false, // sharded option
               "idleConnections": true,
               "idleCursors": true,
               "idleSessions": true,
               // "targetAllNodes": (db.hello().msg === 'isdbgrid') ? true : false // TBA: sharded option for future feature on aggreaggte cluster connections
            }
         },
         {
            "$match": {
               "client": { "$exists": true } // minimum requirement to capture network client details
               // use post match filter for any other criteria to avoid bypassing the pool matching heuristics
            }
         },
         {
            "$set": {
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
                           }
                        }
                     },
                     "in": {
                        "endpoint": {
                           "$ifNull": [
                              { "$arrayElemAt": ["$$m.captures", 0] }, // bracketed IPv6 (group 1)
                              { "$arrayElemAt": ["$$m.captures", 1] }  // IPv4 or hostname (group 2)
                           ]
                        },
                        "ephemeralPort": {
                           "$toInt": { "$arrayElemAt": ["$$m.captures", 2] }
                        }
                     }
                  }
               },
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
                                 {
                                    "$cond": [
                                       { "$eq": ["$$value", ""] },
                                       "$$this",
                                       { "$concat": ["$$value", "|", "$$this"] }
                                    ]
                                 }
                              ]
                           }
                        }
                     }
                  }
               },
               /*
                *  class splits one endpoint into rows. kind is cluster, fabric,
                *  or client, and rides along because a class string can be reused.
                *  NetworkInterfaceTL is a prefix, not an exact driver name.
                *  MongoDB Internal Client classes differ by application name.
                *  The legacy shell's default name, "MongoDB Shell", is a client.
                *  A URI appName on that shell is not this name.
                *  mongot is the application name, or the mongot-sync segment when
                *  the name is absent. "|sync" is the Java sync driver, not mongot.
                *  Spark and Kafka keep the driver.name segment as class. Database
                *  tools keep the application name they force. Both are clients.
                */
               "pool": {
                  "$let": {
                     "vars": {
                        "driverName": { "$ifNull": ["$clientMetadata.driver.name", ""] },
                        "applicationName": {
                           "$ifNull": [
                              "$clientMetadata.application.name",
                              "MongoDB Internal Client"
                           ]
                        },
                        "mongotMatch": {
                           "$regexFind": {
                              "input": { "$ifNull": ["$clientMetadata.driver.name", ""] },
                              "regex": /(?:^|\|)(mongot-sync)(\|.*)?$/
                           }
                        },
                        "productMatch": {
                           "$regexFind": {
                              "input": { "$ifNull": ["$clientMetadata.driver.name", ""] },
                              "regex": /(?:^|\|)(mongo-spark-connector|mongo-spark|mongo-kafka)(\|.*)?$/
                           }
                        }
                     },
                     "in": {
                        "$let": {
                           "vars": {
                              "mongotClass": {
                                 "$cond": [
                                    { "$eq": ["$$mongotMatch", null] },
                                    null,
                                    {
                                       "$concat": [
                                          { "$arrayElemAt": ["$$mongotMatch.captures", 0] },
                                          {
                                             "$ifNull": [
                                                { "$arrayElemAt": ["$$mongotMatch.captures", 1] },
                                                ""
                                             ]
                                          }
                                       ]
                                    }
                                 ]
                              },
                              "productClass": {
                                 "$cond": [
                                    { "$eq": ["$$productMatch", null] },
                                    null,
                                    {
                                       "$concat": [
                                          { "$arrayElemAt": ["$$productMatch.captures", 0] },
                                          {
                                             "$ifNull": [
                                                { "$arrayElemAt": ["$$productMatch.captures", 1] },
                                                ""
                                             ]
                                          }
                                       ]
                                    }
                                 ]
                              }
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
                                       "then": { "class": "$$driverName", "kind": "cluster" }
                                    },
                                    {
                                       "case": {
                                          "$and": [
                                             { "$eq": ["$$driverName", "MongoDB Internal Client"] },
                                             { "$ne": ["$$applicationName", "MongoDB Shell"] }
                                          ]
                                       },
                                       "then": { "class": "$$applicationName", "kind": "cluster" }
                                    },
                                    {
                                       "case": {
                                          "$regexMatch": {
                                             "input": {
                                                "$ifNull": ["$clientMetadata.application.name", ""]
                                             },
                                             "regex": /^mongot( |$)/
                                          }
                                       },
                                       "then": {
                                          "class": "$clientMetadata.application.name",
                                          "kind": "fabric"
                                       }
                                    },
                                    {
                                       "case": { "$ne": ["$$mongotClass", null] },
                                       "then": { "class": "$$mongotClass", "kind": "fabric" }
                                    },
                                    {
                                       "case": { "$ne": ["$$productClass", null] },
                                       "then": { "class": "$$productClass", "kind": "client" }
                                    },
                                    {
                                       "case": { "$in": ["$$applicationName", productAppNames] },
                                       "then": { "class": "$$applicationName", "kind": "client" }
                                    }
                                 ],
                                 "default": { "class": applicationClass, "kind": "client" }
                              }
                           }
                        }
                     }
                  }
               }
            }
         },
         {
            "$set": {
               "poolClass": "$pool.class",
               "poolKind": "$pool.kind"
            }
         },
         {
            "$set": {
               /*
                *  One user@db string. $concat is null when user or db is missing,
                *  including an empty effectiveUsers array, so that socket is
                *  unprivileged. unauth below is this string, not the raw path.
                */
               "user": {
                  "$ifNull": [
                     {
                        "$concat": [
                           { "$first": "$effectiveUsers.user" },
                           "@",
                           { "$first": "$effectiveUsers.db" }
                        ]
                     },
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
            }
         },
         {
            "$set": {
               "unauth": { "$eq": ["$user", "unprivileged"] }
            }
         },
         {
            "$set": {
               // purpose wins over the command shape. ping is not a driver RTT signal.
               "streaming": {
                  "$or": [
                     { "$eq": ["$purpose", "sdam"] },
                     {
                        "$and": [
                           { "$ne": ["$purpose", "rtt"] },
                           "$unauth",
                           "$hello",
                           "$awaiting"
                        ]
                     }
                  ]
               },
               "bare": {
                  "$or": [
                     { "$eq": ["$purpose", "rtt"] },
                     {
                        "$and": [
                           { "$ne": ["$purpose", "sdam"] },
                           "$unauth",
                           "$hello",
                           { "$not": "$awaiting" }
                        ]
                     }
                  ]
               }
            }
         },
         {
            "$group": {
               "_id": {
                  "host": "$host",
                  "client": {
                     "endpoint": "$clientParsed.endpoint",
                     "driverVersion": "$driverVersionKey",
                     "platform": "$clientMetadata.platform",
                     "os": "$clientMetadata.os",
                     /*
                      *  Application drivers share class "application". driver.name and
                      *  application.name can already differ inside one MongoClient,
                      *  and must not split the pool from its monitors.
                      *  Cluster and fabric egress set their own class, so each of
                      *  those pools stays its own row. kind travels with the class
                      *  because the printed class string is not the tag.
                      */
                     "class": "$poolClass",
                     "kind": "$poolKind"
                  }
               },
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
                  }
               }
            }
         },
         {
            "$set": {
               /*
                *  Decide the user-rule split before the sockets are separated.
                *  Idle mongot sockets omit effectiveUsers, so the split keeps
                *  the parent user list for those rows.
                */
               "authenticatedUsers": {
                  "$setDifference": [
                     {
                        "$setIntersection": [
                           "$connections.user",
                           "$connections.user"
                        ]
                     },
                     ["unprivileged"]
                  ]
               }
            }
         },
         {
            "$set": {
               "systemByUser": {
                  "$and": [
                     { "$gt": [{ "$size": "$authenticatedUsers" }, 0] },
                     {
                        "$setIsSubset": [
                           "$authenticatedUsers",
                           systemUsers
                        ]
                     }
                  ]
               }
            }
         },
         { "$unwind": "$connections" },
         {
            "$group": {
               "_id": {
                  "host": "$_id.host",
                  "client": "$_id.client",
                  /*
                   *  A user-rule pool has class "application" and only system
                   *  users. Those clients can share endpoint, version, platform,
                   *  and os, and differ by application name. Split them on that
                   *  name. A handshake class, including mongot, or a pool with an
                   *  application user, stays one row so a custom appName does not
                   *  separate its monitors.
                   */
                  "applicationName": {
                     "$cond": [
                        {
                           "$and": [
                              "$systemByUser",
                              { "$eq": ["$_id.client.class", applicationClass] }
                           ]
                        },
                        "$connections.applicationName",
                        null
                     ]
                  }
               },
               "connections": { "$push": "$connections" },
               "parentSystemByUser": { "$first": "$systemByUser" },
               "parentUsers": { "$first": "$authenticatedUsers" }
            }
         },
         {
            "$set": {
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
                     {
                        "$setIntersection": [
                           "$connections.user",
                           "$connections.user"
                        ]
                     },
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
               },
               /*
                *  Interactive clients stay client even when they connect to
                *  this process. One matching socket covers the group.
                */
               "interactive": {
                  "$anyElementTrue": {
                     "$map": {
                        "input": "$connections",
                        "as": "connection",
                        "in": {
                           "$or": [
                              {
                                 "$regexMatch": {
                                    "input": { "$ifNull": ["$$connection.driverName", ""] },
                                    "regex": /(?:^|\|)mongosh(?:\||$)/
                                 }
                              },
                              { "$eq": ["$$connection.applicationName", "MongoDB Shell"] },
                              {
                                 "$regexMatch": {
                                    "input": { "$ifNull": ["$$connection.applicationName", ""] },
                                    "regex": /^mongosh( |$)/
                                 }
                              },
                              {
                                 "$regexMatch": {
                                    "input": { "$ifNull": ["$$connection.applicationName", ""] },
                                    "regex": /^MongoDB Compass/
                                 }
                              }
                           ]
                        }
                     }
                  }
               }
            }
         },
         {
            "$set": {
               /*
                *  A pool that authenticates only as systemUsers is a system
                *  pool. An application user in the same pool keeps the client
                *  tag unless a later rule says otherwise.
                */
               "systemByUser": {
                  "$and": [
                     { "$gt": [{ "$size": "$authenticatedUsers" }, 0] },
                     {
                        "$setIsSubset": [
                           "$authenticatedUsers",
                           systemUsers
                        ]
                     }
                  ]
               }
            }
         },
         {
            "$set": {
               /*
                *  Idle split rows omit effectiveUsers. Keep the parent users
                *  so the kind and the printed class still see them.
                */
               "ruleUsers": {
                  "$cond": [
                     "$systemByUser",
                     "$authenticatedUsers",
                     {
                        "$cond": [
                           "$parentSystemByUser",
                           "$parentUsers",
                           []
                        ]
                     }
                  ]
               }
            }
         },
         {
            "$set": {
               /*
                *  A handshake class wins. "application" is not one.
                *  Otherwise the system user is the class. A split row whose
                *  own sockets are idle keeps the parent users. One user is
                *  the usual case. Several join in sample order. A client row
                *  stays "application".
                */
               "class": {
                  "$cond": [
                     { "$ne": ["$_id.client.class", applicationClass] },
                     "$_id.client.class",
                     {
                        "$cond": [
                           { "$gt": [{ "$size": "$ruleUsers" }, 0] },
                           {
                              "$reduce": {
                                 "input": "$ruleUsers",
                                 "initialValue": "",
                                 "in": {
                                    "$cond": [
                                       { "$eq": ["$$value", ""] },
                                       "$$this",
                                       { "$concat": ["$$value", ",", "$$this"] }
                                    ]
                                 }
                              }
                           },
                           applicationClass
                        ]
                     }
                  ]
               }
            }
         },
         {
            "$set": {
               /*
                *  Handshake kind wins, so mongot stays fabric while it
                *  authenticates as __system@local. A remaining application
                *  pool is cluster when any user is __system@local, fabric when
                *  the only user is mms-automation@admin, and fabric when the
                *  source is this process and the client is not interactive.
                */
               "kind": {
                  "$switch": {
                     "branches": [
                        {
                           "case": { "$eq": ["$_id.client.kind", "cluster"] },
                           "then": "cluster"
                        },
                        {
                           "case": { "$eq": ["$_id.client.kind", "fabric"] },
                           "then": "fabric"
                        },
                        {
                           "case": {
                              "$and": [
                                 { "$eq": ["$_id.client.class", applicationClass] },
                                 { "$gt": [{ "$size": "$ruleUsers" }, 0] },
                                 { "$setIsSubset": ["$ruleUsers", systemUsers] },
                                 {
                                    "$gt": [
                                       {
                                          "$size": {
                                             "$setIntersection": ["$ruleUsers", clusterUsers]
                                          }
                                       },
                                       0
                                    ]
                                 }
                              ]
                           },
                           "then": "cluster"
                        },
                        {
                           "case": {
                              "$and": [
                                 { "$eq": ["$_id.client.class", applicationClass] },
                                 { "$gt": [{ "$size": "$ruleUsers" }, 0] },
                                 { "$setIsSubset": ["$ruleUsers", fabricUsers] }
                              ]
                           },
                           "then": "fabric"
                        },
                        {
                           "case": {
                              "$and": [
                                 { "$eq": ["$_id.client.class", applicationClass] },
                                 { "$not": "$interactive" },
                                 {
                                    "$in": [
                                       { "$toLower": { "$ifNull": ["$srcIP", ""] } },
                                       localAddrs
                                    ]
                                 }
                              ]
                           },
                           "then": "fabric"
                        }
                     ],
                     "default": "client"
                  }
               }
            }
         },
         {
            "$set": {
               /*
                *  One mode for the group, named before the per-socket rule.
                *  - cluster: native sharding and replication, or a pool that
                *    authenticates only as __system@local. Hellos are not driver
                *    SDAM or RTT, so pools is 0.
                *  - streaming: any socket is an awaitable hello, or purpose sdam.
                *    Those sockets are sdam. Other unauthenticated sockets are
                *    idle RTT when the group also has an authenticated user;
                *    otherwise only a bare hello is RTT. Fabric drivers use this
                *    path, so their pools still count.
                *  - poll: nothing streaming, and the group has an authenticated
                *    user. Every unauthenticated socket is a poll-mode monitor.
                *  - quiet: nothing streaming and no authenticated user. Only a
                *    bare hello is a monitor. Idle sockets stay in the pool.
                */
               "mode": {
                  "$switch": {
                     "branches": [
                        { "case": { "$eq": ["$kind", "cluster"] }, "then": "cluster" },
                        { "case": "$hasStreaming", "then": "streaming" },
                        { "case": "$hasAuth", "then": "poll" }
                     ],
                     "default": "quiet"
                  }
               }
            }
         },
         {
            "$set": {
               "rows": {
                  "$map": {
                     "input": "$connections",
                     "as": "connection",
                     "in": {
                        "$mergeObjects": [
                           "$$connection",
                           {
                              "socketKey": {
                                 "$ifNull": [
                                    { "$toString": "$$connection.ephemeralPort" },
                                    {
                                       "$concat": [
                                          "conn:",
                                          { "$toString": { "$ifNull": ["$$connection.connectionId", ""] } }
                                       ]
                                    }
                                 ]
                              }
                           },
                           {
                              "$switch": {
                                 "branches": [
                                    {
                                       "case": { "$eq": ["$mode", "cluster"] },
                                       "then": { "sdam": false, "rtt": false }
                                    },
                                    {
                                       "case": { "$eq": ["$mode", "streaming"] },
                                       "then": {
                                          "sdam": "$$connection.streaming",
                                          "rtt": {
                                             "$and": [
                                                "$$connection.unauth",
                                                { "$not": "$$connection.streaming" },
                                                { "$or": ["$hasAuth", "$$connection.bare"] }
                                             ]
                                          }
                                       }
                                    },
                                    {
                                       "case": { "$eq": ["$mode", "poll"] },
                                       "then": { "sdam": "$$connection.unauth", "rtt": false }
                                    }
                                 ],
                                 "default": { "sdam": "$$connection.bare", "rtt": false }
                              }
                           }
                        ]
                     }
                  }
               }
            }
         },
         {
            "$set": {
               /*
                *  One socket is one client ephemeral port. Rows that share a port
                *  are streams on one gRPC channel. A missing port stays its own
                *  socket via connectionId, so it is not a channel.
                */
               "socketKeys": "$rows.socketKey",
               "channelKeys": {
                  "$setUnion": [
                     {
                        "$filter": {
                           "input": "$rows.socketKey",
                           "as": "key",
                           "cond": {
                              "$gt": [
                                 {
                                    "$size": {
                                       "$filter": {
                                          "input": "$rows.socketKey",
                                          "as": "peer",
                                          "cond": { "$eq": ["$$peer", "$$key"] }
                                       }
                                    }
                                 },
                                 1
                              ]
                           }
                        }
                     },
                     []
                  ]
               }
            }
         },
         {
            "$set": {
               "tag": "$kind",
               "appName": {
                  "$cond": [
                     {
                        "$or": [
                           { "$eq": ["$kind", "cluster"] },
                           {
                              "$and": [
                                 { "$eq": ["$kind", "fabric"] },
                                 { "$ne": ["$class", applicationClass] }
                              ]
                           },
                           { "$ne": ["$_id.applicationName", null] }
                        ]
                     },
                     { "$ifNull": ["$_id.applicationName", "$class"] },
                     {
                        "$let": {
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
                        }
                     }
                  ]
               },
               "activePooledConnections": {
                  "$sum": {
                     "$map": {
                        "input": "$rows",
                        "as": "connection",
                        "in": {
                           "$cond": [
                              {
                                 "$and": [
                                    { "$not": { "$in": ["$$connection.socketKey", "$channelKeys"] } },
                                    { "$not": { "$or": ["$$connection.sdam", "$$connection.rtt"] } },
                                    "$$connection.active"
                                 ]
                              },
                              1, 0
                           ]
                        }
                     }
                  }
               },
               "idlePooledConnections": {
                  "$sum": {
                     "$map": {
                        "input": "$rows",
                        "as": "connection",
                        "in": {
                           "$cond": [
                              {
                                 "$and": [
                                    { "$not": { "$in": ["$$connection.socketKey", "$channelKeys"] } },
                                    { "$not": { "$or": ["$$connection.sdam", "$$connection.rtt"] } },
                                    { "$not": "$$connection.active" }
                                 ]
                              },
                              1, 0
                           ]
                        }
                     }
                  }
               },
               "adminConnections": {
                  "$sum": {
                     "$map": {
                        "input": "$rows",
                        "as": "connection",
                        "in": {
                           "$cond": [
                              {
                                 "$and": [
                                    { "$not": { "$in": ["$$connection.socketKey", "$channelKeys"] } },
                                    { "$or": ["$$connection.sdam", "$$connection.rtt"] }
                                 ]
                              },
                              1, 0
                           ]
                        }
                     }
                  }
               },
               "pools": { // SDAM sockets; poll mode can count two; 0 on a cluster row. A gRPC channel is not a pool.
                  "$sum": {
                     "$map": {
                        "input": "$rows",
                        "as": "connection",
                        "in": {
                           "$cond": [
                              {
                                 "$and": [
                                    { "$not": { "$in": ["$$connection.socketKey", "$channelKeys"] } },
                                    "$$connection.sdam"
                                 ]
                              },
                              1, 0
                           ]
                        }
                     }
                  }
               },
               "channels": { "$size": { "$setUnion": ["$channelKeys", []] } },
               "activeChannels": {
                  "$size": {
                     "$setUnion": [
                        {
                           "$map": {
                              "input": {
                                 "$filter": {
                                    "input": "$rows",
                                    "as": "connection",
                                    "cond": {
                                       "$and": [
                                          { "$in": ["$$connection.socketKey", "$channelKeys"] },
                                          "$$connection.active"
                                       ]
                                    }
                                 }
                              },
                              "as": "connection",
                              "in": "$$connection.socketKey"
                           }
                        },
                        []
                     ]
                  }
               },
               "idleChannels": {
                  "$size": {
                     "$setDifference": [
                        { "$setUnion": ["$channelKeys", []] },
                        {
                           "$setUnion": [
                              {
                                 "$map": {
                                    "input": {
                                       "$filter": {
                                          "input": "$rows",
                                          "as": "connection",
                                          "cond": {
                                             "$and": [
                                                { "$in": ["$$connection.socketKey", "$channelKeys"] },
                                                "$$connection.active"
                                             ]
                                          }
                                       }
                                    },
                                    "as": "connection",
                                    "in": "$$connection.socketKey"
                                 }
                              },
                              []
                           ]
                        }
                     ]
                  }
               },
               "MongoClientOpids": {
                  "$map": {
                     "input": {
                        "$filter": {
                           "input": "$rows",
                           "as": "connection",
                           "cond": "$$connection.sdam"
                        }
                     },
                     "as": "sdam",
                     "in": "$$sdam.opid"
                  }
               },
               "sdamConnectionIds": {
                  "$map": {
                     "input": {
                        "$filter": {
                           "input": "$rows",
                           "as": "connection",
                           "cond": "$$connection.sdam"
                        }
                     },
                     "as": "sdam",
                     "in": "$$sdam.connectionId"
                  }
               },
               "rttConnectionIds": {
                  "$map": {
                     "input": {
                        "$filter": {
                           "input": "$rows",
                           "as": "connection",
                           "cond": "$$connection.rtt"
                        }
                     },
                     "as": "rtt",
                     "in": "$$rtt.connectionId"
                  }
               },
               "sockets": {
                  "$size": {
                     "$setUnion": ["$socketKeys", []]
                  }
               },
               "streams": {
                  "$size": {
                     "$filter": {
                        "input": "$socketKeys",
                        "as": "key",
                        "cond": {
                           "$gt": [
                              {
                                 "$size": {
                                    "$filter": {
                                       "input": "$socketKeys",
                                       "as": "peer",
                                       "cond": { "$eq": ["$$peer", "$$key"] }
                                    }
                                 }
                              },
                              1
                           ]
                        }
                     }
                  }
               },
               "totalConnections": { "$size": "$connections" }
            }
         },
         // { "$match": { // post filter on the output document
         // "tag": "client",
         // "class": "NetworkInterfaceTL-ReplCoordExternNetwork",
         // "appName": { "$in": [/^greedyApp/, null] },
         // "appName": { "$in": [/^(?:mongosh|MongoDB Shell)/, null] }
         // } },
         { "$sort": { "totalConnections": -1 } },
         { "$unset": ["_id", "connections", "rows", "socketKeys", "channelKeys", "kind", "systemByUser", "parentSystemByUser", "parentUsers", "ruleUsers", "interactive", "hasStreaming", "hasAuth", "mode"] }
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
      for (; ;) {
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
      for (; ;) {
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

   function sumField(rows, key) {
      let total = 0;
      for (let i = 0; i < rows.length; i++) total += rows[i][key] || 0;
      return total;
   }

   function categoryRollup(rows, tag) {
      const matched = rows.filter(doc => doc.tag === tag);
      return {
         "rows": matched.length,
         "sockets": sumField(matched, "sockets"),
         "streams": sumField(matched, "streams"),
         "totalConnections": sumField(matched, "totalConnections"),
         "pools": sumField(matched, "pools")
      };
   }

   const docs = loadDocs();
   if (ownOpsOnly) console.log("PARTIAL: own ops only");
   if (omitted.length) console.log("PARTIAL: omitted " + omitted.join(", "));
   const scope = pipeline[0].$currentOp.allUsers === true ? "allUsers" : "ownOps";
   docs.forEach(doc => {
      console.log({ scope, ...doc });
   });
   /*
    *  True total plus one slice per tag. sockets is the connection count.
    *  totalConnections remains the $currentOp row count. The client slice is
    *  the application traffic. It is not the Atlas NAT-border figure: this
    *  sample includes the script's own connection and can omit idle sockets
    *  on a shared tier.
    */
   console.log({
      "scope": "rollup",
      "sockets": sumField(docs, "sockets"),
      "streams": sumField(docs, "streams"),
      "totalConnections": sumField(docs, "totalConnections"),
      "pools": sumField(docs, "pools"),
      "cluster": categoryRollup(docs, "cluster"),
      "fabric": categoryRollup(docs, "fabric"),
      "client": categoryRollup(docs, "client")
   });
})();

// EOF
