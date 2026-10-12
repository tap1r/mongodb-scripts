# DB storage tools

These scripts evaluate WiredTiger disk use (including reclaimable free space) for maintenance and capacity planning. [dbstats.js](src/dbstats.js) is the report; [autoCompact.js](src/autoCompact.js), [onlineDefrag.js](src/onlineDefrag.js), and [indexCacheUtil.js](src/indexCacheUtil.js) act on or inspect the same storage.

## Storage engine usage reporting

[dbstats.js](src/dbstats.js) (with [mdblib.js](src/mdblib.js)) reports internal storage and derived metrics:

* Data size (uncompressed)
* Storage size (on disk)
* Document count
* Free blocks / reuse (WiredTiger reclaimable bytes)
* Compression statistics
* Index storage and reusable space
* Sharded namespace and index statistics
* Compaction helper recommendations (`compact`, `rebuild`, `wait`, `resync`)

Live versions: dbstats **1.2.7**, mdblib **1.1.1**.

### Installing _dbstats.js_

Retrieve fresh copies of both scripts:

```bash
curl --remote-name-all -fsSL https://raw.githubusercontent.com/tap1r/mongodb-scripts/master/src/{dbstats.js,mdblib.js}
```

Place `mdblib.js` on `cwd`, `$MDBLIB`, or another mongosh `load()` search path.

### Using _dbstats.js_

```bash
mongosh [connection options] --quiet [--eval 'var options = {...};'] -f dbstats.js
```

`--file` / `-f` prints the interactive report. `load('dbstats.js')` gathers quietly and returns the JSON contract — `await` that Promise. Do not declare `options` or `optionsFile` inside the script; `--eval` must use `var` (not `let`/`const`).

Options overlay is `dbstats-options.jsonc` (cwd, `--file` dir, `$MDBLIB`, `~/.mongodb`) then `--eval var options`. A missing default file is silent. Explicit path: `var optionsFile = "PATH"`.

```bash
mongosh --quiet --eval 'var options = { filter: { db: "^database$" } };' -f dbstats.js
mongosh --quiet --eval 'var options = { output: { format: "json" } };' -f dbstats.js
mongosh --quiet --eval 'var options = { output: { format: "html" } };' -f dbstats.js > dbstats.html
open dbstats.html
mongosh --quiet --eval 'var options = { output: { verbosity: "compactOnly" } };' -f dbstats.js
mongosh --quiet --eval 'var optionsFile = "/path/to/dbstats-options.jsonc"' -f dbstats.js
```

Further filter, sort, catalog, topology, and profile examples live in the [dbstats.js](src/dbstats.js) header.

### Prerequisites

1. **mongosh** 1.10 / 2.10+. **mongod** 4.4+.
2. [mdblib.js](src/mdblib.js) on `cwd` or `$MDBLIB`.
3. Minimum roles: `clusterMonitor@admin` and `readAnyDatabase@admin`. Fewer privileges means fewer (or no) statistics.

   In the Atlas UI this translates as:

   * Built-in Role: _Only read any database_
   * Specific Privileges: _clusterMonitor_

   Or a custom role with Global Actions and Roles → Built-In Roles → _clusterMonitor_ and _readAnyDatabase_.

4. **MongoDB 8+ sharded:** the walk grants shard-local `directShardOperations` for user-database `dbStats` / `$collStats`, then revokes it. A mongos grant does not update the shard-local user. `clusterAdmin` on the connecting user is the usual way that lease works.
5. **Atlas M0/Flex:** one connecting node (compact / autoCompact cannot run). WiredTiger free-space is often `N/A`; db/dbPath totals may roll up collection `$collStats` as a lower bound.

### Report formats and knobs

* **format:** `tabular` (default; `table` is an alias), `nsTable`, `json`, `html`. JSON is the versioned contract `main()` returns (`ok`, `name`, `version`, `catalog`, `topology`, `totals`, `databases[]`, `namespaces[]`, `warnings[]`). `n/a` free-space stays `null`, not `0`.
* **verbosity** (tabular / nsTable / HTML initial view): `full` (collections + indexes + views), `summary` (database rollup), `summaryIdx` (collections + indexes), `compactOnly` (rows with a compact/rebuild/wait/resync action). JSON stays the full payload.
* **topology.depth** default `expanded` (catalog + `$collStats` per member, one table per node). `summary` is `$stats` on remotes plus the connecting catalog and a member footer. `topology.discover` default true; shared-tier / serverless stay one node.
* **Sharded:** CSRS members are listed. When they are, the mongos row is `cluster data (no local/metadata)` (no `config` / `local` from the router). **Cluster consumption (total)** sums mongod dbPaths (WiredTiger collection and index files). Logs, binaries, journals, and FTDC add further disk use.
* **Compaction** appears on collection, index, and namespace rows and on Database / dbPath rollups. Cluster consumption total blanks those action cells. `compactOnly` still filters which rows print.

