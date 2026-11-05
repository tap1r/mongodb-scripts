# Client handshake metadata

What `$currentOp.clientMetadata` holds, how a driver monitoring socket looks beside its pool, and the two server-side labels `NetworkInterfaceTL-*` and `MongoDB Internal Client`.

The server keeps the handshake `client` document for the life of the connection. Later hellos do not send it again. `$currentOp.command` is whatever is in flight. A monitoring socket is idle for most of `heartbeatFrequencyMS` (default 10 seconds), so a sample often has no command. `idleConnections: true` still returns it. `allUsers: true` (the `inprog` privilege) is what shows other users’ sockets, unauthenticated monitors, and internal clients.

Read from driver and server sources in November 2026. Instance-name suffixes grow with subsystems. The prefix rule is the stable part.

## Driver monitoring sockets

Each `MongoClient` holds, per server it monitors, one streaming hello and one RTT socket, plus the operation pool. Poll mode is one monitor socket and no separate RTT socket, except libmongoc (C, C++, PHP), which opens the RTT socket whenever `topologyVersion` is present, including poll mode. Load-balanced mode has neither monitoring socket.

The monitoring handshake is unauthenticated. It carries the same `client` document as the pool: `application.name`, `driver.name`, `driver.version`, `platform`, and `os`. Async PyMongo is the exception on `driver.version`: the monitor pool is built with the sync default, so it omits the extra empty `|` segment the async operation pool appends, and a group key on `driver.version` splits that one client into two rows.

Wrappers append to `driver.name`. C++ and PHP append with ` / ` onto `mongoc`. C#, Go, Java, Kotlin, Scala, Node.js, Ruby, and Rust append with `|`.

| Client | `driver.name` | Second socket |
| --- | --- | --- |
| C | `mongoc` | RTT once `topologyVersion` exists, including poll mode |
| C++ | `mongoc / mongocxx` | same as C (libmongoc) |
| PHP | `mongoc / ext-mongodb:PHP` | same as C (libmongoc). An extra custom name may be appended |
| C# | `mongo-csharp-driver` | RTT only while streaming |
| Go | `mongo-go-driver` | RTT only while streaming |
| Java sync | `mongo-java-driver\|sync` | RTT only while streaming. Reactive is `mongo-java-driver\|reactive-streams`. The legacy API appends `legacy` |
| Kotlin sync | `mongo-java-driver\|kotlin\|sync` | Java sync sockets |
| Kotlin coroutine | `mongo-java-driver\|kotlin\|reactive-streams` | Java reactive sockets |
| Scala | `mongo-java-driver\|scala\|reactive-streams` | Java reactive sockets |
| Node.js | `nodejs` | RTT only while the hello is awaitable |
| mongosh | `nodejs\|mongosh` | Node.js sockets. Default `application.name` is `mongosh <version>` unless the URI sets `appName` |
| PyMongo | `PyMongo` | RTT only while streaming. `|c` when the C extensions are loaded. `\|async` on the async operation pool |
| Ruby | `mongo-ruby-driver` | The original monitor becomes the RTT socket once `PushMonitor` is running. Poll mode is one socket |
| Rust | `mongo-rust-driver` | RTT only when streaming is allowed and a topology version exists |

`application.name` on these sockets is the application’s name, the same value as the pool, capped at 128 bytes. mongosh’s default is the one above.

Kotlin and Scala are modules of the Java driver (5.14.0 in the tree this was read from: `driver-kotlin-sync`, `driver-kotlin-coroutine`, `driver-scala`). They do not open their own monitoring sockets.

Kotlin sync wraps `com.mongodb.client.MongoClients`. It appends driver name `kotlin` and platform `kotlin/<major.minor.patch>` (`KotlinVersion.CURRENT`, the stdlib on the application classpath) before the sync factory appends `sync`. Kotlin coroutine and Scala wrap `com.mongodb.reactivestreams.client.MongoClients`. Coroutine appends `kotlin` the same way. Scala appends driver name `scala` and platform `Scala/version <number>` (`scala.util.Properties.versionString`, which includes the word `version`; the number is the Scala library on the classpath, and this driver publishes 2.11, 2.12, 2.13, and 3). The reactive factory then appends `reactive-streams`. Caller-supplied driver metadata is inserted before `kotlin` or `scala`.

