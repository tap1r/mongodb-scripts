# Roadmap

Working list of planned features. Scripts stay **monolithic** (`load()` / `mdblib.js` / multi-tenant `db` injection is a separate, upcoming change — do not block features on sharing helpers). Command options are passed through; mongod already validates — bounce the error.

Status is implied by section: **planned** unless marked later / hardening.

---

## General

- **Library / `load()` / multi-tenant `db`.** `mdblib.js` today is a global `load()` with a free `db`. `ctxDemo.js` sketches `mdblib.for(db)`. That story will change; do not refactor other scripts to depend on a new module layout until it exists.
- **mongosh scripting guide.** Living notes for `--file` rewriter, async IIFEs, `sleep()` vs `await` delays, `--eval` `var` options. Extend when a script hits a new shell quirk. Document the consumption modes below when they land.
- **`ProgressTracker`.** Stub in `mdblib.js` (`/* Add to mdblib.js */`) for long catalog walks (dbstats, index cache, auto-trim snapshot). Must honour the shared emit rules: TTY progress only; silent or JSON progress events in module / redirected mode — never `\r` bars in piped logs.
- **Topology fan-out.** Per-mongod tools (`autoCompact`, WT vitals, dbstats snapshots) eventually ride `discovery.js`. Until then, operators target members with a direct connection.

### Script consumption (unify standalone vs modular)

Today scripts sit on a spectrum: **standalone CLI** (`mongosh --file`), **modular support** (`load()` / call from another script), or **both awkwardly** (e.g. `compact.js` re-`load()`s `dbstats.js` and re-runs the full interactive report). Longer-term goal: one simple consumption model so any script can be an operator tool *or* a reliable subroutine (especially under `discovery.js`) without scraping banners.

#### Shared emit / logging

Homogenise how scripts talk to the console — prefer a small shared emit surface in `mdblib` (or a thin wrapper every script uses) rather than ad-hoc `console.log` / raw `\x1b` / `\r` progress:

| Channel | Interactive TTY | Redirected / piped / non-TTY | Module / non-interactive |
|--------|------------------|------------------------------|---------------------------|
| Human report | Colour markup (`[yellow]…[/]`), tables, banners | **Strip ANSI** (already partly done when `mdblib` overloads `console.log`) | Off — no report noise |
| Warnings / errors | Coloured | Plain text, still on stderr if we split streams later | Structured fields on the result object (`warnings[]`, `ok`) and/or minimal plain stderr |
| Progress (`ProgressTracker`, spinners) | `\r` / bar updates | **Suppressed** (or single-line plain milestones) | Off — optional `onProgress` callback only |
| Result payload | Optional | Optional | **Primary:** return / assign the JSON contract |

Rules of thumb:

- Any **console redirection** always strips ANSI tags and drops verbose UI (progress bars, live `\r` redraws, “press enter” affordances).
- Colour markup stays the authoring style; emit layer decides TTY vs plain. Scripts that bypass `mdblib`’s `console.log` overload (raw escapes, `print`, mixed `console._log`) should be brought onto the same path.
- Cron / CI / `discovery` fan-out must never depend on scraping colour tables.

#### Non-interactive / module mode

A first-class mode (option flag and/or “called as support function” detection) where the script:

1. Runs the same core logic as CLI.
2. **Does not** print the interactive report by default.
3. Returns (or binds) a **versioned JSON contract** — “peel away the keys”: stable, documented fields other scripts rely on; no TTY-only decorations, no transient UI state.
4. Surfaces soft failures as data (`unauthorized` namespaces, skipped nodes, warnings), hard failures as thrown / `ok: false`.

Callers such as **`discovery.js`** treat that JSON as the job result per host. Planners (**auto-trim**) and executors consume the same object. CLI `output.format: json` should be the same contract printed once, not a parallel ad-hoc dump.

Entry-shape sketch (exact API TBD with the library story):

```text
interactive CLI:  gather → emit(report) → optional return
module mode:      gather → return contract   (emit only if caller asks)
```

Do **not** block feature work on a full `mdblib.for(db)` redesign; a convention (`options.output.mode: 'interactive' | 'module'`, or `collect*()` vs `main()`) can land first inside each script, then homogenise emit helpers when the library path settles.

### User options UX (streamline past `--eval` globals)