### Sample output

```text
═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
Database: database                            Data size     Compression   Size on disk    Free blocks / reuse   Object count   Compaction
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Collections: 1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
╰> collection                                 47.13 MiB     2.02:1 zstd      52.65 MiB      29.38 MiB / 55.8%          58616      compact
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ╰» _id_                                                                      6.5 MiB       4.89 MiB / 75.3%                     compact
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ╰» array_1                                                                  9.23 MiB       7.48 MiB / 81.0%                     rebuild
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ╰» object.$**_1                                                            22.11 MiB      14.07 MiB / 63.6%                     rebuild
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Namespaces subtotal: 1                        47.13 MiB          2.02:1      52.65 MiB      29.38 MiB / 55.8%          58616      compact
Indexes subtotal: 11                                                         83.89 MiB       53.5 MiB / 63.8%                     rebuild
═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
dbPath totals                                 Data size     Compression   Size on disk    Free blocks / reuse   Object count   Compaction
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All namespaces: 21                           131.42 MiB          2.22:1      89.52 MiB      30.23 MiB / 33.8%          63274        ———— 
All indexes: 35                                                              84.32 MiB      53.61 MiB / 63.6%                     rebuild
Total:                                                                      173.84 MiB      83.85 MiB / 48.2%          63274        ———— 
═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
Filesystem volume: 641.85 GiB used / 926.3 GiB capacity (69.3% used)   284.45 GiB free
Replica set: replset   Members: 3   Version: 9.0.2
  * localhost:27017   Role: PRIMARY     Type: mongod   dbPath: /data/rs1/db
    localhost:27018   Role: SECONDARY   Type: mongod   dbPath: /data/rs2/db
    localhost:27019   Role: SECONDARY   Type: mongod   dbPath: /data/rs3/db

Cluster consumption (total, 3 dbPaths):                                     536.03 MiB    262.31 MiB* / 48.9%         189822        ———— 
[NOTE] These totals are WiredTiger collection and index storage. Logs, binaries, journals, and FTDC add further disk use.
Filesystem volumes (1 unique): 641.85 GiB used / 926.3 GiB capacity (69.3% used)   284.45 GiB free
[NOTE] Listed collections may omit filtered or unauthorized namespaces; database and dbPath totals are db.stats().
═════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Compaction helper recommendations
  compact   Collection or _id_ index: run compact() when reusable bytes exceed 20% of the collection (50% for _id_) and WiredTiger's reclaim floor (1 MiB on 8.0+).
  rebuild   Secondary index: drop and rebuild. compact() does not reclaim non-_id_ indexes; reusable bytes above 50% and the same reclaim floor.
  wait      local.oplog.rs meets the compact threshold. Leave the oplog; wait for capped reuse.
  resync    dbPath collection storage is more than 50% reusable. Initial sync / resync is the practical reclaim at that scale.
  ————      Below those thresholds, or not a compactable object. N/A means WiredTiger free-space is unknown.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

`*` on a connecting node marks the session that produced the summary. `*` on a free-space cell is a lower bound (collection `$collStats` rollup when db-level reusable bytes are incomplete).

## Other storage scripts

* [autoCompact.js](src/autoCompact.js) **1.3.0** — enable, monitor, or disable the MongoDB 8.0+ `autoCompact` thread on a **mongod** (not mongos). Atlas M0/Flex fails fast. Direct-host connection. Options: `autoCompact-options.jsonc` then `var autoCompactOptions`.
* [onlineDefrag.js](src/onlineDefrag.js) **1.8.0** — mongosh-only online defrag (first-fit packing; strategies `naturalReplay`, `naturalWindow`, `quantile`, `shapeQuantile`). Needs mdblib. `--eval` uses `var` for `dbName`, `collName`, `defragOptions`.
* [indexCacheUtil.js](src/indexCacheUtil.js) **1.2.0** — WiredTiger index cache residency on the connected mongod. Does not load mdblib. A mongos session has no WT cache.

`compact.js` is archive-only (`legacy/mongo-shell/`).

See [ROADMAP.md](ROADMAP.md), the [mongosh scripting guide](mongosh-scripting-guide.md), and MongoDB’s [`compact`](https://www.mongodb.com/docs/manual/reference/command/compact/) / [`autoCompact`](https://www.mongodb.com/docs/manual/reference/command/autocompact/) docs. Atlas M0/Flex deny those commands: [unsupported commands](https://www.mongodb.com/docs/atlas/unsupported-commands/).
