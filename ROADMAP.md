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
2. Exclude what autoCompact excludes (`local.oplog.rs`; internals). Oplog reclaim is a separate, **opt-in** 8.0+ `compact` (see below) — not part of the autoCompact walk.
3. Rank remaining tables by reclaimable bytes, descending. Drop `n/a` free-space (Atlas M0/Flex) rather than treating it as 0.
4. From that sample, choose a **schedule of `freeSpaceTargetMB` cuts** so each `runOnce` pass does a comparable slice of reclaimable mass — not a flat “10–50% of the max” (see Heuristics). Stop at a **configurable floor** (expected default **1MB**, the WT v8+ ignore threshold). The autoCompact **server default of 20MB** is only a safety net when the command is run with no target; auto-trim always passes an explicit `freeSpaceTargetMB` and does not use that 20MB as its floor.
5. Run `autoCompact.js` with `{ autoCompact: true, runOnce: true, freeSpaceTargetMB: T_j }`. Only files with reclaimable ≥ `T_j` compact this walk.
6. Wait for that round to finish (existing visits latch).
7. Repeat: re-snapshot and recompute the CDF (accurate) or consume the next planned cut (cheaper). Stop when remaining max is below the user floor, `compactionHelper` would say no, or recovered bytes this pass are ~0.

Work per iteration is bounded by the **high-pass on free space**, not by listing namespaces in the command.

### Placement

New monolithic script (working name `autoTrim.js`), not a preflight inside `autoCompact.js`. Coupling:

- **Plan** from a dbstats-style snapshot. Prefer consuming `dbstats.js` `output.format: json` once that path is a stable ranked list (`sort` by `freeStorageSize` / `idxFreeStorageSize` is already there; `compactOnly` verbosity is TBA).
- **Execute** by driving `autoCompact.js` (`--eval` options + `--file`), same process or a wrapper. Do not `load()` either until the library story settles. Bounce `autoCompact` command errors. Script-only keys (`maxWaitMs`, output format) live on auto-trim, not in the `autoCompact` command document. Cap waits, `quit(1)` on hard errors, and emit a JSON summary (`ok`, recovered bytes, visits, `T_j`) so cron does not scrape colour banners.
- **Oplog (opt-in only):** MongoDB 8.0+ [`compact`](https://www.mongodb.com/docs/manual/reference/command/compact/) accepts `freeSpaceTargetMB`, so auto-trim can issue a targeted `{ compact: "oplog.rs", freeSpaceTargetMB: T }` on `local` to cover the namespace autoCompact never walks. Pre-v8 has no `freeSpaceTargetMB` on `compact`; do not add an oplog path there. Compacting the oplog is **generally risky and discouraged** (capped collection, replication, lag, cache pressure). Default **off**; require an explicit flag. Prefer a secondary, `force` only if the operator really wants a primary. Same Atlas M0/Flex deny list as autoCompact — no fallback.

Direct-to-mongod only. Prefer secondaries first; the command is not replicated, so each member still needs its own trim — **`discovery.js`** owns targeting (replica-set URI without `directConnection` lands on the primary; warn / pin members). Do not add that walk to `autoCompact.js`.

### Admission control

auto-trim must **not** fire `autoCompact` / oplog `compact` on a loaded node. Reuse the same client-side admission idea as `congestionMonitor.js` / `niceDeleteMany.js` (WT dirty/updates, flow control, index builds) — inlined or sampled, not `load()`, until the library story settles.

Hard gates before **starting** a pass (and re-checked before the next CDF cut):

- **`storageEngine.backupCursorOpen`:** do not run. If a backup cursor opens **mid-pass**, send `{ autoCompact: false }` (and do not start oplog `compact`) and wait until it clears. Compact vs hot backup is checkpoint/IO contention we will not ride through.
- **Replication lag:** do not start the next pass until lag has **settled**, not merely dipped under a threshold for one sample (EWMA / “below limit for N seconds”, same hysteresis idea as niceDeleteMany: soft ~15s throttle, hard ~30s closed). Let the replica catch up after a compact-induced checkpoint burst.
- WT cache dirty / updates in the trigger band, `flowControl.isLagged`, active index builds: closed or throttle; same OPEN/THROTTLE/CLOSED/COOLDOWN shape.

Between passes, admission is the pause: no extra sleep policy unless admission is OPEN. Mid-pass, the WT thread is already walking files — the only abort we commit to is **backup cursor**. Lag and dirty wait for the visits latch, then hold the next `T_j`.

**Atlas M0 / Flex:** [`autoCompact`](https://www.mongodb.com/docs/manual/reference/command/autocompact/) and [`compact`](https://www.mongodb.com/docs/manual/reference/command/compact/) are [unsupported](https://www.mongodb.com/docs/atlas/unsupported-commands/) on Free and Flex clusters (`<$command> is not allowed…`). Auto-trim is **M10+ / dedicated / self-managed only**. Do not fall back to `compact` on those tiers — it is on the same deny list. On M0/Flex, `serverStatus` also omits WiredTiger, and free-space in dbstats is `n/a`; that is a planner stop, not a compact attempt.

### Heuristics to pin down

Free-space is typically **heavy-tailed** (one fat table, long tail). Linear steps in the target (`50% → 25% → 10% of max`, or a fixed 10–50% of the largest) do **not** linearise **work**: the first cut may hit one file, or almost everything. Use the empirical distribution of reclaimable bytes to pick cuts so each pass aims at a similar mass of I/O.

Let `x_1 ≥ x_2 ≥ … ≥ x_n` be free-space bytes (collections and indexes after excludes), `X = Σ x_i`. Complementary **mass** CDF (not file-count CDF):

```
G(T) = (Σ_{x_i ≥ T} x_i) / X     // fraction of reclaimable mass at or above target T
```

`G` is what autoCompact actually touches this pass (files with reclaimable ≥ `T`). Invert it. For `k` passes, the j-th cut is the smallest `T_j` such that

```
G(T_j) ≤ 1 - j/k
T_j = max(userFloorMB, round_up_MB(G⁻¹(1 - j/k)))
```

so pass 1 is the top `1/k` of mass, pass 2 the next `1/k`, and so on down to `userFloorMB` (default 1). That is the quantile function of the **size-biased** (mass-weighted) distribution — a Lorenz/CCDF slice, not a uniform `% of max`.

File-count quantiles (`F⁻¹` of the unweighted CDF of `x_i`) are the fallback if mass is unknown; they equalise **namespace count**, not bytes, so they are a worse lag/I/O control.

Pin down in the implementation:

- `userFloorMB` (default **1**; WT v8+ will not reclaim smaller). Do not clamp to the autoCompact server default of 20MB.
- Default `k` (or a max mass per pass, e.g. target `G` decrement of 0.1–0.2 instead of a fixed `k`).
- Recompute `G` from a fresh dbstats snapshot after each round (distribution moves) vs freeze `{T_j}` from the first snapshot.
- `compactionHelper` ratios (20% collection / 50% index reuse) as an optional **eligibility filter** before `x_i` enter `G`; the command target remains MB.
- Admission (see above): backup cursor is a hard stop; repl lag must settle before the next cut; WT dirty/flow/index-builds throttle or close.
- Atlas M0/Flex: unknown free-space is a planner stop, not a compact attempt.
- Oplog: keep `local.oplog.rs` **out** of `G` for autoCompact passes. If oplog compact is enabled, treat it as its own pass (one namespace, 8.0+ `freeSpaceTargetMB`, user floor 1MB) after or between catalog walks — not mixed into the mass CDF, so a huge oplog cannot dominate every cut. `dbstats` already flags oplog compaction as `wait`.

---

## By script

### `autoCompact.js`

Executor auto-trim will call. Keep the file standalone. Frozen at **0.4.28** for now. Direct-to-member targeting belongs in `discovery.js`; cron/JSON/wait caps belong in `autoTrim.js`.

**Shipped**

- Async IIFE (no outer `await`); `await delay()` in poll loops so `$listCatalog` can pump.
- Atlas M0/Flex fail-fast via inlined `mdblib.js` `isAtlasPlatform('sharedTier')`. `serverless` platform string kept (product is deprecated/gone). Dedicated still bounces a role-denied `autoCompact`.
- FCV 8.0+ via `serverStatus.featureCompatibilityVersion` (same round trip as `storageEngine`). Binary 8.x with FCV 7.0 fails. If FCV is not in the document, effective FCV equals the binary version (already ≥ 8).
- Opted-in `storageEngine.name` required and must be `wiredTiger` (missing name fails fast).
- `$listCatalog` pump `stop()` in a `finally` on every enable exit (cancels cursor; no re-pump after stop).
- Log watermark: `serverStatus.localTime` after the ident wait, immediately before enable. Client `ISODate()` only if `localTime` is missing.
- First-pass latch (not ramlog, not `$currentOp` — the WT thread never reports there):
  - `visits` = success + skipped* + timeout + interrupted + failed, snapshotted at enable.
  - `sizeStorer` WTCMPCT is a last-file hint.
  - `Δvisits >=` catalog ident count only after `$listCatalog` succeeds, then a visits-quiet window so the last file can finish.
  - `Δvisits > 0` and visits quiet and no WTCMPCT heartbeat.
  - no-op: no visits and no heartbeat for `NOOP_GRACE_MS` (works with `runOnce: false`, where the running bit stays true).
  - `runOnce: true` still waits for `background compact running` to clear after first pass.
  - Recovered-bytes stall is not a stop.
  - Ramlog overflow (`ΔtotalLinesWritten ≥ 1024`) is a **heartbeat**, not quiet (lost WTCMPCT must not latch mid-file). A full 1024-line snapshot keeps getLog poll at 50ms but does not count as heartbeat (chatty idle nodes stay full).
  - getLog poll: min while visits increment or first pass is still in a file; backoff only after latch or during no-op.

### `dbstats.js`

The snapshot auto-trim wants. Existing TBA that matters for that:

- Sort/limit by `compaction`, `reuse`, `idxFreeStorageSize` (hooks exist, several still TBA).
- `output.verbosity: compactOnly` — compact candidates only.
- `output.format: json` already exists; make it a ranked `{ ns, kind, freeStorageSize, storageSize }[]` that another `--file` can consume without scraping the table.
- Topology expand (`discover`, replica/sharded summary) — later, likely via discovery.

`compactionHelper` (20% collection / 50% index / 50% dbPath, plus WT min reclaim) stays the “is this worth it” predicate; auto-trim’s `freeSpaceTargetMB` is the **how much this pass** knob.

### `compact.js` / `onlineDefrag.js`

Per-namespace `compact` and update-based defrag. Not auto-trim. Auto-trim’s **opt-in oplog** path is 8.0+ `compact` + `freeSpaceTargetMB` on `local.oplog.rs`, not this script’s entropy loop. Later: point compact/rebuild at a single dbstats “compact” / “rebuild” row when autoCompact’s file walk is the wrong tool (one collection, dryRun estimate, `_id` rebuild). `compact` is also [unsupported on Atlas M0/Flex](https://www.mongodb.com/docs/atlas/unsupported-commands/); same bounce as autoCompact. Pre-v8 `compact` has no `freeSpaceTargetMB` — no oplog trim path.

### `discovery.js`

- Plugable command profiles (auto-trim / autoCompact as a per-member job).
- **Direct-to-member for compact:** replica-set URI without `directConnection=true` lands on the primary; only that process is compacted (not replicated). Warn when `hello().me` ≠ connected host, or when `isWritablePrimary` and the seed list looks like a set. Pin each member (prefer secondaries first) and run auto-trim / autoCompact per host.
- Standalone, load-balanced, arbiters.
- Execution modes: serial; shards in parallel / serial per shard; limited pool; jitter; timeout cancel.
- Target primary vs secondaries only (auto-trim wants the latter by default).
- Load / lag metrics beside each directed command.

### `congestionMonitor.js`

- Sharding (per-shard WT vitals; same need as niceDeleteMany).
- MongoDB 8 execution-control metrics.
- `bytes_dirty_intl` / `bytes_dirty_leaf` when the server exposes them.
- Pause / closed signal for auto-trim: backup cursor, repl-lag settle, WT dirty/updates (already has `backupCursorOpen`). Auto-trim is a consumer of these vitals, not a second monitor implementation if inlining is still required.

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