Passing knobs today is janky and inconsistent, mostly because of **mongosh** — not because a document of options is wrong:

- **`--eval 'var options = {…}'` + `--file`** is the documented pattern ([mongosh scripting guide](mongosh-scripting-guide.md)): `--eval` must use `var`, the script must **not** declare the same binding, probe `typeof … === 'undefined'`, then merge. Easy to get wrong (`let`/`const` redeclaration, nested shallow merge, different global names per script).
- Global name drift: `options` vs `autoCompactOptions` vs bare scalars (`intervalHrs` in oplogchurn).
- Nested defaults are shallow-merged in places (dbstats `sort.*`), so a partial override can wipe sibling keys.
- Shell quoting of inline JS objects is hostile (regex literals, nested quotes, Windows).
- mongosh owns `argv` / connection flags; scripts do not get a clean POSIX flags surface after `-f` without careful parsing of leftovers or an outer wrapper.
- Module callers (`discovery`, auto-trim) want a **plain object argument**, not a side-effect global.

**Direction (preferred):** treat options as a **layered resolve**, with **config file + CLI flags** as the happy path and `--eval` as a thin override — not the primary UX.

```text
defaults  →  config file (JSON/EJSON)  →  env (few keys)  →  CLI flags  →  --eval overlay  →  validate
                                                                    ↑
                                                         module caller passes object here
```

#### 1. Config file (primary for real use)

- Support something like `--eval 'var optionsFile = "…/dbstats.json"'` **or** a first-class flag once a tiny argv helper exists: `mongosh … -f dbstats.js -- --config ./dbstats.json` (convention: script-owned args after `--` if mongosh leaves them on `process.argv`).
- File format: JSON or EJSON (dates, Longs if ever needed). Same schema as the in-script `options` document / module contract.
- Search path optional later: explicit path → `$MDBOPTIONS` / per-script env → `~/.mongodb/<script>.json` → cwd (mirror how `MDBLIB` is found).
- Operators edit a file once; cron and docs quote a path, not a JS object.

#### 2. CLI flags (secondary, ergonomic subset)

- Homogenise a **small** flag surface for common knobs, not a 1:1 map of every nested key. Examples: `--config`, `--format json|tabular|html`, `--module` / `--quiet-out`, `--filter-db`, `--top N`, `--concurrency N`.
- Implementation sketch: shared `parseScriptArgv(process.argv)` in `mdblib` that only reads operands after `--` (or a documented prefix) so mongosh URI/TLS flags stay untouched.
- Flags override file; keep the full nested document available for power users via file/`--eval`.
- Optional **shell wrappers** (`bin/dbstats`, `bin/auto-compact`) that translate friendly flags into `mongosh` + config/overlay — useful when argv through mongosh is too painful; wrappers stay thin.

#### 3. `--eval` overlay (one-offs and backward compatible)

- Keep working forever for REPL and quick experiments: `var options = { output: { format: 'json' } }`.
- Shared **`resolveOptions({ defaults, names, file, argv, evalGlobal })`**: deep-merge, normalise aliases (`table`→`tabular`), validate, return `{ ok, options, warnings, source }`.
- Standardise on **one eval global name per script** (prefer `options`, with a documented alias for existing `autoCompactOptions` during transition).
- Deep merge by section so partial `{ sort: { collection: { dataSize: -1 } } }` does not clobber other sort keys.

#### 4. Module / discovery path

- Non-interactive callers pass the options object **as a function argument** (`collectDbStats(db, options)`), never by setting a global. Same schema as the file/CLI document.
- Orchestrators (discovery job profile, auto-trim) own the merged document and hand it down; child scripts do not re-read argv.

#### 5. What we will not chase

- A full second copy of mongosh’s own CLI parser.
- Requiring Node/`import` modules before the library story settles — file + `load()`-friendly helpers first.
- Blocking script features on wrappers; wrappers are sugar over the same resolver.

Pin in the scripting guide when the resolver lands: one canonical example (file, flags, `--eval`, module) and a short “don’t declare `options` in the file” checklist. Roll out with **dbstats** / **autoCompact** first (highest option surface and consumer demand), then align others opportunistically.

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

- **Plan** from a dbstats-style snapshot. Prefer consuming `dbstats.js` `output.format: json` once that path is a **stable, versioned** ranked list (see `dbstats.js` → Output formats). `sort` by `freeStorageSize` / `idxFreeStorageSize` hooks exist; `compactOnly` / hot top-N verbosity is TBA. Do not scrape tabular banners.
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