Unset driver versions are omitted, so `driver.version` stays the Java driver version alone. `platform` is the Java platform (`Java/<vendor>/<runtime>`) plus the Kotlin or Scala segment. The pool, the SDAM handshake, and the RTT handshake share that document. `driver-kotlin-extensions` and the BSON Kotlin and Scala modules do not open connections.

### Command in flight

A streaming hello is the one that includes `maxAwaitTimeMS` while it is awaited. Between rounds that socket is idle. Poll hellos and RTT hellos omit `maxAwaitTimeMS`. None of these drivers use `ping` for RTT.

Legacy hello is spelled `ismaster` by Node.js, mongosh, and PyMongo, and `isMaster` by C, C++, PHP, C#, Go, Java, Kotlin, Scala, Ruby, and Rust.

| Family | Streaming hello | Poll and RTT |
| --- | --- | --- |
| C, C++, PHP | `hello` or `isMaster`, `helloOk`, `topologyVersion`, `maxAwaitTimeMS` | the same fields without `topologyVersion` and `maxAwaitTimeMS`. The RTT socket exists in poll mode |
| C#, Go | `hello` or `isMaster`, `helloOk`, `backpressure: "2"`, plus `topologyVersion` and `maxAwaitTimeMS` when streaming | the same fields without the await fields |
| Java, Kotlin, Scala | `hello` or `isMaster`, `helloOk`, plus the await fields when streaming. Later hellos omit `backpressure` | Poll: `hello` or `isMaster` plus `helloOk`. The RTT command is only `{hello: 1}` or `{isMaster: 1}` |
| Node.js, mongosh | `hello` or `ismaster`, `topologyVersion`, `maxAwaitTimeMS` | `{hello: 1}` or `{ismaster: 1}` |
| PyMongo | `hello` or `ismaster`, `backpressure: "2"`, plus `maxAwaitTimeMS` when streaming | the same fields without `maxAwaitTimeMS` |
| Ruby | the check document (`hello` or `isMaster`, plus compression when configured), `topologyVersion`, `maxAwaitTimeMS` | the check document without the await fields. `backpressure` lives inside the stored `client` document, so it is on every Ruby socket |
| Rust | `hello` or `isMaster`, `backpressure: "2"`, plus the await fields when streaming | the same fields without the await fields |

On one mongod, the streaming-hello count from one client endpoint is the number of `MongoClient`s that endpoint has connected to this process. Divide by the number of members when the goal is an estimate of clients in the deployment. That sample is this process only.

