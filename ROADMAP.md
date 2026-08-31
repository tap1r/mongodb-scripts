# Roadmap

Working list of planned features. Scripts stay **monolithic** (`load()` / `mdblib.js` / multi-tenant `db` injection is a separate, upcoming change — do not block features on sharing helpers). Command options are passed through; mongod already validates — bounce the error.

Status is implied by section: **planned** unless marked later / hardening.

---

## General

- **Library / `load()` / multi-tenant `db`.** `mdblib.js` today is a global `load()` with a free `db`. `ctxDemo.js` sketches `mdblib.for(db)`. That story will change; do not refactor other scripts to depend on a new module layout until it exists.
- **mongosh scripting guide.** Living notes for `--file` rewriter, async IIFEs, `sleep()` vs `await` delays, `--eval` `var` options. Extend when a script hits a new shell quirk.
- **`ProgressTracker`.** Stub in `mdblib.js` (`/* Add to mdblib.js */`) for long catalog walks (dbstats, index cache, auto-trim snapshot).
- **Topology fan-out.** Per-mongod tools (`autoCompact`, WT vitals) eventually ride `discovery.js`. Until then, operators target members with a direct connection.

---

## Auto-trim (planned orchestrator)

A one-shot `$collStats` / `collStats` check inside `autoCompact.js` is the wrong place: autoCompact already skips files below `freeSpaceTargetMB`, and a catalog-wide stats pull is as expensive as the walk you moved off the enable path.

The same measurement **is** the right planner for a dedicated **auto-trim** loop: pay for the catalog snapshot **once per iteration**, rank reclaimable space, then run `autoCompact.js` with a **raised** `freeSpaceTargetMB` so that pass only compact files above a high-water mark. That limits how many namespaces WT actually touches without a server-side allowlist (the command is still node-wide). Smaller passes mean less checkpoint / dirty-cache burst, which is what shows up as **repl lag** and **I/O**.

### Intent

1. Snapshot storage **dbstats-style** (collections **and** indexes: `freeStorageSize` / `idxFreeStorageSize`).
2. Exclude what autoCompact excludes (`local.oplog.rs`; internals).
3. Rank remaining tables by reclaimable bytes, descending.
4. Take the largest free-space value. Set  
   `freeSpaceTargetMB = max(server floor, proportion × largest)`  
   with **proportion in the 10–50% range** (tunable). Server floor is 20MB today; WT also ignores reclaim below ~1–2 MiB (`compactionHelper` in `mdblib.js`).
5. Run `autoCompact.js` with `{ autoCompact: true, runOnce: true, freeSpaceTargetMB }`. Only files with reclaimable ≥ target compact this walk.
6. Wait for that round to finish (existing monitor).
7. Repeat: re-snapshot (accurate) or drop compacted names and lower the target (cheaper). Stop when the remaining max is below the floor, `compactionHelper` would say no, or recovered bytes this pass are ~0.

Work per iteration is bounded by the **high-pass on free space**, not by listing namespaces in the command. A 10GB outlier with proportion 50% yields a 5GB target: one (or a few) fat tables this round; the long tail waits for later, cheaper passes.

### Placement

New monolithic script (working name `autoTrim.js`), not a preflight inside `autoCompact.js`. Coupling:

- **Plan** from a dbstats-style snapshot. Prefer consuming `dbstats.js` `output.format: json` once that path is a stable ranked list (`sort` by `freeStorageSize` / `idxFreeStorageSize` is already there; `compactOnly` verbosity is TBA).
- **Execute** by driving `autoCompact.js` (`--eval` options + `--file`), same process or a wrapper. Do not `load()` either until the library story settles. Bounce `autoCompact` command errors.

Direct-to-mongod only (same constraint as autoCompact). Prefer secondaries first; the command is not replicated, so each member still needs its own trim.