The storage snapshot other scripts want (auto-trim planner, discovery-directed jobs, later compact/onlineDefrag targeting). Current shape is still gather+print in one pass; the roadmap below assumes a **catalog-first, then stats** split so new catalog sources and output formats share one walk.

Shipped recently: views listed once on the nameOnly pass; collection `$collStats` remains the second phase (Unauthorized → `name (unauthorized)`); databases sorted once after the fetch pool; section deep-merge for options (`filter` / `sort.*` / `output`); `output.format` canonical name `tabular` with `table` alias; `formatPct` / `formatRatio` guard zero/non-finite divisors (`n/a` instead of `NaN%` / `Infinity:1`).

#### Output formats

- **`json` (near-term contract).** Today `output.format: json` mostly returns the internal tree / skips a stable print path. Promote it to a **documented, versioned object** other `--file` scripts can consume without scraping colour tables — same payload as **module / non-interactive mode** under [Script consumption](#script-consumption-unify-standalone-vs-modular). Consumers in mind: `autoTrim.js` (rank reclaimable), `discovery.js` (per-node job payloads), later `autoCompact` / `compact` / `onlineDefrag` targeting. Prefer a ranked flat list *and* the hierarchical rollup (db → collection → index), e.g. namespaces as `{ ns, kind, dataSize, storageSize, freeStorageSize, objects, compaction, … }[]` plus cluster/dbPath totals. Keep `n/a` free-space as `null`, not `0` (Atlas M0/Flex). Peel the contract to stable keys; do not leak printer-only fields.
- **`html`.** Build from the same JSON object (embed or fetch), not a parallel printer. Interactive table via a browser-side helper such as **Sortable.js** (sort by size / free / reuse / objects without re-running mongosh). Colour / verbosity options feed the same payload.
- **Aspirational — live HTML.** HTML page calls script-side / local API hooks for refresh (re-snapshot without a full page reload). Depends on a durable run mode or companion listener; do not block the static JSON→HTML path on it.
- Existing TBA that still matters for planners: sort/limit by `compaction`, `reuse`, `idxFreeStorageSize`; `output.verbosity: compactOnly` (candidates only); format aliases (`tabular` / `table`) cleaned up when JSON is formalised.

`compactionHelper` (20% collection / 50% index / 50% dbPath, plus WT min reclaim) stays the “is this worth it” predicate; auto-trim’s `freeSpaceTargetMB` is the **how much this pass** knob.

#### Dual catalog builder

Namespace discovery should **bifurcate**, then feed one shared stats walker (avoid duplicating `$collStats` / MetaStats / print paths):

| Builder | When | Notes |
|--------|------|--------|
| **Legacy** | Default / fallback | Today’s `listDatabases` + `getCollectionInfos` (`nameOnly` + `authorizedCollections`) so partial-privilege users still see names; `$collStats` may tag `(unauthorized)`. |
| **`$listCatalog` / `$listClusterCatalog`** | Newer servers when available and authorised | More efficient catalog materialisation. `$listCatalog` from **6.0+** (authz barriers and reliability issues on some past releases — treat as best-effort). `$listClusterCatalog` from **8.0.10+**, docs mark it **unsupported / unstable** — optional fast path on mongos/cluster views, never the only path. |

Selection: capability + privilege probe, with explicit option to force legacy. On catalog-stage failure or authz denial, fall back to legacy without aborting the report.

**Refactor implication:** build the **whole catalog first** (names, types, shard placement if known), *then* walk that list for component statistics. That unlocks dual builders and a clean concurrency boundary without forking the rest of the script. Entity shape should follow the [`MetaStats` redesign](#metastats--typed-storage--topology-model) (catalog nodes first; stats via `fetchStats` / `materialize`, not kitchen-sink constructors + `delete`).

#### Concurrency (stats fetch)

Once the catalog is materialised, fetch collection/index WT stats through a **bounded task pool** (optimal vs unbounded `Promise.all` on large catalogs). Pool size as an option (default conservative on mongos). `ProgressTracker` in `mdblib` is the progress UI for long walks. Catalog build stays serial or lightly parallel; the pool applies to the stats phase.

#### Sharding and topology

- **mongos gaps:** mongos does not surface **local** namespaces the way a mongod does; shard-local-only or `local.*` views need explicit handling (per-shard direct stats, or document as out-of-scope on pure mongos). Improve sharded rollups (per-shard namespace/index counts already exist; make local/system coverage honest).
- **Per-node stats:** discover the full topology (replica set members and/or shards) and emit **per-node** storage snapshots, not only the router aggregate. Prefer riding **`discovery.js`** for fan-out (same story as auto-trim / autoCompact); dbstats stays the measurement payload. Options TBA already sketch `topology.discover` / replica / sharded summary|expanded.
- Standalone and single-mongod paths unchanged.

#### Hot summary

A compact “hot” report mode (verbosity or dedicated format): **top-N namespaces** only — by absolute `storageSize` / `dataSize`, or by **most recoverable** bytes (`freeStorageSize` / index reusable). Natural feed for auto-trim’s first cut and for operators who do not want the full table. N and rank key are options; JSON shape should be the same ranked list truncated.

### `compact.js` / `onlineDefrag.js`

Per-namespace `compact` and update-based defrag. Not auto-trim. Auto-trim’s **opt-in oplog** path is 8.0+ `compact` + `freeSpaceTargetMB` on `local.oplog.rs`, not this script’s entropy loop. Later: point compact/rebuild at a single dbstats “compact” / “rebuild” row when autoCompact’s file walk is the wrong tool (one collection, dryRun estimate, `_id` rebuild). `compact` is also [unsupported on Atlas M0/Flex](https://www.mongodb.com/docs/atlas/unsupported-commands/); same bounce as autoCompact. Pre-v8 `compact` has no `freeSpaceTargetMB` — no oplog trim path.

### `discovery.js`

- Plugable command profiles (auto-trim / autoCompact as a per-member job; **dbstats in module mode** as a measurement profile — JSON contract per host, no interactive table on the wire).
- Prefer invoking support scripts in **non-interactive / module mode** so fan-out results are structured (`ok`, host, payload, warnings), not ANSI logs to stitch together.
- **Direct-to-member for compact / per-node dbstats:** replica-set URI without `directConnection=true` lands on the primary; only that process is compacted (not replicated), and mongos-level dbstats misses mongod-local namespaces. Warn when `hello().me` ≠ connected host, or when `isWritablePrimary` and the seed list looks like a set. Pin each member (prefer secondaries first) and run auto-trim / autoCompact / dbstats per host.
- Standalone, load-balanced, arbiters.
- Execution modes: serial; shards in parallel / serial per shard; limited pool; jitter; timeout cancel. (dbstats’ internal stats **task pool** is separate — discovery owns cross-host fan-out.)
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
- **Shared emit helpers** (see [Script consumption](#script-consumption-unify-standalone-vs-modular)): finish the story beyond today’s `console.log` TTY overload — one path for markup→ANSI, non-TTY strip, progress suppress, and module-quiet. Bring `print` / raw-escape call sites onto it over time.
- Finish TBA namespace listers (`getAllNonSystemNamespaces`, views, system).
- `AutoFactor` NaN / scale clamp (the copy in `autoCompact.js` is stricter).
- `$genRandWord`, `$benford` — later / fuzzer.
- **`MetaStats` redesign** — see below; underpins dbstats catalog-first work and discovery’s per-node payload shape.

#### `MetaStats` → typed storage / topology model

Narrow but deep. Today `MetaStats` is a kitchen sink: one constructor accepts db-shaped and collection-shaped inputs, merges counters that mean different things (`collections` as list vs count, `indexes` as list vs count), applies version/Atlas heuristics inline, and relies on callers (`dbstats.js`) to `delete` host/cluster fields that do not belong at that level. `init()` then bolts on hostname / proc / dbPath / shards. That conflates **parsing**, **entity modelling**, and **topology**.

##### 1. Consistent parsers → stable contracts

Split “talk to the server / normalise history” from “be a domain object”:

| Layer | Responsibility |
|-------|----------------|
| **`$stats` / `$collStats` (or successors)** | Fetch raw commands; remain the only place that knows mongod version quirks, `freeStorage` option gating, sharded `raw` rollups, Atlas M0/Flex “hidden free-space → `null`”, Unauthorized stubs, BSON number coercion. |
| **Pure normalisers** | `parseDbStats(raw) → DbStatsDTO`, `parseCollStats(raw) → CollStatsDTO`, `parseIndexStats(…) → IndexStatsDTO`. Idempotent, no `db` global, unit-testable with fixtures from old/new server shapes. |
| **Entity classes** | Construct **only** from DTOs (or explicit fields). No “if collections is array vs number” in the constructor. |

Goal: one documented field contract per level (`freeStorageSize: number | null`, `indexes: Index[]` vs `nindexes: number`, never overloaded). Version drift dies in the parser, not in `new MetaStats` or in printers.

##### 2. Stop the kitchen sink — specialised types

Prefer **composition** (and light inheritance only where behaviour is truly shared) over one class + `delete`:

```text
StorageMetrics          // dataSize, storageSize, freeStorageSize, objects, compression getter, compactionHelper hooks
  ├─ IndexStats         // name + StorageMetrics (+ idx-specific)
  ├─ CollectionStats    // name, compressor, indexes: IndexStats[], orphans, …
  ├─ ViewRef            // name (no WT stats)
  ├─ DatabaseStats      // name, collections[], views[], rollup metrics, per-shard count arrays when sharded
  └─ DbPathStats        // rollup over databases on one node (what dbstats “dbPath totals” is today)
```

Shared bits (format helpers, compression, reuse ratios) live on `StorageMetrics` or plain functions — not by stuffing `databases` / `hostname` / `shards` onto every collection row. **No caller-side `delete` to reshape the model.**

Migration: keep `MetaStats` as a thin deprecated façade over the new types until dbstats/oplogchurn call sites move.

##### 3. Topology superset (prudent if composed)

A **cluster / topology object** that also captures host- and cluster-level detail is a good idea **as a container**, not as “MetaStats grew more fields”:

```text
TopologySnapshot          // discovery-aligned
  ├─ cluster: { kind, setName?, shards? }
  ├─ nodes: HostNode[]    // hostname, proc, me, dbPath, role, tags…
  │    └─ catalog + stats // DatabaseStats / CollectionStats for that node
  └─ aggregate?           // optional mongos-level rollup (knows local NS gaps)
```

Why this helps discovery: fan-out returns `HostNode` payloads; dbstats module mode returns `DbPathStats` or `TopologySnapshot` depending on scope; auto-trim consumes per-node catalog metrics without scraping. Host identity (`init()` today’s job) belongs on `HostNode`, not on every collection.

Avoid a single mutable god-object that mixes router aggregate and per-shard mongod state without labelling which is which (mongos local-NS gap stays explicit).

##### 4. Experimental — catalog first, stats lazy

Aligns with dbstats “build catalog, then task-pool stats,” but pushes laziness into the model:

- **Build** topology + namespace catalog first (cheap nameOnly / `$listCatalog`): entities exist with identity and `stats: unset`.
- **Fill** storage attributes on demand.

**Recommendation:** use **explicit async loaders**, not magic getters, as the primary API:

```text
await collection.fetchStats()           // one NS
await database.fetchAllStats({ concurrency })
await node.materialize({ concurrency }) // bounded pool — same pool story as dbstats
```

Optional **lazy getters** as REPL sugar only (`get stats()` that throws if not loaded, or returns a Promise — but Promise-returning getters are easy to misuse with the async rewriter and with `JSON.stringify`). For module/JSON/discovery, always **`materialize()` then serialise** so the contract is a plain snapshot, not a live graph.

Scaling notes:

- Laziness shines for hot summary / single-NS drill-down / unauthorized skip.
- Full dbstats report and auto-trim planners should materialise in a **bounded pool** (not unbounded getter storms).
- Cache fetches on the entity (`_statsPromise`) to avoid duplicate `$collStats` under parallel walkers.
- Catalog identity must remain available when stats fail (existing `(unauthorized)` behaviour).

##### Suggested order

1. Extract DTO normalisers from `$stats` / `$collStats` (behaviour-preserving).
2. Introduce `StorageMetrics` + `CollectionStats` / `DatabaseStats`; point dbstats at them; delete the `delete` soup.
3. `HostNode` + optional `TopologySnapshot` when discovery per-node dbstats lands.
4. Catalog-first + `fetchStats` / `materialize` (task pool); experiment with lazy getters only behind an interactive flag.

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
