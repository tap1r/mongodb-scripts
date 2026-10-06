# Roadmap

Working list of planned features. Scripts stay **monolithic** (`load()` / `mdblib.js` / multi-tenant `db` injection is a separate, upcoming change — do not block features on sharing helpers). Command options are passed through; mongod already validates — bounce the error.

Status is implied by section: **planned** unless marked later / hardening.

---

## General

- **Library / `load()` / multi-tenant `db`.** `mdblib.js` today is a global `load()` with a free `db`. `ctxDemo.js` sketches `mdblib.for(db)`. That story will change; do not refactor other scripts to depend on a new module layout until it exists.
- **mongosh scripting guide.** Living notes for the `--file` rewriter, async IIFEs, result-field parentheses, shell vs driver `toArray()`, `sleep()` vs `await` delays, `--eval` `var` options, JSONC overlays, and CLI vs `load()`. Extend when a script hits a new shell quirk.
- **Required context.** A script header `Roadmap: … (required context)` means this file is an input to edits of that script. Open the matching [By script](#by-script) section before changing it. The tag is not a version pin.
- **`MiniHud` / `mapPool`.** Shipped in `mdblib.js` **v0.17.0** (`process.stdout.write('\\r')`, never `console.log`). **dbstats P1** (v0.14.3) is the first consumer: catalog-first `N`, then a global `$collStats` in-flight cap drives a TTY mini-HUD (`done/total`, in-flight/queued, optional ETA); `onDatabase` still rolls each DB when its collections complete. Shared emit rules: TTY progress only; silent in json / html / redirected mode — never `\\r` bars in piped logs. Finite walks (dbstats) may show % / ETA; long-running AIMD tools (niceDeleteMany) stay congestion-only. Clear the HUD before the tabular report.
- **Topology fan-out.** Per-mongod tools (`autoCompact`, WT vitals, dbstats snapshots) eventually ride `discovery.js`. Until then, operators target members with a direct connection.
- **Legacy mongo shell retirement.** Dual-shell tree archived **2026-09-01** at [`legacy/mongo-shell/src/`](legacy/mongo-shell/src/) (tag `legacy-mongo-shell` on `c78904f`). Live `src/` is **mongosh-only** after the [strip pass](#3-after-the-cut--strip-and-streamline-next-general-architecture). Current library: **`mdblib.js` v1.1.0**.

### Legacy mongo shell retirement

**Done.** Dual `mongo` / `mongosh` in one file was the tax until the snapshot. Archive keeps `_getEnv`, `slaveOk`, dual `Timestamp`, boolean `getCollectionInfos`, command-body `options`, and the missing-`console` polyfill. Live `src/` does not. Feature work (auto-trim, emit/options UX, discovery) proceeds on the mongosh line only.

#### 1. Nominal correctness first

Reach a **good-enough** dual-shell snapshot. The bar can be arbitrary, but it should be explicit when drawn, for example:

- Scripts that claim to run under `mongo` actually parse (similar SyntaxErrors).
- Known wrong-result bugs that dual-shell users would inherit (invalid `$expr`, `--eval` shadowing) are either fixed or documented as wontfix in the archive notes. `fCV()` → `serverVer()` on Atlas M0/Flex is **by design** (`getParameter` FCV is restricted there; Atlas is not left on a lagging FCV).
- Version strings and `__script.version` are consistent with the freeze (one patch ahead of the last dual-shell HEAD).

**Per-script adequacy (complete for current `src/`; remaining rows frozen as-is):**

| Script | Dual-shell adequacy line | Notes |
|--------|--------------------------|--------|
| **`dbstats.js`** | **v0.12.19** (+ **`mdblib.js` ≥ 0.15.8**) | Hygiene complete (A1–A8); legacy Unauthorized labels; authz preflight; `filter.system`; ANSI tag table uses a plain object (no `Map`). Further dbstats work (JSON contract, module mode, catalog dual-path, task pool) is **mongosh-line** — do not block the archive on B/C/D/E. Header documents this freeze. |
| **`autoCompact.js`** | **v0.4.36** (mongosh-only) | Not dual-shell (`async` IIFE, `await delay`, mongosh `getLog` / `$listCatalog`). Demarked for the whole-tree freeze anyway. Further work (first-pass progress bar, auto-trim executor) is **mongosh-line**. Header documents this freeze. |
| **`compact.js`** | **v0.2.15** (+ **`mdblib.js` ≥ 0.15.8**) | Parse bar: dropped uninitialized `const reportLog`. Dual-shell via mdblib (`console` polyfill, `isMongosh()` / `shellVer(2.0)` `runCommand` options). `load('fuzzer.js')` uses fuzzer’s own namespace constants; `load('dbstats.js')` prints the full interactive report (compact’s `options` has no `filter`) — consumption/module-mode, not freeze-blocking. Further work (dbstats JSON contract, discovery fan-out, Atlas M0 bounce) is **mongosh-line**. Header documents this freeze. |
| **`explainHisto.js`** | **v0.1.4** (mongosh-only) | Not dual-shell (`require` / `jsonc-require` / `./pipeline.jsonc`). Parse bar: duplicate `const pipeline` → `userPipeline`. Demarked for the whole-tree freeze anyway. Further work (sharded/newer explain stages, `--eval` overlay, sampled-pipeline caveat) is **mongosh-line**. Header documents this freeze. |
| **`fuzzer.js`** | **v0.6.43** (+ **`mdblib.js` ≥ 0.15.8**) | Dual-shell via mdblib. Dropped `Mongo.setReadPref('primary')` (mongosh reconnect hung the first DB call after local sampling on a replica set). `await main()` try/catch. Hardcoded `dbName`/`collName` (compact `load()` does not overlay). Reshard monitor is mongosh-strong / mongo-weak. Further work (`--eval` overlay, `$genRandWord`) is **mongosh-line**. Header documents this freeze. |
| **`onlineDefrag.js`** | **v0.1.4** (mongosh-only) | Not dual-shell (`async` IIFE, `process`/`fs`, `console.table`). `--eval` `var dbName`/`collName`/`options` overlay (no in-file bindings). `storageStats()` finds `dbstats.js` via MDBLIB / `~/.mongodb` / cwd. Demarked for the whole-tree freeze anyway. Further work (dbstats JSON/`dbStats` return, mdblib, WT v7 checkpoint) is **mongosh-line**. Header documents this freeze. |
| **`oplogchurn.js`** | **v0.5.22** (+ **`mdblib.js` ≥ 0.15.8**) | Dual-shell via mdblib. Per-command RP (`aggregate` `readPreference` on mongosh; `cursor.readPref` on legacy mongo). Do not restore `slaveOk(readPref)`. `--eval var intervalHrs` overlay kept. Dual `Timestamp` (MONGOSH-930). Further work (TTY-guard `console.clear`, Atlas M0 oplog/hostInfo) is **mongosh-line**. Header documents this freeze. |
| **`latency.js`** | **v0.4.9** (mongosh-first) | Dual-shell lite: inline `console`/`EJSON` polyfill, no mdblib. `$function`+`sleep` synthetic slow op (Flex / `javascriptEnabled`). `getLog` + EJSON to recover `durationMillis`. Further work (`$sleep`, Flex bounce, mdblib) is **mongosh-line**. Header documents this freeze. |
| **`schema-sampler.js`** | **v0.2.16** (dual-shell lite) | No mdblib. Dropped `Mongo.setReadPref`; `$sample` per-command RP (mongosh `options.readPreference`; mongo `cursor.readPref`). `listDatabases`/`getCollectionInfos` stay on the connected node. Further work (mdblib, `filter.db` actually applied, `--eval` overlay) is **mongosh-line**. Header documents this freeze. |
| **`schema-import.js`** | **v0.1.8** (mongosh-only) | Companion stub to schema-sampler. Dropped `Mongo.setReadPref`. `fs.readFileSync` schema JSON; create collection/index/view still commented. In-file `const userOptions` is not an `--eval` overlay. Further work (apply sampler JSON) is **mongosh-line**. Header documents this freeze. |
| **`indexCacheUtil.js`** | **v0.1.5** (mongosh-only) | Not dual-shell (`async` IIFE, `Promise.allSettled`). `$collStats` index cache bytes vs WT `serverStatus` cache. Do not top-level-await. Further work (sharding, `runCommand`, admin/config/local scope) is **mongosh-line**. The live line shipped the pool, `$listCatalog`, and the bracketed cache sample in **v1.0.0**, and the per-index lines, collection-btree bytes, and non-page-image gap in **v1.1.0**. **v1.2.0** includes `admin` / `config` / `local` and `system.*` / `replset.*` where authz allows. Header documents this freeze. |
| **`connStats.js`** | **v0.1.14** (mongosh-only) | `$currentOp` pool stats with inprog fallback (`allUsers: false`). IPv6-bracket client parse. Further work (`whatsmyuri`, DRIVERS-3027, mongos `targetAllNodes`) is **mongosh-line**. Header documents this freeze. |
| **`mdblib.js`** | **v0.15.10** | Dual-shell library snapshot. `fCV()` → `serverVer()` on Atlas M0/Flex is **by design** (`getParameter` FCV restricted; Atlas not on a lagging FCV). `slaveOk()` mongosh path can `setReadPref` (callers use per-command RP). `shellVer`/`serverVer` `+"x.y"` (2.10 ≡ 2.1) stays. Further work (`for(db)`, MetaStats, integer version parse) is **mongosh-line**. Header documents this freeze. |
| **`discovery.js`** | **v0.2.1** (mongosh-only) | Not dual-shell (`async` IIFE, named capture groups). Topology fan-out stub; cmd profiles TBA. Do not top-level-await. Do not strip `(?<setName>)` for mongo. Further work (standalone/LB/arbiters, pool/jitter, primary-vs-secondary targeting) is **mongosh-line**. Header documents this freeze. |
| **`niceDeleteMany.js`** | **v0.4.11** (mongosh-only) | Not dual-shell (`async` IIFE, `?.`). `--eval var` overlay (`typeof` probes; no in-file `const dbName`). Per-command RP (no `setReadPref`). Further work (per-shard WT via discovery) is **mongosh-line**. Header documents this freeze. |
| **`congestionMonitor.js`** | **v0.2.13** (mongosh-only) | Not dual-shell (`async` IIFE, `sleep` poll). Known: `.finally(process.stdout.write(…))` runs immediately — **freeze as-is** (wontfix on this line). Further work (sharding, v8 execution control, `bytes_dirty_intl`/`leaf`, auto-trim pause signal) is **mongosh-line**. Header documents this freeze. |
| **`batchUpdater.js`** | **v0.1.6** (mongosh-only) | In-file `const dbName`/`collName` (not an `--eval` overlay). Known invalid `$expr` / `endValue === null` — **freeze as-is**. Further work (query `$type`, `--eval var`) is **mongosh-line**. Header documents this freeze. |
| **`killAgedSessions.js`** | **v0.2.2** (mongosh-only) | Async generator + batch `killSessions`. `--eval` examples use `let` (not `var`). Further work is **mongosh-line**. Header documents this freeze. |
| **`rtt.js`** | **v0.3.0** (mongosh-only) | Application RTT from mongosh topology/private API. Further work (TODOs) is **mongosh-line**. Header documents this freeze. |
| **`sleepy.js`** | **v0.2.6** (dual-shell lite) | Inline `console` polyfill; `$sleepy` agg PoC vs `$function` `sleep()`. Further work is **mongosh-line**. Header documents this freeze. |
| **`docSizes.js`** | **v0.1.34** (mongosh-only) | `$sample` BSON/page size histogram. In-file `const options` is not an `--eval` overlay. Further work is **mongosh-line**. Header documents this freeze. |
| **`oidGenerator.js`** | **v0.2.7** | Aggregation OID generator (mongod 5.0+). Further work is **mongosh-line**. Header documents this freeze. |
| **`oidFunction.js`** | **v0.1.5** | OID view/`$function` reproduction (mongod 5.0+). Further work is **mongosh-line**. Header documents this freeze. |
| **`ctxDemo.js`** | **v0.1.0** (mongosh-only) | `mdblib.for(db)` sketch; stand-in lib, no `load('mdblib.js')`. Freeze as-is. Header documents this freeze. |
| **`modifiedCountDocumentsByKey.js`** | **v0.1.7** (mongosh-only) | `countDocuments` prototype overload. Further work is **mongosh-line**. Header documents this freeze. |
| **`pcg-xsh-rr.js`** | **as-is** (no `Version`) | PCG RNG helper. Freeze as-is. |
| **`aggregation-template.js`** | **as-is** (no `Version`) | Aggregation snippets. Freeze as-is. |
| **`misc-scripts.js`** | **as-is** (no `Version`) | Unsorted snippets. Freeze as-is. |

Do **not** require auto-trim, `mdblib.for(db)`, or a unified options resolver before the cut. Those land on the mongosh-only line.

#### 2. Line in the sand

**Drawn 2026-09-01.** Adequacy table in §1 is complete (remaining rows frozen as-is). Snapshot:

| | |
|--|--|
| Archive path | [`legacy/mongo-shell/src/`](legacy/mongo-shell/src/) |
| README / DISCLAIMER | [`legacy/mongo-shell/README.md`](legacy/mongo-shell/README.md), [`legacy/mongo-shell/DISCLAIMER.md`](legacy/mongo-shell/DISCLAIMER.md) |
| Git tag | `legacy-mongo-shell` on `c78904f` (pushed) |
| Frozen library | `mdblib.js` **v0.15.10** |
| mongosh floor (GA `src/`) | **1.10 / 2.10+** (raise only with a later floor decision) |
| mongod / legacy `mongo` floors in the archive | **4.4** |

No further dual-shell feature work on the archived line. Operators who still have `mongo` use the archive. Operators on mongosh use repository `src/`.

**GA `src/` (master, mongosh-only).** Live versions have moved past the freeze. Archive-only (not in live `src/`): `compact.js`, `batchUpdater.js`.

| Script | Archive freeze | Live `src/` |
|--------|----------------|-------------|
| `mdblib.js` | 0.15.10 | **1.1.0** |
| `dbstats.js` | 0.12.19 | **1.2.3** |
| `autoCompact.js` | 0.4.36 | **1.3.0** |
| `fuzzer.js` | 0.6.43 | **1.5.0** |
| `oplogchurn.js` | 0.5.22 | **0.6.0** |
| `latency.js` | 0.4.9 | **0.4.10** |
| `schema-sampler.js` | 0.2.16 | **0.2.17** |
| `sleepy.js` | 0.2.6 | **0.2.7** |
| `docSizes.js` | 0.1.34 | **0.1.35** |
| `niceDeleteMany.js` | 0.4.11 | **1.0.0** |
| `congestionMonitor.js` | 0.2.13 | **0.4.0** |
| `onlineDefrag.js` | 0.1.4 | **1.7.0** |
| `indexCacheUtil.js` | 0.1.5 | **1.2.0** |
| `compact.js` | 0.2.15 | **removed** (archive only) |
| `batchUpdater.js` | 0.1.6 | **removed** (archive only) |

Unchanged vs freeze (still in live `src/`): `explainHisto` 0.1.4, `schema-import` 0.1.8, `connStats` 0.1.14, `discovery` 0.2.1, `killAgedSessions` 0.2.2, `rtt` 0.3.0, `oidGenerator` 0.2.7, `oidFunction` 0.1.5, `ctxDemo` 0.1.0, `modifiedCountDocumentsByKey` 0.1.7.

#### 3. After the cut — strip and streamline (next general architecture)

**Executed in live `src/` (`mdblib.js` v0.15.11, now v0.15.13).** Archive is unchanged. Remaining helper work (`for(db)`, MetaStats) is not this pass.

Done in this pass:

- Dropped `isMongosh()` branches that existed only for legacy `mongo`. `isMongosh()` remains as `typeof process !== 'undefined'`. `shellVer(2.0)` still gates mongosh 1.x vs 2.x (`toSorted`, `runCommand` options).
- Removed `slaveOk()`. Callers use per-command `readPreference` (see [mongosh scripting guide](mongosh-scripting-guide.md)).
- `Timestamp({ t, i })` only; `getCollectionInfos(filter, { nameOnly, authorizedCollections })`; `runCommand(cmd, options)` as the second argument (`serverStatus` no longer embeds `{ options }` in the command body).
- Dropped the missing-`console` polyfill. `bsonsize` / `tojson` / `hex_md5` still defined if absent.
- `serverVer` / `fCV` / `shellVer` use integer `major.minor.patch` (2.10 ≠ 2.1). M0/Flex `fCV` still falls back to binary. mongos uses the `getParameter` FCV document when present.
- Usage / `--eval` examples are mongosh + `var` + Node (`process`, `fs`, `setTimeout`). Loaders use `process.env.MDBLIB` / `fs.existsSync` only.

This pass is **shim deletion and helper streamlining**, not the `mdblib.for(db)` redesign. Namespaced `load()` stays a separate General item and still must not block features. Do not restore `_getEnv` loaders, `slaveOk()`, dual `Timestamp(t, i)`, or `[mongo|mongosh]` usage lines in live `src/`.

#### 4. What we will not do

- Maintain two live dual-shell lines after the tag.
- Silently break `mongo` in `src/` before the archive is in place.
- Raise the **mongod** floor as part of this cut unless it is already implied (legacy `mongo` 4.4 was the reason some 4.4 branches exist; mongosh-only may still talk to 4.4 servers until a separate server-floor decision).

Cut date, tag name, mongosh floor, and archive path are pinned in §2. Dual-shell bugs in live `src/` are **mongosh-line** (or archive-only critical fixes). Do not keep a second live dual-shell branch.

### Script consumption (unify standalone vs modular)

Today scripts sit on a spectrum: **standalone CLI** (`mongosh --file`), **modular support** (`load()` / call from another script), or **both awkwardly** (e.g. `compact.js` re-`load()`s `dbstats.js` and re-runs the full interactive report). Longer-term goal: one simple consumption model so any script can be an operator tool *or* a reliable subroutine (especially under `discovery.js`) without scraping banners.

#### Shared emit / logging

Homogenise how scripts talk to the console — prefer a small shared emit surface in `mdblib` (or a thin wrapper every script uses) rather than ad-hoc `console.log` / raw `\x1b` / `\r` progress:

| Channel | Interactive TTY | Redirected / piped / non-TTY | Module / non-interactive |
|--------|------------------|------------------------------|---------------------------|
| Human report | Colour markup (`[yellow]…[/]`), tables, banners | **Strip ANSI** (already partly done when `mdblib` overloads `console.log`) | Off — no report noise |
| Warnings / errors | Coloured | Plain text, still on stderr if we split streams later | Structured fields on the result object (`warnings[]`, `ok`) and/or minimal plain stderr |
| Progress (`MiniHud`, spinners) | `\r` / bar updates | **Suppressed** (or single-line plain milestones) | Off — optional `onProgress` callback only |
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

**Shipped:** `dbstats.js` detects CLI `--file` from `process.argv` (`isDbstatsCliFile`). `await load('dbstats.js')` is quiet and the async IIFE returns the JSON contract. `load()` is not rewriter-awaited. The same argv test gates the loader banner in `autoCompact.js` (`isAutoCompactCliFile`, v1.3.0), `onlineDefrag.js` (`isOnlineDefragCliFile`, v1.7.0), `fuzzer.js` (`isFuzzerCliFile`, v1.5.0), and `oplogchurn.js` (`isOplogchurnCliFile`, v0.6.0). `load()` of those files stays quiet; mdblib still loads where the script requires it. `oplogchurn.js` clears the screen only on a TTY CLI run. `onlineDefrag.js` does not `load()` dbstats; a snapshot is the awaited contract, not a scraped table and not three interactive loads.

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

- Support something like `--eval 'var optionsFile = "…/dbstats.json"'` **or** a first-class flag once a tiny argv helper exists: `mongosh … -f dbstats.js -- --config ./dbstats.json` (convention: script-owned args after `--` if mongosh leaves them on `process.argv`). mongosh 2.12 rejects unknown flags; `var optionsFile` is the working explicit path. `parseScriptArgv` is in mdblib.
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

**Shipped (0.26.0 / 0.28.0 / 1.3.0 / 1.5.0):** shared `mdblib.resolveOptions` — defaults → JSONC file → `--eval` overlay. `parseJsonc` lives in mdblib (BOM, `//` and `/* */` outside strings, trailing commas, then `JSON.parse`). Search: explicit path, else basename via `configSearchDirs` (anchor, cwd, `__dirname`, `$MDBLIB`, `~/.mongodb`). Missing default file is silent. Explicit `var optionsFile` / overlay `optionsFile` missing or parse-fail is an error (`warnings[]` code `optionsFile`). `parseScriptArgv` still reads `--config` after `--` if those args appear on `process.argv`; mongosh 2.12 rejects unknown flags before the script runs, so the working explicit path is `var optionsFile`. Plain objects deep-merge; arrays and scalars replace. dbstats revives `filter.db` / `filter.collection` from strings (`"^app$"` or `"/pat/i"`). `output.format` `table` aliases `tabular`. Canonical default names `dbstats-options.jsonc` / `autoCompact-options.jsonc` are searched, not shipped in `src/` (a `{}` there would overlay every cwd run). autoCompact keeps the `autoCompactOptions` eval name. Fuzzer uses the shared parser/search/merge; `--eval` stays unwired (no second options channel). Env keys and a 1:1 POSIX flag surface are still later. **explainHisto.js** can drop `jsonc-require` for `pipeline.jsonc` now that the stripper is a helper. The scripting guide pins the canonical example.

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

- **Plan** from a dbstats-style snapshot. Prefer consuming `dbstats.js` `output.format: json` once that path is a **stable, versioned** ranked list (see `dbstats.js` → Output formats). `sort` by `freeStorageSize` / `idxFreeStorageSize` hooks exist; `output.verbosity` `compactOnly` is the tabular/html printer as of 0.22.0 / 0.23.0. Printers project `limit.n` (0.25.0); JSON stays the full contract. Do not scrape tabular banners.
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
- Atlas M0/Flex: unknown free-space is a planner stop, not a compact attempt. An incomplete collStats rollup (`freeStorageComplete: false`) is also not `G()` mass — rank namespace rows with known free, never the parent total.
- Oplog: keep `local.oplog.rs` **out** of `G` for autoCompact passes. If oplog compact is enabled, treat it as its own pass (one namespace, 8.0+ `freeSpaceTargetMB`, user floor 1MB) after or between catalog walks — not mixed into the mass CDF, so a huge oplog cannot dominate every cut. `dbstats` already flags oplog compaction as `wait`.

---

## By script

### `autoCompact.js`

Executor auto-trim will call. Keep the file standalone. **Live: v1.3.0.** **Archive: v0.4.36.** Direct-to-member targeting belongs in `discovery.js`; cron/JSON/wait caps belong in `autoTrim.js`. The first-pass namespace bar is output only. Further feature work (auto-trim coupling) is mongosh-line only. `resolveOptions` overlays `autoCompact-options.jsonc` then `autoCompactOptions`. The eval name stays until the alias transition.

**Shipped**

- Async IIFE (no outer `await`); `await delay()` in poll loops so `$listCatalog` can pump.
- Atlas M0/Flex fail-fast: `preflight` classifies `sharedTier` via mdblib `atlasDeployment` from one `hostInfo` and one `serverStatus(opts, null)` (`serverless` platform string kept; product is deprecated/gone). Dedicated still bounces a role-denied `autoCompact`. The `{ none: true }` defaults and `absorbServerStatusKeys` live in mdblib; WT and engine overlays are applied at call time. `null` skips the read-preference `hello()`. A thrown command is `{ ok: 0, error }`; preflight still aborts.
- FCV 8.0+ via `serverStatus.featureCompatibilityVersion` (same round trip as `storageEngine`). Binary 8.x with FCV 7.0 fails. If FCV is not in the document, effective FCV equals the binary version (already ≥ 8).
- Opted-in `storageEngine.name` required and must be `wiredTiger` (missing name fails fast).
- `$listCatalog` pump `stop()` in a `finally` on every enable exit (cancels cursor; no re-pump after stop).
- Ident map finishes before enable. Collectionless `$listCatalog` on 8.0+ hides `local.*`, `config.*`, and `system.*` (except `system.js` and `system.buckets.*`) from non-internal users, so the initial pass reads those namespaces one collection at a time (targeted `$listCatalog`, then `collStats` `wiredTiger.uri` / `indexDetails.*.uri` when that stage is unauthorized). The privilege NOTE is printed after that wait and counts only Unauthorized (code 13). Namespaces the user cannot `listIndexes` or `collStats` stay WT filenames. Background refresh stays collectionless.
- Log watermark: `serverStatus.localTime` after the ident wait, immediately before enable. Client `ISODate()` only if `localTime` is missing.
- First-pass latch (not ramlog, not `$currentOp` — the WT thread never reports there):
  - `visits` = success + skipped* + timeout + interrupted + failed, snapshotted at enable.
  - `sizeStorer` WTCMPCT is a last-file hint.
  - `Δvisits >=` catalog ident count only when `catalogReady`: collectionless `$listCatalog` succeeded and no redacted namespace came back Unauthorized. A privilege gap leaves this latch disarmed (`size()` is short of the files WT still visits). Visits-quiet window unchanged.
  - `Δvisits > 0` and visits quiet and no WTCMPCT heartbeat.
  - no-op: no visits and no heartbeat for `NOOP_GRACE_MS` (works with `runOnce: false`, where the running bit stays true).
  - `runOnce: true` still waits for `background compact running` to clear after first pass.
  - Recovered-bytes stall is not a stop.
  - Ramlog overflow (`ΔtotalLinesWritten ≥ 1024`) is a **heartbeat**, not quiet (lost WTCMPCT must not latch mid-file). A full 1024-line snapshot keeps getLog poll at 50ms but does not count as heartbeat (chatty idle nodes stay full).
  - getLog poll: min while visits increment or first pass is still in a file; backoff only after latch or during no-op.

**First-pass progress bar** (output only; latches stay as shipped):

- **Total** = distinct `db.coll` namespaces in the initial ident map (`namespaceNames()` after `initialDone`). Internal seeds (`sizeStorer`, history store, catalog) are not in that total. `$listCatalog` failure leaves the total unknown and the bar off. A privilege gap still shows the namespaces that were named; the visit-count latch stays disarmed (`catalogReady` / `size()`).
- **Current** = distinct projected namespaces seen in this pass's `WTCMPCT` lines. A collection and its indexes count once, on the first logged file. Unresolved filenames do not count. Ramlog overflow marks the count fuzzy (`~`); dropped lines can only under-report.
- TTY: one `\r` line (`current/total`, block bar, last namespace). The line clears before each log so `WTCMPCT` lines are not glued to it. Piped output has no `\r`; the quiet "waiting for new logs" line stays.
- `runOnce: false` still latches first pass the same way; the bar clears on that latch, not on the ~24h thread.
- Keep sizeStorer / visits-quiet / running-bit stops. The bar must not become a stop condition.
- This file `load()`s mdblib. `resolveOptions`, the ANSI `console.log` patch, `MiniHud`, `hostNameFromHostPort`, `AutoFactor`, `serverStatus`, and `atlasDeployment` come from mdblib. The first-pass bar is `MiniHud` with `throttleMs: 0` (getLog poll is 50ms; the 100ms default would skip frames). Member probes call `serverStatus(opts, null)` so the poll does not `hello()`. The painter writes via `process.stdout.write`, never `console.log`.
- The banner prints only when `process.argv` names this file (`isAutoCompactCliFile`). `load()` stays quiet. Header tags this file as requiring this roadmap.

### `dbstats.js`

The storage snapshot other scripts want (auto-trim planner, discovery-directed jobs, later compact/onlineDefrag targeting). Gather is **catalog-first, then stats** (P1); printers still consume one tree. Dual `$listCatalog` and new formats share that walk.

Shipped recently: views listed once on the nameOnly pass; collection `$collStats` remains the second phase (Unauthorized → `name (unauthorized)`); databases sorted once after the fetch pool; section deep-merge for options (`filter` / `sort.*` / `output`); `output.format` canonical name `tabular` with `table` alias; `formatPct` / `formatRatio` guard zero/non-finite divisors (`n/a` instead of `NaN%` / `Infinity:1`); sort helpers collapsed to `compareBy` + `stableSort`; printers share `metricsCols` / `printRollupRows` / `formatShardCounts`; DB `$stats` map is pure — `rollupDbPath` aggregates totals separately; **`filter.system`** (`true`/`include` default, `false`/`exclude`, `only`) via mdblib `systemCollectionFilter` (replaces dead `systemFilter = /.+/`); authz preflight uses named booleans (`authzAdequate`); legacy Unauthorized detection on `$collStats` / `connectionStatus`; **M0/Flex free-space:** `db.stats()` still wins when it is a real measurement; on shared tier (where db-level reusable bytes are hidden) db/dbPath totals roll up collection WT `$collStats` as a lower bound (`freeStorageSizeSource: 'collStatsRollup'`, `freeStorageComplete` false when authz/filters omit namespaces), with a `*` marker and footnote; **`output.format: json`** is a versioned contract (`JSON.stringify`, `main()` returns the same object) — not `printjson` of the MetaStats tree; **P0:** json stdout gated (no gather blank line / features / mdblib version banners); `nsTableOut` copies rows (no `delete`, real compression); `getDBNames` applies `filter.db` client-side on every platform (Atlas shared/serverless still omit server-side `listDatabases.filter`); `$collStats` passes `readPreference`; `$stats` / non-auth `$collStats` failures stub + `warnings[]` (`(unavailable)`), report continues; **storageSize:** MetaStats no longer coerces `0 → 4096`; stubs/JSON keep 0; tabular collection/index files may show the WT 4 KiB alloc floor; **P1:** names → overlap `$stats` (mapPool `fetchDbStats`) with catalogSnapshot → one untyped `getCollectionInfos` per DB → global `$collStats` in-flight cap (`output.concurrency`) with `onDatabase` free rollup → dbPath; TTY mini-HUD (`done/N`, current DB, run/q, ETA), cleared before the report.

**Live: v1.2.3** (mdblib v1.1.0). **Archive: v0.12.19.** JSON contract is shipped. **P1:** catalog-first then a global `$collStats` in-flight cap (`output.concurrency`, default 8/4) with per-DB `onDatabase` rollup and TTY mini-HUD; json/html quiet. `$collStats` drains via `drainAggCursor` / driver `_cursor.toArray()` so the pool overlaps (shell `toArray()` is rewriter-unwrapped). `load()` without `format: 'json'` gathers quietly and returns the contract (`await load('dbstats.js')`); `--file` still prints the interactive report. `sort.reuse` / `sort.idxReuse` are free/storage ratios; `sort.compaction` ranks compact/rebuild/resync/wait (n/a last). Dedicated `$stats` sizes win even when the collection list is incomplete (`catalogCoverageComplete` false, warning `catalogIncomplete`); collection-sum fallback (`filteredNamespaceRollup`) only when `$stats` itself failed. `catalogCoverageComplete` compares `$stats.collections` to listed `type:collection` (timeseries names are extra list entries, not a coverage hole). M0/Flex still rolls free from collection WT (`collStatsRollup`; `freeStorageComplete` false when listing holes). Incomplete collStats free is a lower bound, not G() mass. `$collStats` `$group` keeps known-shard reuse as a lower bound (`freeStorageComplete` / `totalIndexBytesReusableComplete`; `statsIncomplete` when an owning shard did not return). **P2 first slice:** `parseDbStats` / `parseCollStats` / `parseIndexStats` DTOs plus `CollectionStats` / `DatabaseStats` / `DbPathStats`; dbstats constructs those types (no kitchen-sink `delete`). `MetaStats` façade dropped. `HostNode` owns connecting-host identity (`DbPathStats.host`). **Dual catalog:** `options.catalog` `auto`|`legacy`|`listCatalog`|`listClusterCatalog` — whole-catalog `$listCatalog` (6.0+) / `$listClusterCatalog` (8.0.10+ mongos fast path) then the existing per-DB `$collStats` walk; `getCollectionInfos` fallback on authz/failure (`catalog.builder` / `catalog.fallback` on the JSON contract, warning `catalogFallback`). **fetchStats / materialize:** catalog identity first (`CollectionStats.catalogEntry`); `collection.fetchStats()`, `database.fetchAllStats({ concurrency })`, `dbPath.materialize({ concurrency, onProgress, onDatabase })` with a per-NS `_statsPromise` cache. dbstats `getStats` walks via `materialize` (global `$collStats` in-flight cap; `onDatabase` when each DB completes). JSON/module materialise then serialise. Session snapshot (mdblib) shares atlas platform / `fCV` / `isSharded` from one `hello` / `serverStatus({ wiredTiger: 1 })`; Atlas shared-tier skips doomed `hostInfo` / `getParameter` FCV / `listShards`. That `serverStatus` uses the read preference from the hello already taken. `hello` `isdbgrid` still sets sharded when `serverStatus` is `{ok:0}` and `listShards` did not return shards. A `proc` of `unknown` is not cached. `parseDbStats` / rollup store the DB and dbPath index count as `nindexes` only. `TopologySnapshot.fromSession()` identity shipped in 0.19.0 / 0.23.0; `materializeNodes()` per-node stats (discovery-style child `Mongo()`, serial session swap, no `load()` of discovery.js) in 0.20.0 / 0.24.0. Shared-tier / serverless stay one node. `topology.discover` default true; replica/sharded `summary` is `$stats` rollup per remote, `expanded` is catalog+`$collStats` (sharded expanded fans out seed hosts). Do not gather mongos `local.*` from the router. **0.20.1:** tabular/nsTable list `topology.nodes`; session node is a leading `*`; identity and collection labels pad by terminal display width (emoji / colour tags). **0.21.0:** `output.topology` was the tabular printer; `topology.replica` / `topology.sharded` were gather depth. **0.24.0 / 0.27.0:** `topology.depth` is the one gather+printer knob (`summary` = `$stats` remotes + connecting catalog + member footer; `expanded` = catalog+`$collStats` per member, one table per node; sharded expanded fans out seed hosts). Cluster kind selects the walk. `replica` / `sharded` / `output.topology` alias `depth`. JSON remote `databases` follow `depth`. **0.22.0:** `output.verbosity` is the tabular/nsTable printer (`full` = collections+indexes+views; `summary` = DB rollup; `summaryIdx` = collections+indexes; `compactOnly` = compact/rebuild/wait/resync rows). JSON/module stay the full contract. **0.23.0:** `htmlOut` embeds the JSON contract (click-to-sort; verbosity/topology expanded in-page). **0.23.1:** drop `output.colour` and the HTML colour checkbox; piped tabular colour is mdblib ANSI strip; HTML colour is the inline stylesheet (later a pluggable CSS). **0.25.0:** `limit.*` is a printer projection after verbosity (`limit.n` = hot top-N; metric floors AND, 0 = off). Rank by the first non-zero `sort` key, else reclaimable bytes then compaction. JSON/module stay the full contract; dbPath/DB subtotals stay gather totals. Indexes follow verbosity + floors (not `n`). Views skip when any limit is active. `compactOnly` stacks. **0.25.1:** HTML size columns click-sort by byte magnitude (`data-unit=bytes`); **Free │ reuse** sorts by free bytes. **0.26.0 / mdblib 0.28.0:** `resolveOptions` overlays `dbstats-options.jsonc` then `--eval` `options`; `filter.db` / `filter.collection` revive from strings; json/html peek format from the merged document so a file-only `output.format` stays quiet. Measured `storageSize` 0 stays 0 (including stubs); tabular collection/index rows may display the WT 4 KiB allocation floor. **0.27.0 / mdblib 0.29.0:** `output.profile` gather timings (phases, `$collStats` min/p50/p95/max/sum/overlap, slowest NS; json/html additive `profile`). `hello()` / `serverVer()` are first-read on the session snapshot (`helloDoc`, `serverVerParsed`); `hello(true)` refreshes; `withChildSession` clears both; `db.hello()` stays live. **0.28.0 / mdblib 0.30.0:** `$listClusterCatalog` `shards: true` for expanded mongos owners; skipped when `connectionStatus` lacks `clusterMonitor`. **0.29.0 / mdblib 0.31.0:** global `$collStats` in-flight cap with per-DB `onDatabase`; parallel `fetchDbStats` (`$stats` stays sync); one untyped `getCollectionInfos` per DB; overlap `$stats` with catalogSnapshot (`listDatabaseCatalog` waits for `$stats`); shared-tier skips doomed `hostInfo` / `getParameter` FCV / `listShards`; `serverVerString` / `ensureServerFloor` (no load-time `db.version()`); fold `features` into `connectionStatus`; auto still tries `$listCatalog`; `profile.preGatherMs` / `sinceScriptMs`. **0.30.0 / mdblib 0.32.0:** dbPath **Total** is collection `storageSize` plus `totalIndexSize`; mongod volume from `db.stats()` `fsUsedSize` / `fsTotalSize` (null on Atlas shared-tier and mongos `raw`); `topology.consumption` sums mongod dbPaths when two or more members have stats. **0.30.1:** `--file`/`-f` CLI detect (`++i`); Total/cluster rows omit Data size and Compression; expanded Node sits on the next rule without a blank before Database. **0.30.2:** `topology.depth` default `expanded`. **1.0.0 / mdblib 1.0.0:** overlapping topology fan-out TABLED (`materializeNodes` stays a serial `withChildSession` swap). **1.1.0:** HTML report polish (sans chrome, panels, orange volume meters with percent on the bar, connecting `*` only on the topology table); shared compaction legend on tabular and HTML footers. JSON keys unchanged. **1.2.0 / mdblib 1.1.0:** sharded topology lists CSRS members (`getShardMap` / `sharding.configDB`; additive `configSetName`, node `configsvr`). Cluster consumption includes those mongod dbPaths. When CSRS is listed, the mongos row is cluster data (`dbPath` `cluster data`; no `config` / `local` on the router). Cluster filesystem used/capacity is unique host + `fsTotalSize` (co-located members sharing a disk collapse). **1.2.1:** unique-volume key strips `:port` from hostname; additive `fsVolumeCount` on `topology.consumption`. **1.2.2:** MongoDB 8+ sharded walk grants shard-local `directShardOperations` for user-database `dbStats` / `$collStats`, then revokes. JSON contract version is 1.2.2. **1.2.3:** display labels `Cluster consumption (total)` and mongos dbPath `cluster data (no local/metadata)`; Compaction / Idx compaction stay on rollup tables and drop from namespace/collection/index tables except compactOnly; cluster consumption footnote that those totals are WiredTiger collection and index storage; HTML topology dbPath column widened; reuse cells use `/` and space-padded single-digit percents (` 5.0%`). JSON keys unchanged. JSON contract version is 1.2.3.

**TABLED:** awaitable aggregation cursor shell-API — a helper that makes mongosh `aggregate` a Promise-of-cursor so `await coll.aggregate(…)` waits for the **cursor object** and does not `toArray`/drain. Useful for streaming `for-await` / `yield*` call sites. Does not change `$collStats` (one-document helper; drain stays driver `_cursor.toArray()`), `mapPool`, or the JSON contract.

**TABLED:** mongos omitting mongod-local namespaces (`local.*` / shard-local-only). Preferred shape is an explicit out-of-scope call-out on a pure mongos connection. Filling those namespaces needs multi-node / topology discovery (`discovery.js` / `topology.discover`); do not gather them from the router alone. P2 first slice (parsers / typed objects) shipped as dbstats 0.15.0 / mdblib 0.19.0; `MetaStats` façade dropped in 0.15.1 / 0.19.1; `HostNode` in 0.15.2 / 0.19.2; dual `$listCatalog` in 0.16.0 / 0.20.0; `fetchStats` / `materialize` in 0.17.0 / 0.21.0; session snapshot in 0.17.3 / 0.21.3; UUID `base64` / `parseDbStats` `nindexes` in 0.18.2 / 0.22.2; catalog-walker stubs removed in 0.18.3 / 0.22.3; `TopologySnapshot.fromSession()` identity in 0.19.0 / 0.23.0; per-node `materializeNodes()` in 0.20.0 / 0.24.0. Mongos `local.*` on the router aggregate stays tabled.

**TABLED:** overlapping topology fan-out. `materializeNodes` walks remotes in a `for` loop and `await`s `connectAndGather` one host at a time (`withChildSession` swaps global `db` and the session snapshot). Intra-node `$collStats` / `fetchDbStats` overlap stays. Parallel child gathers need `for(db)` so each member has its own session. Do not re-propose as the next leftover.

**TABLED:** Compass-style privilege-inferred namespaces ("ghosts"). Compass Settings → Infer Additional Namespaces from Privileges greys `connectionStatus` `{ showPrivileges: true }` resources that have `find` and a non-empty collection name, even when `listDatabases` / `listCollections` omit them. On Atlas M0 `atlasAdmin` that set is `config` as a database (listDatabases never returns it), `config.settings`, `local.replset.election`, `local.replset.minvalid`, plus `config.system.js` / `local.system.js` / `local.system.replset`. `local.oplog.rs` is already listed. Do not fold ghosts into `getDBNames`, the catalog walk, or `$collStats` (`atlasHide` still strips admin/config/local on shared-tier; most ghosts AtlasError 8000 on find/`collStats`; M0 `local.oplog.rs` `$collStats` is a shared-tier capped file). Later shape if opened: additive inferred list from the existing `connectionStatus` call with `showPrivileges: true`; skip `$collStats` and `catalogCoverageComplete`. Do not re-propose as the next leftover.

**Apply (shell):** `resolveOptions` is shared (mdblib 0.28.0). dbstats overlays `dbstats-options.jsonc` then `--eval` `options` / `optionsFile`. Revive `filter.db` / `filter.collection` from strings; do not inline a second parser. CLI vs `load()` via `process.argv` is the pattern other scripts copy. Header tags this file as requiring this roadmap.

#### System namespace filter

Orthogonal to `filter.db` / `filter.collection` regexes. “System” means collection/view **names** matching `system.*` or `replset.*` (not admin/config/local DB exclusion — that stays in `getDBNames` / Atlas paths). Default **include** preserves historical dbstats behaviour; operators opt into `system: false` or `system: 'only'` instead of negative-lookahead regexes. Shared predicate lives in mdblib so dual catalog builders (legacy + `$listCatalog`) reuse it. Listing is `listCatalogSnapshot`; the unused `getAllNonSystem*` / `getAllSystemNamespaces` stubs are gone. `indexCacheUtil.js` v1.2.0 keeps its own local walker (`$listCatalog`, then `getCollectionInfos`, including `admin` / `config` / `local`).

#### Output formats

- **`json` (near-term contract).** `output.format: json` prints a **versioned object** (`ok`, `name`, `version`, `catalog`, `topology`, `totals`, `databases[]`, `namespaces[]`, `warnings[]`) — same payload `main()` returns for load() / module callers. `catalog` is `{ builder, fallback }` (`legacy` | `listCatalog` | `listClusterCatalog`). `topology` is `kind`, `setName`, `shardIds`, additive `configSetName`, `nodes[]` (identity plus per-node `stats` totals, additive `configsvr`; `databases` on remotes when replica/sharded is `expanded`), `errors[]`. Consumers: `autoTrim.js` (rank reclaimable), `discovery.js` (per-node job payloads), later `autoCompact` / `compact` / `onlineDefrag` targeting. Ranked flat list *and* hierarchical rollup (db → collection → index); namespace rows are `{ ns, kind, dataSize, storageSize, freeStorageSize, objects, compaction, … }`. Keep `n/a` free-space as `null`, not `0` (Atlas M0/Flex). Additive `totals.totalSize` is collection `storageSize` plus `totalIndexSize` (the dbPath **Total** line). Additive `fsUsedSize` / `fsTotalSize` / `fsFreeSize` are the mongod volume from `db.stats()` (same on every database; omitted on Atlas shared-tier and on a mongos `raw` aggregate). `topology.consumption` sums mongod dbPaths when two or more members have stats (skip the mongos router; include CSRS). When db/dbPath totals come from collection WT instead of `db.stats()`, include `freeStorageSizeSource` (`'dbStats'|'collStatsRollup'|'unknown'`) and `freeStorageComplete` (and the index equivalents); incomplete collStats free is a lower bound — auto-trim must not use it as `G()` mass. Dedicated `$stats` sizes stay on the DB/dbPath rows even when `catalogCoverageComplete` is false. Peel the contract to stable keys; do not leak printer-only fields.
- **`html`.** **Shipped 0.23.0.** `htmlOut` embeds the JSON contract in a self-contained page (click-to-sort tables). Size columns sort by byte magnitude (IEC units on the cell, `data-unit=bytes`); **Free / reuse** sorts by free bytes. Verbosity / `topology.depth` expanded / `limit.*` top-N filter that payload in the browser. Colour is the inline stylesheet (not configurable; later a pluggable CSS). Redirect stdout to a `.html` file. Aspirational live refresh still waits.
- **Aspirational — live HTML.** HTML page calls script-side / local API hooks for refresh (re-snapshot without a full page reload). Depends on a durable run mode or companion listener; do not block the static JSON→HTML path on it.
- **0.25.0 printer projection:** `limit.*` (`n` = hot top-N after verbosity; metric floors AND, 0 = off). Rank by the first non-zero `sort` key, else reclaimable bytes then compaction. JSON/module stay the full contract. `sort.compaction` / `sort.reuse` / `sort.idxFreeStorageSize` and format aliases (`tabular` / `table`) are shipped. `output.verbosity` (`full` / `summary` / `summaryIdx` / `compactOnly`) is the tabular printer as of 0.22.0 and the HTML initial view as of 0.23.0. Piped tabular colour is mdblib ANSI strip; there is no `output.colour`.

`compactionHelper` (20% collection / 50% index / 50% dbPath, plus WT min reclaim) stays the “is this worth it” predicate; auto-trim’s `freeSpaceTargetMB` is the **how much this pass** knob.

#### Dual catalog builder

**Shipped** in dbstats **0.16.0** / mdblib **0.20.0**. Namespace discovery bifurcates, then feeds the existing per-DB `$collStats` walker (no duplicate stats / print paths):

| Builder | When | Notes |
|--------|------|--------|
| **Legacy** | Fallback, `catalog: 'legacy'`, or servers below 6.0 | `listDatabases` + `getCollectionInfos` (`nameOnly` + `authorizedCollections`) so partial-privilege users still see names; `$collStats` may tag `(unauthorized)`. |
| **`$listCatalog` / `$listClusterCatalog`** | Newer servers when available and authorised | Whole-catalog materialisation, sliced per DB. `$listCatalog` from **6.0+** (collectionless admin; best-effort). `$listClusterCatalog` from **8.0.10+**, docs mark it **unsupported / unstable** — optional fast path on mongos, never the only path. |

Selection: `options.catalog` `auto` (default) | `legacy` | `listCatalog` | `listClusterCatalog`. Auto: mongos && 8.0.10+ tries `$listClusterCatalog`, else 6.0+ tries `$listCatalog`, else legacy. On catalog-stage failure or authz denial, fall back to legacy without aborting the report. Expanded mongos gather passes `shards: true` and keeps the owner ids for the `$collStats` completeness check; other gathers omit it. The stage is skipped when the connecting `connectionStatus` already lacks `clusterMonitor`. 8.0+ collectionless `$listCatalog` redaction of `system.*` is filled from `listCollections`. JSON `catalog.builder` / `catalog.fallback`; warning `catalogFallback` when the stage was unavailable.

Catalog identity still lands before stats. `fetchStats` / `materialize` shipped in dbstats **0.17.0** / mdblib **0.21.0** (see [`MetaStats` redesign](#metastats--typed-storage--topology-model)).

#### Concurrency (stats fetch)

Stats need **both** per-DB `$stats` and per-collection `$collStats` (dedicated: `db.stats()` wins when free-space is real; M0/Flex: collStats rollup is the lower bound). A DB’s free-space rollup still waits until that DB’s `$stats` and all of its collection stats are in; `onDatabase` fires when that DB’s remaining collections hit 0. The `$collStats` **in-flight cap is global** so other DBs can fill while one DB is still in flight.

P1 walk:

1. **All DB names** (`getDBNames`).
2. **Overlap `$stats` with catalogSnapshot.** `fetchDbStats` via `mapPool` (user-defined async + `awaitPlain(runCommand)`; `$stats` stays the sync helper). Whole-catalog `$listCatalog` / `$listClusterCatalog` once (`catalog:legacy` skips the stage; auto still tries on shared-tier). `listDatabaseCatalog` waits until `$stats` is applied (`catalogSliceNeedsLegacy` uses `ncollections` / `nviews`).
3. **Per-DB catalog listing.** One untyped `getCollectionInfos` per DB, types split client-side; `mapPool` across DBs. Seeds HUD `N`.
4. **Global `$collStats` in-flight cap** (`output.concurrency`) across DBs; `onDatabase` sorts and `applyFreeStorageRollup` when each DB’s collections complete. Views stay nameOnly (no pool).
5. **dbPath rollup** once every DB has collection stats.

Pool size is an option (default conservative on mongos). The cap is cluster-wide; mutation and free-space rollup stay per-DB via `onDatabase`.

**Mini-HUD** (shipped, TTY tabular/nsTable; json / html / piped quiet): phase 1–2 light (`dbStats i/D`, `catalog i/D`); after catalog, `done/N` plus current DB and in-flight/queued in the global pool; cheap ETA. `MiniHud` + `mapPool` in mdblib. Clear the HUD before the report (including on gather failure).

#### Sharding and topology

- **mongos gaps (TABLED):** mongos does not surface **local** namespaces the way a mongod does. Preferred handling is an out-of-scope call-out on a pure mongos connection. Filling `local.*` / shard-local-only views depends on **per-node topology discovery** (`discovery.js` / `topology.discover`); do not invent per-shard stats from the router session.
- **Per-node stats (0.20.0 / 0.24.0; depth 0.24.0 / 0.27.0):** `topology.discover` (default true) connects to advertised replica members and/or shard seeds with discovery-style child `mongodb://` URIs inside mdblib (do not `load()` discovery.js). dbstats stays the measurement payload (`gatherDbPath` on each child session). `topology.depth` `summary` is `$stats` rollup per remote plus connecting catalog and member footer; `expanded` is catalog+`$collStats` per member and one catalog table per node (sharded expanded fans out seed hosts, including the config replica set). Cluster kind selects the walk. `replica` / `sharded` / `output.topology` alias `depth`. JSON remote `databases` follow `depth`. Shared-tier / serverless stay one connecting node (policy: compact / autoCompact cannot run on those tiers; M0/Flex still advertise a replica set). Do not re-propose shared-tier fan-out. Serial session swap until `for(db)`. This is the dependency for mongos local-NS coverage on mongod snapshots; do not gather `local.*` from the router. CSRS members are first-class mongod nodes (`configSetName`, `configsvr`); `topology.consumption` includes them. When those members are listed, mongos totals omit `config` and `local` and the row is labelled `cluster data (no local/metadata)`. Cluster footer label is `Cluster consumption (total)`. Compaction / Idx compaction stay on rollup tables; namespace/collection/index tables omit them except compactOnly. Do not query `config.mongos`.
- Standalone and single-mongod paths unchanged.

#### Hot summary

**Shipped 0.25.0** as a printer projection (`limit.n`), not a new verbosity. Tabular / nsTable / HTML initial view: verbosity filter, then `limit.*` metric floors (AND, 0 = off), then if `n` > 0 rank and slice. Rank is the first non-zero `sort` key for that section, else reclaimable bytes descending then compaction (`resync` > `rebuild` > `compact` > `wait`). Summary `n` is top-N databases; otherwise `n` is a global collection/namespace cap (per node when `topology.depth` is expanded). Indexes follow verbosity + floors, not `n`. Views skip when any limit is active. `compactOnly` stacks. JSON/module stay the full gather contract; dbPath/DB subtotals stay gather totals. Auto-trim consumes that JSON list.

### `compact.js` / `onlineDefrag.js`

Per-namespace `compact` and update-based defrag. Not auto-trim. Auto-trim’s **opt-in oplog** path is 8.0+ `compact` + `freeSpaceTargetMB` on `local.oplog.rs`, not this script’s entropy loop.

**`compact.js`:** not in live `src/` (archive **v0.2.15** only). Do not restore it without a mongosh-line rewrite. Do not restore `const … reportLog`. Entropy-loop compact is not auto-trim.

**`onlineDefrag.js` live: v1.7.0** (mdblib). **Archive: v0.1.4.** `--eval var` for `dbName` / `collName` / `defragOptions`. Do not top-level-await. Header tags this file as requiring this roadmap.

Remaining mongosh-line work (do not block the archive):

- Consume dbstats in **module/JSON** mode when a ranked snapshot is needed (`await load('dbstats.js')`). v1.7.0 does not load dbstats; do not bring back three interactive loads, and do not scrape the tabular report.
- Later: point compact/rebuild at a single dbstats “compact” / “rebuild” row when autoCompact’s file walk is the wrong tool (one collection, dryRun estimate, `_id` rebuild).
- `compact` is also [unsupported on Atlas M0/Flex](https://www.mongodb.com/docs/atlas/unsupported-commands/); same bounce as autoCompact. Pre-v8 `compact` has no `freeSpaceTargetMB` — no oplog trim path.
- **onlineDefrag (v1.7.0):** loads mdblib. No `storageStats()` and no `withTransaction`. Packed-temp WT is one shell `aggregate().toArray()[0]` (fine for a single document). `$collStats` is awaited. The loader banner prints only when `process.argv` names this file (`isOnlineDefragCliFile`). Do not read `mongo._uri`.
- **onlineDefrag page fill:** autotune `pageFillRatio` / `pageFillTarget` from settled `$collStats` (compression, `avgObjSize`, leaf page size, reusable) instead of a fixed 0.9. Next discussion; wave count and dirty-byte budget already exist.
- **onlineDefrag control loop:** AIMD on `dirtyBudgetRatio` from **settled** (post-checkpoint) density and reusable. Stop when reusable is ~10–20% or density plateaus. Do not treat packing-induced reusable **up** in a **fixed** `storageSize` as failure (that is compact-ready); treat `storageSize` **up** as failure (file extend).
- **onlineDefrag `doubleParked`:** rewrite the same `_id` batch twice with a checkpoint settle between, so the second rewrite can consume the free list instead of appending again. File trim is **organic**: WT shortens the file when the **boundary page** is relocated (compact only *targets* the geometric tail, ~last 10%, and shuffles **blocks**; it does not raise intra-page fill). On M0/Flex `compact` is unavailable — EOF rewrite is the trim path.
- **onlineDefrag then compact:** this script’s job is **page occupancy** (hard). `compact` / `autoCompact` then become more effective because they only move allocated pages. Do not expect compact to fix 1 KiB-in-32 KiB leaves.

### `discovery.js`

**Legacy archive line: v0.2.1** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. Do not strip named capture groups for legacy mongo. Post-freeze feature work proceeds on the mongosh line only. Header tags this file as requiring this roadmap.

**Apply (shell):** parent URIs stay `db.getMongo().getURI()` (already; do not switch to `mongo._uri`). Do not send awaitable `hello` (`maxAwaitTimeMS` / `topologyVersion`). A per-host job is `await load()` of a script whose argv test says it is not the CLI file (`dbstats.js` is the pattern), not a scraped banner.

- Plugable command profiles (auto-trim / autoCompact as a per-member job; **dbstats in module mode** as a measurement profile — JSON contract per host, no interactive table on the wire).
- Prefer invoking support scripts in **non-interactive / module mode** so fan-out results are structured (`ok`, host, payload, warnings), not ANSI logs to stitch together.
- **Direct-to-member for compact / per-node dbstats:** replica-set URI without `directConnection=true` lands on the primary; only that process is compacted (not replicated), and mongos-level dbstats misses mongod-local namespaces. Warn when `hello().me` ≠ connected host, or when `isWritablePrimary` and the seed list looks like a set. Pin each member (prefer secondaries first) and run auto-trim / autoCompact / dbstats per host.
- Standalone, load-balanced, arbiters.
- Execution modes: serial; shards in parallel / serial per shard; limited pool; jitter; timeout cancel. (dbstats’ internal stats **task pool** is separate — discovery owns cross-host fan-out.)
- Target primary vs secondaries only (auto-trim wants the latter by default).
- Load / lag metrics beside each directed command.

### `congestionMonitor.js`

**Live: v0.4.0.** **Legacy archive line: v0.2.13** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. Known `.finally(process.stdout.write(…))` (write runs immediately) is **wontfix on this line**. Live wraps `.finally(() => process.stdout.write(…))`. Post-freeze feature work proceeds on the mongosh line only.

Remaining mongosh-line work (do not block the archive):

- Sharding (per-shard WT vitals; same need as niceDeleteMany). Live mongosh line folds collection-owning (or all) shard primaries; child `mongodb://` construction matches niceDeleteMany (local discovery-style helpers, not `load()`). Archive freeze stays v0.2.13.
- MongoDB 8 execution-control: live snapshot + EQ for `executionControlDeprioritizationGate`, `usesThroughputProbing`, normal and low-priority `queues.execution.{read,write}.queueLength`, and interval wait from `totalTimeQueuedMicros` (per-shard `_queuedPrev`, MAX wait-ms / RANK wait status on fold). Monitor-only — niceDeleteMany AIMD does not trip on these. `lowPriorityAdmissionBypassThreshold` is dropped (fairness knob, not a pressure signal).
- `bytes_dirty_intl` / `bytes_dirty_leaf` when the server exposes them. Live mongosh line already maps `tracked dirty internal/leaf page bytes in the cache`.
- Pause / closed signal for auto-trim: backup cursor, repl-lag settle, WT dirty/updates (already has `backupCursorOpen`). Auto-trim is a consumer of these vitals, not a second monitor implementation if inlining is still required.

### `niceDeleteMany.js`

**Live: v1.0.0.** **Archive: v0.4.11.** `--eval` must use `var`. Do not declare `dbName`/`collName`/`filter` in-file. Do not top-level-await. Do not restore `Mongo.setReadPref`. Header tags this file as requiring this roadmap. Shared AIMD (`maxInFlight` MD/AI) for WT and paceMaker; WT FSM vs pace delay stay separate gates. `hasUserHint` / `hasUserCollation` collapsed to `hasNonEmptyDoc`. Policy A is `POLICY_A_STEPS` (C1 cannotSpill scan, C2–C3 user hint, C4/C7 unhinted planner then Policy B, C6 `_id` scan). Binary major ≥ 9 fails closed (`assertServerBelow9`); unknown `db.version()` also refuses.

**TABLED:** MongoDB 9.0 null-equality on dotted paths that traverse arrays (`{ "a.b": null }`, `$eq` / `$ne` / `$in` / `$nin` / `$gte` / `$lte`, `$lookup`). Until testing and filter/curation refactor land, this script refuses MongoDB 9+. Mixed-version shards behind an 8.x mongos wait on that same work. Do not re-propose as the next leftover.

**TABLED:** MongoDB 9.0 optimisation of this script, including admission-controller use of [backpressure-aware driver](https://www.mongodb.com/docs/atlas/overload-errors/?interface=driver&language=python) features for Atlas Load Shedding / Intelligent Workload Management. Detect `SystemOverloadedError` (safe retry only with `RetryableError` / `NoWritesPerformed`); exponential backoff with jitter; cap retries (docs: at most two for latency-sensitive work); persistent overload is shed/pace, not a blind retry storm. Needs a mongosh that ships Node.js driver ≥ 7.6. Application still owns how long to retry and when to abandon. AIMD stays off execution-control metrics. Do not re-propose as the next leftover.

**Apply (shell):** `deleteManyTask` uses `(await namespace.deleteMany(...)).deletedCount`. See the scripting guide (result fields). Do not re-add the Promise-field unwrap as new work.

Range-deleter throttle is in the file at v0.13.1 (`shardingStatistics.rangeDeleterTasks` on collection-owning shard primaries → THROTTLE, not CLOSED). Do not re-add it as new work. Parent shard URIs already use `db.getMongo().getURI()`. Child `mongodb://` URIs are built inside each IIFE with discovery-style `decomposeParentUri` / `formatLegacyMongoUri` / `parseReplSetHosts` (do not `load()` `discovery.js`): re-encoded userinfo, `loadBalanced` dropped, replica-set children `readPreference=primary`, `maxPoolSize=2`, 5s timeouts. Construction matches `congestionMonitor.js`. `SERVER_STATUS_OPTIONS_DEFAULTS` starts as `{ none: true }` and grows `section: false` from fat replies (`absorbServerStatusKeys`); `SERVER_STATUS_OPT_IN` stays explicit. Same generator is local in congestionMonitor and niceDeleteMany (those files do not load mdblib). autoCompact uses mdblib's.

### `connStats.js`

**Legacy archive line: v0.1.14** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Inprog fallback stays. Post-freeze feature work proceeds on the mongosh line only.

Remaining mongosh-line work (do not block the archive):

- `whatsmyuri` for “this client” vs the pool.
- DRIVERS-3027 when it lands.
- Later: `targetAllNodes` on mongos (commented TBA).

### `indexCacheUtil.js`

**Live: v1.2.0.** **Legacy archive line: v0.1.5** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await the IIFE. Do not `load()` `mdblib.js`; the walker stays local. Post-freeze feature work proceeds on the mongosh line only.

Shipped in 1.0.0:

- Collectionless `$listCatalog` on this mongod (6.0+), drained with driver `cursor._cursor.toArray()`. Pre-6.0, authz failure, and Atlas M0/Flex `AtlasError` 8000 fall back to `listDatabases` + `getCollectionInfos` (full list, not `cursor.firstBatch`). A NOTE names the fallback and the error. `$listClusterCatalog` is not used. A mongos session exits: it has no WiredTiger cache.
- Drops `admin` / `config` / `local`. Drops `system.*` / `replset.*` except `system.buckets.*`. Skips a timeseries view when `system.buckets.<name>` is listed. Keeps the view when the buckets name is absent.
- Bounded local `mapPool` (width 8). Per-namespace failures are collected and do not abort the snapshot. `$collStats` uses `batchSize: 1`, read concern `local`, and the driver drain. `await Promise.resolve()` around sync `adminCommand` on the legacy list. See the scripting guide.
- Cache sample immediately before and after the pool. Headline ratios use the after sample. `Total bytes in cache` / `Total cache util` stay server page images / configured (the pre-1.0.0 lines). `Index bytes in cache` is the sum of per-index `bytes currently in the cache`. `Cache util by indexes` divides that sum by server `bytes currently in the cache`. `Index share of page images` is the old mix (that sum / server page images). `Index working set util` divides that sum by index file size minus bytes available for reuse. A zero denominator prints `n/a`. Drift is the after sample minus the before sample.
- TTY `\r` progress, cleared before the report. Not `console.log`. Not `MiniHud` (that painter stays in `mdblib.js`).

Shipped in 1.1.0:

- Per-index rows from the same `$collStats` (`name`, `bytes currently in the cache` via `$getField`, file size, reusable bytes). A missing counter stays unknown and the affected total prints `n/a`, not 0. Sums are in the shell. Up to 5 namespaces: list each namespace and each index, largest resident first. A per-index working set may exceed 100%.
- Collection btree `wiredTiger.cache` bytes currently in the cache from that same document. `Other bytes in cache` is the server bytes-currently total minus index bytes minus collection bytes.
- `Bytes not belonging to page images` sits beside occupancy. `Cache util by indexes` stays index bytes / server bytes currently. `Index share of page images` stays the mixed ratio.
- Cache sample is `{ serverStatus: 1, none: true, wiredTiger: 1 }`, after the catalog and after the pool. Full `serverStatus` is the fallback. The discarded pre-catalog probe is gone.

Shipped in 1.2.0:

- `admin`, `config`, and `local` are in the snapshot, as are `system.*` and `replset.*` in every database. 8.0 collectionless `$listCatalog` hides `local.*`, `config.*`, and most `system.*`, so `getCollectionInfos` (`authorizedCollections: true`) is unioned with the catalog. A timeseries view is still skipped when its `system.buckets.*` row is listed.
- `Unauthorized` (`code` 13) on `$collStats` skips that namespace, prints it, and does not blank the totals. The sums are the namespaces authz allowed. Each measured namespace is listed with its index and collection cache bytes. Per-index lines stay limited to 5 measured namespaces.

Remaining mongosh-line work (do not block the archive):

- Sharding and a cluster-wide report. `runCommand` via discovery for directed execution.

### `mdblib.js`

**Live: v1.1.0.** **Archive: v0.15.10** — pair archived scripts with 0.15.10, not live mdblib. Do not “fix” `fCV()` → `serverVer()` on M0/Flex. MiniHud + `mapPool` replace the stub `ProgressTracker`. `$collStats` is **async** (await the call; do not await the aggregate cursor — thenable drains). Drain via `drainAggCursor` / driver `_cursor.toArray()` (native Promise) so the dbstats `mapPool` overlaps; shell `toArray()` is rewriter-unwrapped to an array and serialises. Callers must `await` it (user-defined async is not rewriter-awaited): `CollectionStats.fetchStats`, oplogchurn, onlineDefrag. `$listCatalog` / `$listClusterCatalog` / `listCatalogSnapshot` list namespaces (`{ db, name, type }`; expanded mongos also keeps `shards` for owners). dbstats falls back to `getCollectionInfos`. The cluster stage is skipped when `connectionStatus` already lacks `clusterMonitor`. `bsonMax`, `maxWriteBatchSize`, `pid`, and `nonce` are first-read globals; `load()` does not call `hello`, `serverStatus`, or `features` for them. `$collStats` `$group` sums known-shard reuse as a lower bound (`freeStorageKnownCount` / `indexReuseKnownCount`, `freeStorageComplete` / `totalIndexBytesReusableComplete`); `statsIncomplete` when an owning shard (config.chunks / db primary) did not return — a collection on a subset of cluster shards is complete. **P2 first slice:** `parseDbStats` / `parseCollStats` / `parseIndexStats` plus `StorageMetrics` / `CollectionStats` / `DatabaseStats` / `DbPathStats`; `MetaStats` façade dropped; `HostNode` owns connecting-host identity. **fetchStats / materialize:** `collection.fetchStats()`, `database.fetchAllStats({ concurrency })`, `dbPath.materialize({ concurrency, onProgress, onDatabase })` (global `$collStats` in-flight cap; `onDatabase` when each DB completes); `fetchDbStats` is the async `$stats` path (`$stats` stays sync); cache `_statsPromise` per collection. Callers materialise then serialise. Owning-shard ids are cached on the Map for one `materialize` / `fetchAllStats` gather. A lone `$collStats` does not keep them. `__collStatsOnMongos` stays a session cache. `serverStatus(options, statusReadPref)` has no default read preference: an explicit string wins; omitted, `hello().secondary` selects `secondaryPreferred` on a secondary and `primaryPreferred` otherwise; `null` skips that hello and runs on the connected member. A thrown command returns `{ ok: 0, error }` and does not throw. That parameter does not hide the stats global `readPref`. `AutoFactor.format` returns `"unknown"` for a non-finite value, clamps negatives to 0, and keeps a value below 1 byte on the byte scale. **Session snapshot:** first read of atlas platform / `fCV` / `isSharded` shares one `hello` / `serverStatus({ wiredTiger: 1 })`; Atlas shared-tier (`atlasVersion` or `*.mongodb.net` host, no `wiredTiger`, not `isdbgrid`) skips doomed `hostInfo` / `getParameter` FCV / `listShards`; that `serverStatus` uses the read preference from the hello already taken; `hello` `isdbgrid` still sets sharded when `serverStatus` is `{ok:0}` and `listShards` did not return shards; a `proc` of `unknown` is not cached; `load()` does not fill the full snapshot and does not call `serverVer` / `db.version()`; `hello()` / `serverVer()` are first-read (`helloDoc`, `serverVerParsed`, `serverVerString`); `hello(true)` refreshes; `ensureServerFloor` runs on the first snapshot; `withChildSession` clears the sidecars; `db.hello()` stays live. Auto catalog still tries `$listCatalog` on shared-tier. `serverStatus` `none:true` is portable on 8.0 and Atlas M0 (`process`/`pid` remain). `SERVER_STATUS_OPTIONS_DEFAULTS` starts as `{ none: true }` and grows `section: false` from fat replies (`absorbServerStatusKeys`). `$stats` / `$collStats` still own version and Atlas quirks (`hideFree` stays). `compactionHelper(type, storageSize, freeStorageSize)` has no numeric defaults: omitted storage is not the 4 KiB display floor, and omitted or null free returns false. Thresholds stay 20% collection / 50% index / 50% dbPath. `parseDbStats` stores the index count as `nindexes` only (`db.stats()` names that field `indexes`). `UUID`/`Binary.base64()` is a method (`this.toString('base64')`). Unused `getAllNonSystem*` / `getAllSystemNamespaces` stubs are gone; listing is `listCatalogSnapshot` plus `systemCollectionFilter`. `TopologySnapshot.fromSession()` identity shipped in 0.23.0; `materializeNodes()` per-node stats in 0.24.0 (child `mongodb://` helpers in mdblib, do not `load()` discovery.js). Sharded identity includes the config replica set (`getShardMap` / `sharding.configDB`; `cluster.configSetName`, node `configsvr`). `$benford(expMin, expMax)` draws a positive magnitude from a precomputed significand table (inclusive powers of ten, default 0..6, result in `[10^expMin, 10^(expMax+1))`). Schema B `unit` and `price` call it. `$genRandWord` / `$genRandPhrase` use the built-in lexicon. `$genPoint()`, `$genLine()`, and `$genPolygon()` / `$genPolygon(true)` draw schema C GeoJSON (0.26.0). **0.28.0:** `resolveOptions` / `parseJsonc` / `loadJsoncFile` / `deepMergeOptions` (defaults → JSONC → `--eval`; regex revive; `--config` after `--`). **0.29.0:** `hello()` / `serverVer()` first-read on the session snapshot (`helloDoc`, `serverVerParsed`); `hello(true)` refreshes. **0.30.0:** `$listClusterCatalog` `shards: true` for expanded mongos owners. **0.31.0:** `fetchDbStats` (async `$stats` path; `$stats` stays sync); `materialize` global `$collStats` in-flight cap with per-DB `onDatabase`; snapshot `serverStatus({ wiredTiger: 1 })`; shared-tier skip of doomed `hostInfo` / `getParameter` / `listShards`; `serverVerString` / `ensureServerFloor`; auto still tries `$listCatalog`. **0.32.0:** `parseDbStats` / `DatabaseStats` / `DbPathStats` keep `fsUsedSize` / `fsTotalSize` (mongod volume; null on mongos `raw`). **1.0.0:** overlapping topology fan-out TABLED. **1.1.0:** config replica set in `TopologySnapshot.fromSession()` (`getShardMap` / `sharding.configDB`; `cluster.configSetName`, node `configsvr`).

- **TABLED:** awaitable aggregation cursor helper — Promise-of-cursor so `await coll.aggregate(…)` yields the cursor object (does not drain). Streaming `for-await` / `yield*` only. `$collStats` stays a one-document helper with driver `_cursor.toArray()` drain. See [Thenable cursors](mongosh-scripting-guide.md#thenable-cursors-do-not-await-a-live-cursor).
- **TABLED:** overlapping topology fan-out. `materializeNodes` stays serial (`withChildSession` global `db` swap). Intra-node `$collStats` overlap stays. Parallel children need `for(db)`. See dbstats.js TABLED fan-out.
- **TABLED:** Compass-style privilege-inferred namespaces. Do not merge `connectionStatus` `showPrivileges` resources into `getDBNames` / `listCatalogSnapshot`. See dbstats.js TABLED ghosts.
- **Do not uncomment `module.exports`.** `require` / `exports` run where the shell `db` global is missing. Callers `load()` this file. See the scripting guide. Header tags this file as requiring this roadmap.
- Namespaced helpers / `for(db)` — **after** the library strategy change, not before.
- **Legacy `mongo` shims** — stripped (`mdblib.js` v0.15.11+). Do not restore `slaveOk` / dual `Timestamp` / `_getEnv` loaders. Integer `serverVer` / `fCV` / `shellVer` are in place; do not couple further cleanup to `for(db)`.
- **Shared emit helpers** (see [Script consumption](#script-consumption-unify-standalone-vs-modular)): finish the story beyond today’s `console.log` TTY overload — one path for markup→ANSI, non-TTY strip, progress suppress, and module-quiet. Bring `print` / raw-escape call sites onto it over time.
- **System name policy (shipped):** `isSystemCollectionName` / `normalizeSystemFilter` / `acceptSystemCollectionName` / `systemCollectionFilter` — used by dbstats `filter.system`. Listing is `listCatalogSnapshot`. The unused `getAllNonSystem*` / `getAllSystemNamespaces` stubs are gone. `indexCacheUtil.js` v1.2.0 keeps its own local walker (`$listCatalog`, then `getCollectionInfos`, including `admin` / `config` / `local`).
- **`MetaStats` redesign** — see below; underpins dbstats catalog-first work and discovery’s per-node payload shape.

#### `MetaStats` → typed storage / topology model

Narrow but deep. Parsers and typed objects are in place. The old kitchen-sink `MetaStats` constructor (one class for db-shaped and collection-shaped inputs, list-vs-count merges, caller-side `delete`) is gone. Host identity lives on `HostNode` (`DbPathStats.host`). Version/Atlas quirks stay in `$stats` / `$collStats`.

##### 1. Consistent parsers → stable contracts

Split “talk to the server / normalise history” from “be a domain object”:

| Layer | Responsibility |
|-------|----------------|
| **`$stats` / `$collStats` (or successors)** | Fetch raw commands; remain the only place that knows mongod version quirks, `freeStorage` option gating, sharded `raw` rollups, Atlas M0/Flex “hidden free-space → `null`”, Unauthorized stubs, BSON number coercion. |
| **Pure normalisers** | `parseDbStats(raw) → DbStatsDTO`, `parseCollStats(raw) → CollStatsDTO`, `parseIndexStats(…) → IndexStatsDTO`. Idempotent, no `db` global, unit-testable with fixtures from old/new server shapes. |
| **Entity classes** | Construct **only** from DTOs (or explicit fields). No “if collections is array vs number” in the constructor. |

Goal: one documented field contract per level (`freeStorageSize: number | null`, `indexes: Index[]` vs `nindexes: number`, never overloaded). Version drift dies in the parser, not in printers.

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

Migration: `MetaStats` façade is gone. dbstats constructs `CollectionStats` / `DatabaseStats` / `DbPathStats` directly. oplogchurn / onlineDefrag stay on raw `$collStats`.

##### 3. Topology superset (prudent if composed)

A **cluster / topology object** that also captures host- and cluster-level detail is a good idea **as a container**, not as “MetaStats grew more fields”:

```text
TopologySnapshot          // discovery-aligned
  ├─ cluster: { kind, setName?, shards? }
  ├─ nodes: HostNode[]    // hostname, proc, me, dbPath, role, tags…
  │    └─ catalog + stats // DatabaseStats / CollectionStats for that node
  └─ aggregate?           // optional mongos-level rollup (knows local NS gaps)
```

Why this helps discovery: fan-out returns `HostNode` payloads; dbstats module mode returns `DbPathStats` with `topology` attached. Host identity lives on `HostNode` (`HostNode.discover()`, composed as `DbPathStats.host`). `TopologySnapshot.fromSession()` lists cluster identity; `materializeNodes()` fills remote `node.stats`. Child URIs match discovery.js / niceDeleteMany (do not `load()` discovery.js).

Avoid a single mutable god-object that mixes router aggregate and per-shard mongod state without labelling which is which (mongos local-NS gap stays explicit).

##### 4. Experimental — catalog first, stats lazy

Aligns with dbstats “build catalog, then task-pool stats,” but pushes laziness into the model:

- **Build** topology + namespace catalog first (cheap nameOnly / `$listCatalog`): entities exist with identity and `stats: unset`.
- **Fill** storage attributes on demand.

**Recommendation:** use **explicit async loaders**, not magic getters, as the primary API:

```text
await collection.fetchStats()           // one NS
await database.fetchAllStats({ concurrency })
await node.materialize({ concurrency }) // global in-flight cap; onDatabase per DB — same pool story as dbstats
```

Optional **lazy getters** as REPL sugar only (`get stats()` that throws if not loaded, or returns a Promise — but Promise-returning getters are easy to misuse with the async rewriter and with `JSON.stringify`). For module/JSON/discovery, always **`materialize()` then serialise** so the contract is a plain snapshot, not a live graph.

Scaling notes:

- Laziness shines for hot summary / single-NS drill-down / unauthorized skip.
- Full dbstats report and auto-trim planners should materialise in a **bounded pool** (not unbounded getter storms).
- Cache fetches on the entity (`_statsPromise`) to avoid duplicate `$collStats` under parallel walkers.
- Catalog identity must remain available when stats fail (existing `(unauthorized)` behaviour).

##### Suggested order

1. Extract DTO normalisers from `$stats` / `$collStats` (behaviour-preserving). **Done** (`parseDbStats` / `parseCollStats` / `parseIndexStats`).
2. Introduce `StorageMetrics` + `CollectionStats` / `DatabaseStats`; point dbstats at them; delete the `delete` soup. **Done** (`DbPathStats` / `IndexStats` / `ViewRef` too; `MetaStats` façade dropped in 0.15.1 / 0.19.1).
3. `HostNode` **Done** (connecting host; `DbPathStats.host`). `TopologySnapshot.fromSession()` **Done** (0.19.0 / 0.23.0). `TopologySnapshot.materializeNodes()` **Done** (0.20.0 / 0.24.0; `{ depth }` in 0.24.0 / 0.27.0): discovery-style child `Mongo()` per advertised remote; serial global-`db` swap; `topology.discover` / `topology.depth` summary|expanded. Shared-tier / serverless stay one node. Mongos `local.*` from the router stays tabled.
4. Dual catalog listing **Done** (`listCatalogSnapshot` / `$listCatalog` / `$listClusterCatalog` + `getCollectionInfos` fallback). Catalog-first + `fetchStats` / `materialize` **Done** (bounded per-DB pool, per-NS `_statsPromise` cache). Lazy getters remain REPL-only sugar (not shipped).

### `explainHisto.js`

Aggregation `explain('executionStats')` stage-timer histogram. **Legacy archive line: v0.1.4** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Not dual-shell (`require` / `jsonc-require` / `./pipeline.jsonc`). Do not load mdblib, restore a `[mongo|mongosh]` usage line, or redeclare `const pipeline`. Post-freeze feature work proceeds on the mongosh line only.

Remaining mongosh-line work (do not block the archive):

- **`pipeline.jsonc` is operator-supplied and not in the tree.** `jsonc-require` is still the load path; mdblib `parseJsonc` is now the shared stripper if this file drops the require. A stub file is optional; do not inline a pipeline just to make `--nodb` load. Header tags this file as requiring this roadmap.
- Always prepends `$sample`; reported times are of the **sampled** pipeline, not the production one.
- `explainOutput.stages` (fallback `executionStats.stages`) misses some sharded / newer explain shapes. Later: walk shard-local stages / `$cursor` (see [mongosh scripting guide](mongosh-scripting-guide.md) — do not treat the echoed command pipeline as an explain stage).
- No `--eval` overlay for `dbName` / `collName` / `sampleSize` (in-file consts). Same `var` + `typeof … === 'undefined'` pattern as other scripts if that lands.

### `fuzzer.js`

**Live: v1.5.0.** **Archive: v0.6.43.** Mongosh-only. Do not restore `db.getMongo().setReadPref('primary')` at the start of `main()`. Compact is archive-only. Schema C random geometries are mdblib `$genPoint`, `$genLine`, and `$genPolygon`. Header tags this file as requiring this roadmap.

Options overlay is **`fuzzer-options.jsonc`** via mdblib `loadJsoncFile` / `parseJsonc` / `deepMergeOptions` (search path, in-shell JSONC strip, deep-merge). `--eval` stays unwired; do not add a second options channel, and do not declare `const dbName` if an eval overlay is ever added. In-file defaults stay the defaults.

**Apply (shell):** do not restore `Bulk.execute(writeConcern)` — the argument is ignored. `insertMany(..., { writeConcern })` is the path. `createIndexes` returns names and throws. `insertedIds` is an object (count keys, including on a partial bulk error). The loader banner prints only when `process.argv` names this file (`isFuzzerCliFile`). `load()` stays quiet; mdblib still loads.

Remaining mongosh-line work (do not block the archive):

- Reshard wait holds the user Promise so mongosh does not exit early. The poll races that promise with an awaited timer; `sleep()` would block the thread and stall the response.
- `w: "majority"` with no `wtimeout` can stall `createCollection` / bulk on PSA or a lagging secondary.
- Shared-tier `fCV()` → `serverVer()` is by design (see mdblib).

**TABLED:** further GeoJSON point classes. Subselect a point onto land, ocean, a major city, a port, a regional city, or leave it random. It may share that pick with other fields if cardinality is opened. Cardinality stays tabled. Shipped `$genPoint`, `$genLine`, and `$genPolygon` stay uniform inside the GeoJSON range until Luke opens this.

**TABLED:** `fuzzer-gen.js`. One `load()` from the fuzzer banner after `mdblib.js`, same search path, same `$` global names. Move the fuzzer-only generators and their data (phrase lists, Benford tables, `idiomas`, numeric bounds, `K`, the country table, and the unused pareto, exponential, array, and temperature helpers). Leave `$rand`, `$floor`, `$ceil`, `$getRandInt`, and `Uint32MaxVal` in `mdblib.js` because `shellPid` calls `$getRandInt`. No `module.exports`, no `for(db)`, and no helper-syntax redesign.

### `oplogchurn.js`

**Live: v0.6.0.** **Archive: v0.5.22.** Mongosh-only. Do not restore `slaveOk(readPref)`. Per-command `options.readPreference = { mode: readPref }`. Keep `--eval var intervalHrs`. `Timestamp({ t, i })` only. Header tags this file as requiring this roadmap.

Remaining mongosh-line work (do not block the archive):

- `console.clear()` runs only on a TTY CLI invocation. The loader banner prints only when `process.argv` names this file (`isOplogchurnCliFile`). `load()` stays quiet; mdblib still loads.
- Atlas M0/Flex: `local.oplog.rs` / `hostInfo` / free-space may be hidden or denied — same n/a story as dbstats.
- `$collStats` / `hostInfo` / `serverCmdLineOpts` stay on the connected member (not covered by the aggregate RP).

### `latency.js`

**Live: v0.4.10.** **Archive: v0.4.9.** Mongosh-only (inline polyfill dropped). Do not restore `[mongo|mongosh]`.

Remaining mongosh-line work (do not block the archive):

- Replace `$function` + `sleep` with `$sleep` when the server exposes it; Flex / `javascriptEnabled: false` still bounce.
- `getLog("global")` can be noisy or denied on some Atlas tiers.
- Optional mdblib load for colour tags / version helpers.

### `schema-sampler.js`

**Live: v0.2.17.** **Archive: v0.2.16.** Mongosh-only. Do not restore `setReadPref`. Per-command RP on `$sample`. In-file `const userOptions` is not an `--eval` overlay.

Remaining mongosh-line work (do not block the archive):

- `userOptions.filter.db` / `filter.collection` are unused; catalog regexes are hardcoded in `listDbOpts` / `listColOpts`.
- `adminCommand({ listDatabases })` is always primary.
- Optional mdblib load; `--eval var` overlay requires dropping the in-file `const userOptions`.

### `schema-import.js`

**Legacy archive line: v0.1.8** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not restore `db.getMongo().setReadPref(readPreference)` — writes already target primary. In-file `const userOptions` is not an `--eval` overlay. Create collection/index/view from sampler JSON stays stubbed on this line. Post-freeze feature work proceeds on the mongosh line only.

Remaining mongosh-line work (do not block the archive):

- Implement parse-and-create for DBs, collections + sampled docs, indexes, views. `createIndexes` returns names and throws (not `{ ok: 1 }`). `insertMany` `insertedIds` is an object; count keys, including a partial bulk error. Parenthesize `(await write(...)).field`. See the scripting guide. Header tags this file as requiring this roadmap.
- `listDBs()` logs names but never fills `dbNames`.
- `--eval var` overlay requires dropping the in-file `const userOptions`.

### `killAgedSessions.js`

**Legacy archive line: v0.2.2** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. Post-freeze feature work proceeds on the mongosh line only.

**Apply (shell):** usage examples still pass `let` in `--eval`. Switch those examples to `var`. Do not add IIFE parameters named `filter` / `age` / `batchSize` / `sortByAge` (a parameter hides the global). Keep the failure **throw**; `quit()` is not a reliable `mongosh --file` status. See the scripting guide. Header tags this file as requiring this roadmap.

### `rtt.js`

**Legacy archive line: v0.3.0** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. TODOs stay TBA on the mongosh line.

### `sleepy.js`

**Live: v0.2.7.** **Archive: v0.2.6.** Mongosh-only (inline `console` polyfill dropped).

### `docSizes.js`

**Live: v0.1.35.** **Archive: v0.1.34.** Per-command RP on `$sample`. In-file `const options` is not an `--eval` overlay.

### `batchUpdater.js`

**Not in live `src/`.** Archive **v0.1.6** (strip briefly reached 0.1.7 on master then the file was removed). Invalid `$expr` / `endValue === null` stays archive-only.

### `oidGenerator.js` / `oidFunction.js`

**Legacy archive lines: v0.2.7 / v0.1.5.** OID generator and `$function` view reproduction (mongod 5.0+). Freeze as-is. Post-freeze feature work proceeds on the mongosh line only.

### `ctxDemo.js`

**Legacy archive line: v0.1.0** (mongosh-only). `mdblib.for(db)` sketch; stand-in library, no `load('mdblib.js')`. Freeze as-is.

**Apply (shell):** the stand-in `hello` falls back to `isMaster()`. Leave that on this frozen line. If the sketch is revived, call `hello()` only (SERVER-49989; replies differ). Do not copy the fallback into new scripts. See the scripting guide. Header tags this file as requiring this roadmap.

### `modifiedCountDocumentsByKey.js`

**Legacy archive line: v0.1.7** (mongosh-only). `countDocuments` prototype overload. Freeze as-is.

### `pcg-xsh-rr.js` / `aggregation-template.js` / `misc-scripts.js`

**Legacy archive line: as-is** (no `Version` field). Helpers and snippets. Freeze as-is; do not invent version numbers for the tag.

---

## See also

- [DB Storage tools](DB%20Storage%20tools.md) — dbstats report and compaction column
- [mongosh scripting guide](mongosh-scripting-guide.md)
- [`autoCompact` command](https://www.mongodb.com/docs/manual/reference/command/autocompact/)
- [`compact` command](https://www.mongodb.com/docs/manual/reference/command/compact/)
- [Unsupported commands in Atlas](https://www.mongodb.com/docs/atlas/unsupported-commands/) — M0/Flex deny `autoCompact` and `compact`; limited `serverStatus` / `dbStats`