**Atlas M0 / Flex:** [`autoCompact`](https://www.mongodb.com/docs/manual/reference/command/autocompact/) and [`compact`](https://www.mongodb.com/docs/manual/reference/command/compact/) are [unsupported](https://www.mongodb.com/docs/atlas/unsupported-commands/) on Free and Flex clusters (`<$command> is not allowed…`). Auto-trim is **M10+ / dedicated / self-managed only**. Do not fall back to `compact` on those tiers — it is on the same deny list. On M0/Flex, `serverStatus` also omits WiredTiger, and free-space in dbstats is `n/a`; that is a planner stop, not a compact attempt.

### Heuristics to pin down

- Proportion schedule: fixed 10–50%, or step down (50% → 25% → 10% → floor) as the head of the distribution shrinks.
- Collection vs index mix: `compactionHelper` uses 20% reuse for collections and 50% for indexes; the target is in **MB**, so ranking should still be raw free bytes, with those ratios as an optional skip filter.
- Pause between iterations on `congestionMonitor` / repl lag (or a simple sleep) so a secondary can drain.
- Atlas Flex / M0: hidden WT free-space → do not treat `n/a` as 0 (same as dbstats). If free-space is unknown, skip trim; bounce the command if someone still runs `autoCompact`.

---

## By script

### `autoCompact.js`

Hardening of the executor auto-trim will call. Keep the file standalone.

- **Completion from `serverStatus`, not ramlog.** `getLog` WTCMPCT is display. Stop on `wiredTiger['background-compact']` running bit plus the unused successful/skipped/failed counters. Today `runOnce: false` can hang if `sizeStorer` is missed or `getLog` is denied.
- **Watermark at `runCmd`, from `serverStatus.localTime`.** (Done in v0.4.23: snapshot after the ident wait, immediately before enable. Core `localTime` field, same clock as `getLog` `t`. Client `ISODate()` only if `serverStatus` omits it.)
- **Topology / engine preflight only.** Mongos, FCV/binary &lt; 8, non-WT, missing WT `serverStatus` (null engine today continues and the poll never exits). Not option validation. Atlas M0/Flex: inlined `mdblib.js` `isAtlasPlatform('sharedTier')` — `hostInfo()` fallbacks + `db.hostInfo().ok` / `AtlasError` + `atlasVersion` / `*.mongodb.net`. `serverless` is still a platform string (Atlas Serverless is deprecated/gone; keep the branch). Dedicated still bounces a denied `autoCompact` if the user lacks the role.
- **Ident pump lifetime.** Background `$listCatalog` must not outlive disable-only or a finished tail; close the cursor on the way out. Keep `await delay()` (not blocking `sleep()`) so the pump can run during waits.
- Later: optional disable-wait cap and `quit(1)` for cron; JSON one-liner (`ok`, recovered bytes) for auto-trim to parse.

### `dbstats.js`

The snapshot auto-trim wants. Existing TBA that matters for that:

- Sort/limit by `compaction`, `reuse`, `idxFreeStorageSize` (hooks exist, several still TBA).
- `output.verbosity: compactOnly` — compact candidates only.
- `output.format: json` already exists; make it a ranked `{ ns, kind, freeStorageSize, storageSize }[]` that another `--file` can consume without scraping the table.
- Topology expand (`discover`, replica/sharded summary) — later, likely via discovery.

`compactionHelper` (20% collection / 50% index / 50% dbPath, plus WT min reclaim) stays the “is this worth it” predicate; auto-trim’s `freeSpaceTargetMB` is the **how much this pass** knob.

### `compact.js` / `onlineDefrag.js`

Per-namespace `compact` and update-based defrag. Not auto-trim. Later: point compact/rebuild at a single dbstats “compact” / “rebuild” row when autoCompact’s file walk is the wrong tool (one collection, dryRun estimate, `_id` rebuild). `compact` is also [unsupported on Atlas M0/Flex](https://www.mongodb.com/docs/atlas/unsupported-commands/); same bounce as autoCompact.

### `discovery.js`

- Plugable command profiles (auto-trim / autoCompact as a per-member job).
- Standalone, load-balanced, arbiters.
- Execution modes: serial; shards in parallel / serial per shard; limited pool; jitter; timeout cancel.
- Target primary vs secondaries only (auto-trim wants the latter by default).
- Load / lag metrics beside each directed command.

### `congestionMonitor.js`

- Sharding (per-shard WT vitals; same need as niceDeleteMany).
- MongoDB 8 execution-control metrics.
- `bytes_dirty_intl` / `bytes_dirty_leaf` when the server exposes them.
- Optional pause signal for auto-trim between iterations.

### `niceDeleteMany.js`

- Better sharding: per-shard WT vitals via `listShards` / discovery.
- `lowPriorityAdmissionBypassThreshold` backward compatibility.
- Curation Policy B: compound equality → trailing sort probes.

### `connStats.js`

- `whatsmyuri` for “this client” vs the pool.
- DRIVERS-3027 when it lands.
- Later: `targetAllNodes` on mongos (commented TBA).

### `indexCacheUtil.js`

- Thread pool, sharding, cluster-wide report.
- `runCommand` instead of `adminCommand` for directed execution (discovery).
- System-namespace cache scope; progress while accumulating.

### `mdblib.js`

- Namespaced helpers / `for(db)` — **after** the library strategy change, not before.
- Finish TBA namespace listers (`getAllNonSystemNamespaces`, views, system).
- `AutoFactor` NaN / scale clamp (the copy in `autoCompact.js` is stricter).
- `$genRandWord`, `$benford` — later / fuzzer.

### `fuzzer.js`

Resharding wait already holds the user Promise so mongosh does not exit early. No auto-trim work.

### `killAgedSessions.js` / `rtt.js` / `latency.js`

No storage-trim work. `rtt.js` TODOs are still TBA.

---

## See also

- [DB Storage tools](DB%20Storage%20tools.md) — dbstats report and compaction column
- [mongosh scripting guide](mongosh-scripting-guide.md)
- [`autoCompact` command](https://www.mongodb.com/docs/manual/reference/command/autocompact/)
- [`compact` command](https://www.mongodb.com/docs/manual/reference/command/compact/)
- [Unsupported commands in Atlas](https://www.mongodb.com/docs/atlas/unsupported-commands/) — M0/Flex deny `autoCompact` and `compact`; limited `serverStatus` / `dbStats`