[DRIVERS-3027](https://jira.mongodb.org/browse/DRIVERS-3027) is the open driver change for a reserved `client.purpose` of `sdam` or `rtt` on those two handshakes. The operation pool omits it. `application.name` and `driver.name` stay identical to the pool, so a monitoring socket still groups with its application.

## `NetworkInterfaceTL-*`

`NetworkInterfaceTL` is the C++ egress task-executor transport. The handshake string is the instance name with a prefix. `executor::makeInstanceName` returns `NetworkInterfaceTL-` plus that name, and the async client writes it as `client.driver.name` (`AsyncDBClient::_buildHelloRequest`, the three-argument `ClientMetadata::serialize`). `client.driver.version` is the server’s own version. Production handshakes on this path omit `client.application.name` and `platform`. The document is `driver` plus `os`. With the testing proctor enabled, `application.name` is the process name, truncated to 128 bytes.

When auth is on, the pool authenticates as the internal client, unless the pool was built with `skipAuthentication` (the mongot and search-index pools can). These sockets are the process’s own egress. A driver’s SDAM and RTT sockets use that driver’s name and stay unauthenticated.

Admission exemptions match a prefix of `driver.name` or of `application.name` (`AppNameExemptionMatcher`). The prefix `NetworkInterfaceTL` covers every `NetworkInterfaceTL-*` driver name. An exact comparison with the bare string `NetworkInterfaceTL` matches none of them.

gRPC task executors (`makeNetworkInterfaceGRPC`) use the same prefixed driver name.

The suffix is the instance name. Names below are the ones this tree builds. A deployment shows the subset its role and features start.

Replica-set mongod:

| `driver.name` | Role |
| --- | --- |
| `NetworkInterfaceTL-ReplCoordExternNetwork` | replication coordinator external executor |
| `NetworkInterfaceTL-OplogWriterNetwork` | oplog writer |
| `NetworkInterfaceTL-OplogApplierNetwork` | oplog applier |
| `NetworkInterfaceTL-ReplNetwork` | replication coordinator executor |
| `NetworkInterfaceTL-ReplNodeDbWorkerNetwork` | replica-set node worker |

Every mongod also builds a local executor named `NetworkInterfaceTL-StandaloneNetwork`. Its egress hook refuses remote work, so that name stays on the instance.

mongos and a sharded mongod:

| `driver.name` | Role |
| --- | --- |
| `NetworkInterfaceTL-Sharding-Fixed` | sharding fixed executor |
| `NetworkInterfaceTL-TaskExecutorPool-0` (and `-1`, …) | sharding task-executor pool |
| `NetworkInterfaceTL-ShardRegistryUpdater` | shard registry refresh |
| `NetworkInterfaceTL-AddShard-TaskExecutor` | addShard |
| `NetworkInterfaceTL-AddShardCoordinator-TaskExecutor` | addShard coordinator |
| `NetworkInterfaceTL-HelloMe-TaskExecutor` | config-server connectivity check |

Replica-set discovery, in the legacy `mongo` shell and in mongod and mongos when they open a replica set:

| `driver.name` | Role |
| --- | --- |
| `NetworkInterfaceTL-ReplicaSetMonitor-TaskExecutor` | replica-set monitor. The same pool runs `ServerPingMonitor`, so some of these sockets are in `{ping: 1}` |
| `NetworkInterfaceTL-ServerDiscoveryMonitor-TaskExecutor` | only when that monitor is constructed without an executor. The shell and the server pass the replica-set monitor executor, so the usual name is the row above |

Other production instance names in this tree:

| `driver.name` | Role |
| --- | --- |
| `NetworkInterfaceTL-MirrorMaestro` | mirrored reads |
| `NetworkInterfaceTL-MongotExecutor` | mongot |
| `NetworkInterfaceTL-SearchIndexMgmtExecutor` | search index management |
| `NetworkInterfaceTL-FLECrudNetwork` | FLE CRUD |
| `NetworkInterfaceTL-TTLMonitorMetadataRefreshNetwork` | TTL monitor metadata refresh |
| `NetworkInterfaceTL-QueryAnalysisWriterNetwork` | query analysis |
| `NetworkInterfaceTL-RangeDeleterServiceExecutor` | range deleter |
| `NetworkInterfaceTL-ReshardingOplogFetcherNetwork` | resharding oplog fetch |
| `NetworkInterfaceTL-ReshardingCollectionClonerNetwork` | resharding collection clone |
| `NetworkInterfaceTL-FaultManager-TaskExecutor` | health fault manager |

Primary-only services append `Network` to the service name: `NetworkInterfaceTL-ShardingDDLCoordinatorNetwork`, `NetworkInterfaceTL-ConfigsvrCoordinatorServiceNetwork`, `NetworkInterfaceTL-RenameCollectionParticipantServiceNetwork`, `NetworkInterfaceTL-ReshardingCoordinatorServiceNetwork`, `NetworkInterfaceTL-ReshardingDonorServiceNetwork`, `NetworkInterfaceTL-ReshardingRecipientServiceNetwork`, `NetworkInterfaceTL-MultiUpdateCoordinatorServiceNetwork`.

Several of these executors share the server version and the server `os`, and they omit `platform`. A group key of endpoint + `driver.version` + `platform` + `os` collapses them into one row. `driver.name`, or the `MongoDB Internal Client` application name, is what tells them apart.

## `MongoDB Internal Client`

Sync `DBClient` writes a different handshake (`DBClientSession::appendClientMetadata`, the four-argument serialize):

* `driver.name` is `MongoDB Internal Client`
* `application.name` is the caller’s string, omitted when empty, at most 128 bytes
* `driver.version` is the server version

The legacy `mongo` shell’s own user connection uses this family. The default application name is `MongoDB Shell` (`MongoURI::kDefaultTestRunnerAppName`). A URI `appName` replaces it. The shell’s gRPC mode uses the same pair. `benchRun` connects as `BenchRun`. The shell helper that kills operations on other connections connects as `MongoDB Shell`.

When that shell opens a replica set, the user sockets stay `MongoDB Internal Client` / `MongoDB Shell`, and the shell’s replica-set monitor opens `NetworkInterfaceTL-ReplicaSetMonitor-TaskExecutor`. That monitor is the shell’s use of the `NetworkInterfaceTL-` label.

mongosh uses neither label. It is the Node.js driver: `nodejs|mongosh`, with `application.name` `mongosh <version>` unless the URI sets `appName`.

Other application names on `MongoDB Internal Client`:

| `application.name` | Who |
| --- | --- |
| `MongoDB Shell` | legacy shell default, and the shell’s kill-ops helper |
| `BenchRun` | `benchRun` |
| `OplogFetcher` | replication oplog fetcher. This is an application name. It is not a `NetworkInterfaceTL-` driver name |
| `{binaryName}-GRPCClient` | mongod and mongos gRPC client metadata, usually `mongod-GRPCClient` or `mongos-GRPCClient`. Test egress uses `Test-GRPCClient` |

## Reading one connection

1. `driver.name` starts with `NetworkInterfaceTL-`. Server or legacy-shell egress. The suffix is the subsystem. `driver.version` is the server version. `application.name` is absent in production. The socket authenticates internally (mongot and search can skip that). A `ping` on `NetworkInterfaceTL-ReplicaSetMonitor-TaskExecutor` is the server’s ping monitor.
2. `driver.name` is `MongoDB Internal Client`. Sync DBClient. `application.name` is the role: `MongoDB Shell`, `OplogFetcher`, `BenchRun`, `{binary}-GRPCClient`, or a URI `appName`.
3. Any other `driver.name` is an application driver. The `client` document matches across that client’s pool and its monitoring sockets, aside from the async PyMongo `driver.version` split. Monitoring sockets are unauthenticated. The streaming monitor is the hello that carries `maxAwaitTimeMS`. A poll monitor and an RTT socket are a hello without it.

```javascript
db.adminCommand({
  aggregate: 1,
  cursor: {},
  pipeline: [
    { $currentOp: { allUsers: true, idleConnections: true } },
    { $match: { clientMetadata: { $exists: true } } },
    { $project: {
        client: 1,
        driver: "$clientMetadata.driver",
        app: "$clientMetadata.application",
        platform: "$clientMetadata.platform",
        cmd: { $map: {
          input: { $objectToArray: { $ifNull: ["$command", {}] } },
          as: "kv",
          in: "$$kv.k"
        } },
        awaitMS: "$command.maxAwaitTimeMS",
        user: "$effectiveUsers"
    } }
  ]
})
```

The aggregate `$currentOp` stage is the form that returns the handshake document. The sample is the process you ran it on.

## `connStats.js`

v0.2.0 (`src/connStats.js`) tags each grouped row `client` or `internal`.

`class` is null on a client row. On an internal row it is one `NetworkInterfaceTL-*` driver name, or the `MongoDB Internal Client` application name (`MongoDB Shell`, `OplogFetcher`, `BenchRun`, `{binary}-GRPCClient`). `appName` on that row is the class. `pools` is 0, and those sockets are not counted as driver SDAM or RTT.

The row is incoming to the process the script is run on. A mongos sample shows clients of that mongos. Member and mongos egress show up on the mongod that accepted the connection. On a shard primary the classes come out separately, including `NetworkInterfaceTL-ReplicaSetMonitor-TaskExecutor`, `NetworkInterfaceTL-ReplNetwork`, `NetworkInterfaceTL-ReplCoordExternNetwork`, `NetworkInterfaceTL-TaskExecutorPool-0`, `NetworkInterfaceTL-Sharding-Fixed`, and `OplogFetcher`.

Internal rows have no `platform`. They group on the client endpoint, the server version, and `os`. `authenticatedUsers` comes from `effectiveUsers` on the sampled ops. Idle sockets often have none, so an internal row can list no user while an active socket in that class shows `__system@local`.

A client row still groups by endpoint, normalized `driver.version`, `platform`, and `os`. Empty `|` segments are dropped, so an async PyMongo monitor joins its pool. When the sample has an authenticated user and no streaming hello, every unauthenticated socket in that group counts as a poll-mode monitor. A mongosh session in that state reported `pools: 3`: one authenticated command connection and three idle sockets with no command in flight. A streaming hello is the SDAM socket while `maxAwaitTimeMS` is set.

v0.1.14 compared `driver.name` to the exact string `NetworkInterfaceTL` and collapsed every prefixed executor that shared the server version into one row.

`whatsmyuri` and mongos `targetAllNodes` remain later work. See [`connStats.js`](ROADMAP.md#connstatsjs) in the roadmap.
