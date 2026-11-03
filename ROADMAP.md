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
- **Legacy mongo shell retirement.** Dual-shell tree archived **2026-09-01** at [`legacy/mongo-shell/src/`](legacy/mongo-shell/src/) (tag `legacy-mongo-shell` on `c78904f`). Live `src/` is **mongosh-only** after the [strip pass](#3-after-the-cut--strip-and-streamline). Current library: **`mdblib.js` v1.5.0**.
- **Distribution (TABLED).** npm consumption model and active upgrades via `fetch()` — see [Script consumption](#script-consumption-unify-standalone-vs-modular). Live path stays `mongosh --file` + `load()`. Do not re-propose as the next leftover.

### Legacy mongo shell retirement

**Done.** Dual `mongo` / `mongosh` in one file was the tax until the snapshot. Archive keeps `_getEnv`, `slaveOk`, dual `Timestamp`, boolean `getCollectionInfos`, command-body `options`, and the missing-`console` polyfill. Live `src/` does not. Feature work (emit/options UX, discovery) proceeds on the mongosh line only.

#### 1. Nominal correctness first

Reach a **good-enough** dual-shell snapshot. The bar can be arbitrary, but it should be explicit when drawn, for example:

- Scripts that claim to run under `mongo` actually parse (similar SyntaxErrors).
- Known wrong-result bugs that dual-shell users would inherit (invalid `$expr`, `--eval` shadowing) are either fixed or documented as wontfix in the archive notes. `fCV()` → `serverVer()` on Atlas M0/Flex is **by design** (`getParameter` FCV is restricted there; Atlas is not left on a lagging FCV).
- Version strings and `__script.version` are consistent with the freeze (one patch ahead of the last dual-shell HEAD).

**Per-script adequacy (complete for current `src/`; remaining rows frozen as-is):**

| Script | Dual-shell adequacy line | Notes |
|--------|--------------------------|--------|
| **`dbstats.js`** | **v0.12.19** (+ **`mdblib.js` ≥ 0.15.8**) | Hygiene complete (A1–A8); legacy Unauthorized labels; authz preflight; `filter.system`; ANSI tag table uses a plain object (no `Map`). Further dbstats work (JSON contract, module mode, catalog dual-path, task pool) is **mongosh-line** — do not block the archive on B/C/D/E. Header documents this freeze. |
| **`autoCompact.js`** | **v0.4.36** (mongosh-only) | Not dual-shell (`async` IIFE, `await delay`, mongosh `getLog` / `$listCatalog`). Demarked for the whole-tree freeze anyway. Further work (first-pass progress bar) is **mongosh-line**. Header documents this freeze. |
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
| **`congestionMonitor.js`** | **v0.2.13** (mongosh-only) | Not dual-shell (`async` IIFE, `sleep` poll). Known: `.finally(process.stdout.write(…))` runs immediately — **freeze as-is** (wontfix on this line). Further work (sharding, v8 execution control, `bytes_dirty_intl`/`leaf`) is **mongosh-line**. Header documents this freeze. |
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

Do **not** require `mdblib.for(db)` or a unified options resolver before the cut. Those land on the mongosh-only line.

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
| `mdblib.js` | 0.15.10 | **1.5.0** |
| `dbstats.js` | 0.12.19 | **1.2.9** |
| `autoCompact.js` | 0.4.36 | **1.4.0** |
| `fuzzer.js` | 0.6.43 | **1.14.2** |
| `oplogchurn.js` | 0.5.22 | **0.6.2** |
| `latency.js` | 0.4.9 | **0.4.12** |
| `schema-sampler.js` | 0.2.16 | **0.4.2** |
| `sleepy.js` | 0.2.6 | **0.2.7** |
| `docSizes.js` | 0.1.34 | **0.1.36** |
| `niceDeleteMany.js` | 0.4.11 | **1.0.1** |
| `congestionMonitor.js` | 0.2.13 | **0.5.1** |
| `onlineDefrag.js` | 0.1.4 | **1.8.0** |
| `indexCacheUtil.js` | 0.1.5 | **1.2.0** |
| `killAgedSessions.js` | 0.2.2 | **0.2.3** |
| `ctxDemo.js` | 0.1.0 | **0.2.2** |
| `schema-import.js` | 0.1.8 | **0.2.2** |
| `discovery.js` | 0.2.1 | **0.2.4** |
| `explainHisto.js` | 0.1.4 | **0.1.5** |
| `rtt.js` | 0.3.0 | **0.3.3** |
| `compact.js` | 0.2.15 | **removed** (archive only) |
| `batchUpdater.js` | 0.1.6 | **removed** (archive only) |

Unchanged vs freeze (still in live `src/`): `connStats` 0.1.14, `oidGenerator` 0.2.7, `oidFunction` 0.1.5, `modifiedCountDocumentsByKey` 0.1.7.

#### 3. After the cut — strip and streamline

**Executed in live `src/` (shim deletion in `mdblib.js` v0.15.11).** Archive is unchanged. Live library is **v1.5.0**. `for(db)` is still later. The `MetaStats` façade was dropped after this pass.

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

Callers such as **`discovery.js`** treat that JSON as the job result per host. Executors consume the same object. CLI `output.format: json` should be the same contract printed once, not a parallel ad-hoc dump.

Entry-shape sketch (exact API TBD with the library story):

```text
interactive CLI:  gather → emit(report) → optional return
module mode:      gather → return contract   (emit only if caller asks)
```

Do **not** block feature work on a full `mdblib.for(db)` redesign; a convention (`options.output.mode: 'interactive' | 'module'`, or `collect*()` vs `main()`) can land first inside each script, then homogenise emit helpers when the library path settles.

**Shipped:** `dbstats.js` detects CLI `--file` from `process.argv` (`isDbstatsCliFile`). `await load('dbstats.js')` is quiet and the async IIFE returns the JSON contract. `load()` is not rewriter-awaited. The same argv test gates the loader banner in `autoCompact.js` (`isAutoCompactCliFile`, v1.3.0), `onlineDefrag.js` (`isOnlineDefragCliFile`, v1.8.0), `fuzzer.js` (`isFuzzerCliFile`, v1.6.0), and `oplogchurn.js` (`isOplogchurnCliFile`, v0.6.0). `load()` of those files stays quiet; mdblib still loads where the script requires it. `oplogchurn.js` clears the screen only on a TTY CLI run. `onlineDefrag.js` does not `load()` dbstats; a snapshot is the awaited contract, not a scraped table and not three interactive loads.

**TABLED:** refactor for an **npm consumption model**. Today operators `mongosh --file` a script and `load()` `mdblib.js` from `$MDBLIB` / `~/.mongodb` / cwd. `require` / `module.exports` run in a different context where the shell `db` global is missing — mdblib leaves `module.exports` commented; helpers that touch `db` stay on `load()`. A published package (`package.json` exports, `npm install`, Node `import`/`require`, mongosh snippets registry, bin wrappers that spawn `mongosh -f`) waits on the library story (`for(db)` so a module API can take a session instead of the free global). Do not uncomment `module.exports`, add a `package.json` publish surface, or split the IIFEs for npm until Luke opens this. CLI `--file` and `load()` stay the live consumption model. Do not re-propose as the next leftover.

**TABLED:** **active upgrades via `fetch()`**. mongosh’s Node `fetch` could pull a newer `src/*.js` / `mdblib.js` (GitHub raw / tagged release) into `$MDBLIB` and compare `__script.version`. Later shape if opened: **opt-in**, fail-soft (air-gap, TLS intercept, 404), pin a **tag or checksum** (not floating `master`), upgrade `mdblib` with its callers together, never `eval` a remote body as `--eval`, never fetch from a `load()` of a support script (discovery fan-out). Operators update by git / copy today. Do not re-propose as the next leftover.

### User options UX (streamline past `--eval` globals)

Passing knobs today is janky and inconsistent, mostly because of **mongosh** — not because a document of options is wrong:

- **`--eval 'var options = {…}'` + `--file`** is the documented pattern ([mongosh scripting guide](mongosh-scripting-guide.md)): `--eval` must use `var`, the script must **not** declare the same binding, probe `typeof … === 'undefined'`, then merge. Easy to get wrong (`let`/`const` redeclaration, nested shallow merge, different global names per script).
- Global name drift: `options` vs bare scalars (`intervalHrs` in oplogchurn). autoCompact uses `var options`.
- Nested defaults are shallow-merged in places (dbstats `sort.*`), so a partial override can wipe sibling keys.
- Shell quoting of inline JS objects is hostile (regex literals, nested quotes, Windows).
- mongosh owns `argv` / connection flags; scripts do not get a clean POSIX flags surface after `-f` without careful parsing of leftovers or an outer wrapper.
- Module callers (`discovery`) want a **plain object argument**, not a side-effect global.

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
- Standardise on **one eval global name per script** (`options`; autoCompact alias removed).
- Deep merge by section so partial `{ sort: { collection: { dataSize: -1 } } }` does not clobber other sort keys.

#### 4. Module / discovery path

- Non-interactive callers pass the options object **as a function argument** (`collectDbStats(db, options)`), never by setting a global. Same schema as the file/CLI document.
- Orchestrators (discovery job profile) own the merged document and hand it down; child scripts do not re-read argv.

#### 5. What we will not chase

- A full second copy of mongosh’s own CLI parser.
- Requiring Node/`import` modules before the library story settles — file + `load()`-friendly helpers first.
- Blocking script features on wrappers; wrappers are sugar over the same resolver.

**Shipped (0.26.0 / 0.28.0 / 1.3.0 / 1.6.0):** shared `mdblib.resolveOptions` — defaults → JSONC file → `--eval` overlay. `parseJsonc` lives in mdblib (BOM, `//` and `/* */` outside strings, trailing commas, then `JSON.parse`). Search: explicit path, else basename via `configSearchDirs` (anchor, cwd, `__dirname`, `$MDBLIB`, `~/.mongodb`). Missing default file is silent. Explicit `var optionsFile` / overlay `optionsFile` missing or parse-fail is an error (`warnings[]` code `optionsFile`). `parseScriptArgv` still reads `--config` after `--` if those args appear on `process.argv`; mongosh 2.12 rejects unknown flags before the script runs, so the working explicit path is `var optionsFile`. Plain objects deep-merge; arrays and scalars replace. dbstats revives `filter.db` / `filter.collection` from strings (`"^app$"` or `"/pat/i"`). `output.format` `table` aliases `tabular`. Canonical default names `dbstats-options.jsonc` / `autoCompact-options.jsonc` are searched, not shipped in `src/` (a `{}` there would overlay every cwd run). autoCompact uses `var options`. Fuzzer uses `resolveOptions` (`fuzzer-options.jsonc` then `var options` / `var optionsFile`; `fuzzer-options.jsonc` is shipped beside the script as the sample overlay). Env keys and a 1:1 POSIX flag surface are still later. **explainHisto.js** can drop `jsonc-require` for `pipeline.jsonc` now that the stripper is a helper. The scripting guide pins the canonical example.

**Plan: config file management.** Not started. A missing default file stays silent until this is opened. The version was not bumped.

| Idea | Today | Planned |
|------|--------|---------|
| Generate when no options file and no overlay are provided | The search finds nothing, the run uses in-file defaults, and nothing is written. | A CLI `--file` run writes `<script>-options.jsonc` once. `load()` does not write. This run still uses the in-file defaults. |
| Persist configs in the home workspace | `~/.mongodb` is the last search stop, and it is also a directory scripts are loaded from. | The generated file lives in that home workspace, or in a config directory under it, so options stay apart from `mdblib.js`. |
| What the file contains | Fuzzer ships a commented sample beside the script. dbstats and autoCompact names are searched and are not shipped in `src/`, because a file there would overlay every working-directory run. | Copy the shipped sample when one exists, including `optionsVersion` and the comments. A script with no sample needs a writer. A bare `{}` is not the generated file. |

An explicit `optionsFile` and a file in the working directory still win. `$MDBLIB` stays the library path. Do not overwrite a file that is already there. Do not reorder the search so the home file hides a working-directory file.

---

## By script

### `autoCompact.js`

Keep the file standalone. **Live: v1.4.0.** **Archive: v0.4.36.** Direct-to-member targeting belongs in `discovery.js`. The first-pass namespace bar is output only. `resolveOptions` overlays `autoCompact-options.jsonc` then `var options`. **1.4.0:** `autoCompactOptions` eval alias removed.

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

The storage snapshot other scripts want (discovery-directed jobs, later compact/onlineDefrag targeting). Gather is **catalog-first, then stats** (P1); printers still consume one tree. Dual `$listCatalog` and new formats share that walk.

Shipped recently: views listed once on the nameOnly pass; collection `$collStats` remains the second phase (Unauthorized → `name (unauthorized)`); databases sorted once after the fetch pool; section deep-merge for options (`filter` / `sort.*` / `output`); `output.format` canonical name `tabular` with `table` alias; `formatPct` / `formatRatio` guard zero/non-finite divisors (`n/a` instead of `NaN%` / `Infinity:1`); sort helpers collapsed to `compareBy` + `stableSort`; printers share `metricsCols` / `printRollupRows` / `formatShardCounts`; DB `$stats` map is pure — `rollupDbPath` aggregates totals separately; **`filter.system`** (`true`/`include` default, `false`/`exclude`, `only`) via mdblib `systemCollectionFilter` (replaces dead `systemFilter = /.+/`); authz preflight uses named booleans (`authzAdequate`); legacy Unauthorized detection on `$collStats` / `connectionStatus`; **M0/Flex free-space:** `db.stats()` still wins when it is a real measurement; on shared tier (where db-level reusable bytes are hidden) db/dbPath totals roll up collection WT `$collStats` as a lower bound (`freeStorageSizeSource: 'collStatsRollup'`, `freeStorageComplete` false when authz/filters omit namespaces), with a `*` marker and footnote; **`output.format: json`** is a versioned contract (`JSON.stringify`, `main()` returns the same object) — not `printjson` of the MetaStats tree; **P0:** json stdout gated (no gather blank line / features / mdblib version banners); `nsTableOut` copies rows (no `delete`, real compression); `getDBNames` applies `filter.db` client-side on every platform (Atlas shared/serverless still omit server-side `listDatabases.filter`); `$collStats` passes `readPreference`; `$stats` / non-auth `$collStats` failures stub + `warnings[]` (`(unavailable)`), report continues; **storageSize:** MetaStats no longer coerces `0 → 4096`; stubs/JSON keep 0; tabular collection/index files may show the WT 4 KiB alloc floor; **P1:** names → overlap `$stats` (mapPool `fetchDbStats`) with catalogSnapshot → one untyped `getCollectionInfos` per DB → global `$collStats` in-flight cap (`output.concurrency`) with `onDatabase` free rollup → dbPath; TTY mini-HUD (`done/N`, current DB, run/q, ETA), cleared before the report.

**Live: v1.2.9** (mdblib v1.1.6). **Archive: v0.12.19.** JSON contract is shipped. **P1:** catalog-first then a global `$collStats` in-flight cap (`output.concurrency`, default 8/4) with per-DB `onDatabase` rollup and TTY mini-HUD; json/html quiet. `$collStats` drains via `drainAggCursor` / driver `_cursor.toArray()` so the pool overlaps (shell `toArray()` is rewriter-unwrapped). `load()` without `format: 'json'` gathers quietly and returns the contract (`await load('dbstats.js')`); `--file` still prints the interactive report. `sort.reuse` / `sort.idxReuse` are free/storage ratios; `sort.compaction` ranks compact/rebuild/resync/wait (n/a last). Dedicated `$stats` sizes win even when the collection list is incomplete (`catalogCoverageComplete` false, warning `catalogIncomplete`); collection-sum fallback (`filteredNamespaceRollup`) only when `$stats` itself failed. `catalogCoverageComplete` compares `$stats.collections` to `listedCollectionCount`. Below FCV 9.0 a timeseries name is an extra list entry (`system.buckets.*` is the counted collection). On FCV 9.0 a viewless timeseries is one namespace and counts toward `$stats.collections`. M0/Flex still rolls free from collection WT (`collStatsRollup`; `freeStorageComplete` false when listing holes). Incomplete collStats free is a lower bound. `$collStats` `$group` keeps known-shard reuse as a lower bound (`freeStorageComplete` / `totalIndexBytesReusableComplete`; `statsIncomplete` when an owning shard did not return). **P2 first slice:** `parseDbStats` / `parseCollStats` / `parseIndexStats` DTOs plus `CollectionStats` / `DatabaseStats` / `DbPathStats`; dbstats constructs those types (no kitchen-sink `delete`). `MetaStats` façade dropped. `HostNode` owns connecting-host identity (`DbPathStats.host`). **Dual catalog:** `options.catalog` `auto`|`legacy`|`listCatalog`|`listClusterCatalog` — whole-catalog `$listCatalog` (6.0+) / `$listClusterCatalog` (8.0.10+ mongos fast path) then the existing per-DB `$collStats` walk; `fetchCollectionInfos` fallback on authz/failure (`catalog.builder` / `catalog.fallback` on the JSON contract, warning `catalogFallback`). **fetchStats / materialize:** catalog identity first (`CollectionStats.catalogEntry`); `collection.fetchStats()`, `database.fetchAllStats({ concurrency })`, `dbPath.materialize({ concurrency, onProgress, onDatabase })` with a per-NS `_statsPromise` cache. dbstats `getStats` walks via `materialize` (global `$collStats` in-flight cap; `onDatabase` when each DB completes). JSON/module materialise then serialise. Session snapshot (mdblib) shares atlas platform / `fCV` / `isSharded` from one `hello` / `serverStatus({ wiredTiger: 1 })`; Atlas shared-tier skips doomed `hostInfo` / `getParameter` FCV / `listShards`. That `serverStatus` uses the read preference from the hello already taken. `hello` `isdbgrid` still sets sharded when `serverStatus` is `{ok:0}` and `listShards` did not return shards. A `proc` of `unknown` is not cached. `parseDbStats` / rollup store the DB and dbPath index count as `nindexes` only. `TopologySnapshot.fromSession()` identity shipped in 0.19.0 / 0.23.0; `materializeNodes()` per-node stats (discovery-style child `Mongo()`, serial session swap, no `load()` of discovery.js) in 0.20.0 / 0.24.0. Shared-tier / serverless stay one node. `topology.discover` default true; replica/sharded `summary` is `$stats` rollup per remote, `expanded` is catalog+`$collStats` (sharded expanded fans out seed hosts). Do not gather mongos `local.*` from the router. **0.20.1:** tabular/nsTable list `topology.nodes`; session node is a leading `*`; identity and collection labels pad by terminal display width (emoji / colour tags). **0.21.0:** `output.topology` was the tabular printer; `topology.replica` / `topology.sharded` were gather depth. **0.24.0 / 0.27.0:** `topology.depth` is the one gather+printer knob (`summary` = `$stats` remotes + connecting catalog + member footer; `expanded` = catalog+`$collStats` per member, one table per node; sharded expanded fans out seed hosts). Cluster kind selects the walk. `replica` / `sharded` / `output.topology` alias `depth`. JSON remote `databases` follow `depth`. **0.22.0:** `output.verbosity` is the tabular/nsTable printer (`full` = collections+indexes+views; `summary` = DB rollup; `summaryIdx` = collections+indexes; `compactOnly` = compact/rebuild/wait/resync rows). JSON/module stay the full contract. **0.23.0:** `htmlOut` embeds the JSON contract (click-to-sort; verbosity/topology expanded in-page). **0.23.1:** drop `output.colour` and the HTML colour checkbox; piped tabular colour is mdblib ANSI strip; HTML colour is the inline stylesheet (later a pluggable CSS). **0.25.0:** `limit.*` is a printer projection after verbosity (`limit.n` = hot top-N; metric floors AND, 0 = off). Rank by the first non-zero `sort` key, else reclaimable bytes then compaction. JSON/module stay the full contract; dbPath/DB subtotals stay gather totals. Indexes follow verbosity + floors (not `n`). Views skip when any limit is active. `compactOnly` stacks. **0.25.1:** HTML size columns click-sort by byte magnitude (`data-unit=bytes`); **Free │ reuse** sorts by free bytes. **0.26.0 / mdblib 0.28.0:** `resolveOptions` overlays `dbstats-options.jsonc` then `--eval` `options`; `filter.db` / `filter.collection` revive from strings; json/html peek format from the merged document so a file-only `output.format` stays quiet. Measured `storageSize` 0 stays 0 (including stubs); tabular collection/index rows may display the WT 4 KiB allocation floor. **0.27.0 / mdblib 0.29.0:** `output.profile` gather timings (phases, `$collStats` min/p50/p95/max/sum/overlap, slowest NS; json/html additive `profile`). `hello()` / `serverVer()` are first-read on the session snapshot (`helloDoc`, `serverVerParsed`); `hello(true)` refreshes; `withChildSession` clears both; `db.hello()` stays live. **0.28.0 / mdblib 0.30.0:** `$listClusterCatalog` `shards: true` for expanded mongos owners; skipped when `connectionStatus` lacks `clusterMonitor`. **0.29.0 / mdblib 0.31.0:** global `$collStats` in-flight cap with per-DB `onDatabase`; parallel `fetchDbStats` (`$stats` stays sync); one untyped `getCollectionInfos` per DB; overlap `$stats` with catalogSnapshot (`listDatabaseCatalog` waits for `$stats`); shared-tier skips doomed `hostInfo` / `getParameter` FCV / `listShards`; `serverVerString` / `ensureServerFloor` (no load-time `db.version()`); fold `features` into `connectionStatus`; auto still tries `$listCatalog`; `profile.preGatherMs` / `sinceScriptMs`. **0.30.0 / mdblib 0.32.0:** dbPath **Total** is collection `storageSize` plus `totalIndexSize`; mongod volume from `db.stats()` `fsUsedSize` / `fsTotalSize` (null on Atlas shared-tier and mongos `raw`); `topology.consumption` sums mongod dbPaths when two or more members have stats. **0.30.1:** `--file`/`-f` CLI detect (`++i`); Total/cluster rows omit Data size and Compression; expanded Node sits on the next rule without a blank before Database. **0.30.2:** `topology.depth` default `expanded`. **1.0.0 / mdblib 1.0.0:** overlapping topology fan-out TABLED (`materializeNodes` stays a serial `withChildSession` swap). **1.1.0:** HTML report polish (sans chrome, panels, orange volume meters with percent on the bar, connecting `*` only on the topology table); shared compaction legend on tabular and HTML footers. JSON keys unchanged. **1.2.0 / mdblib 1.1.0:** sharded topology lists CSRS members (`getShardMap` / `sharding.configDB`; additive `configSetName`, node `configsvr`). Cluster consumption includes those mongod dbPaths. When CSRS is listed, the mongos row is cluster data (`dbPath` `cluster data`; no `config` / `local` on the router). Cluster filesystem used/capacity is unique host + `fsTotalSize` (co-located members sharing a disk collapse). **1.2.1:** unique-volume key strips `:port` from hostname; additive `fsVolumeCount` on `topology.consumption`. **1.2.2:** MongoDB 8+ sharded walk grants shard-local `directShardOperations` for user-database `dbStats` / `$collStats`, then revokes. JSON contract version is 1.2.2. **1.2.3:** display labels `Cluster consumption (total)` and mongos dbPath `cluster data (no local/metadata)`; Compaction / Idx compaction stay on rollup tables and drop from namespace/collection/index tables except compactOnly; cluster consumption footnote that those totals are WiredTiger collection and index storage; HTML topology dbPath column widened; reuse cells use `/` and space-padded single-digit percents (` 5.0%`). JSON keys unchanged. JSON contract version is 1.2.3. **1.2.4:** HTML Total row blanks Data size and Compression; catalog tables drop always-blank columns; sortable headers show ⇅ / ▲ / ▼. JSON keys unchanged. JSON contract version is 1.2.4. **1.2.5:** HTML Namespaces caption is Namespaces (collections); Compaction is back on Namespaces and Indexes; topology Cluster table has Compaction and Idx compaction. JSON keys unchanged. JSON contract version is 1.2.5. **1.2.6 / mdblib 1.1.1:** HTML body/table fonts +1px (16px / 14px); Namespace/ident column auto-widths; mongos `$collStats` per-index shard merge sums accumulator `storageSize` (the first shard row is renamed off `file size in bytes`). JSON keys unchanged. JSON contract version is 1.2.6. **1.2.7:** tabular Compaction column is always on collection/index/namespace rows and Database headers (same as HTML). compactOnly still filters which rows print. JSON keys unchanged. JSON contract version is 1.2.7.

**1.2.8 / mdblib 1.1.3:** per-DB catalog listing uses `fetchCollectionInfos` (driver `listCollections().toArray()`); `output.profile` adds additive `dbStats` overlap (same shape as `collStats`). JSON keys unchanged. JSON contract version is 1.2.8.

**1.2.9:** FCV 9.0 viewless timeseries counts toward `$stats.collections` (`listedCollectionCount`, and a timeseries-only `$listCatalog` slice covers that count). Below FCV 9.0 the timeseries name stays an extra list entry. JSON keys unchanged. JSON contract version is 1.2.9.

**TABLED:** awaitable aggregation cursor shell-API — a helper that makes mongosh `aggregate` a Promise-of-cursor so `await coll.aggregate(…)` waits for the **cursor object** and does not `toArray`/drain. Useful for streaming `for-await` / `yield*` call sites. Does not change `$collStats` (one-document helper; drain stays driver `_cursor.toArray()`), `mapPool`, or the JSON contract.

**TABLED:** mongos omitting mongod-local namespaces (`local.*` / shard-local-only). Preferred shape is an explicit out-of-scope call-out on a pure mongos connection. Filling those namespaces needs multi-node / topology discovery (`discovery.js` / `topology.discover`); do not gather them from the router alone. P2 first slice (parsers / typed objects) shipped as dbstats 0.15.0 / mdblib 0.19.0; `MetaStats` façade dropped in 0.15.1 / 0.19.1; `HostNode` in 0.15.2 / 0.19.2; dual `$listCatalog` in 0.16.0 / 0.20.0; `fetchStats` / `materialize` in 0.17.0 / 0.21.0; session snapshot in 0.17.3 / 0.21.3; UUID `base64` / `parseDbStats` `nindexes` in 0.18.2 / 0.22.2; catalog-walker stubs removed in 0.18.3 / 0.22.3; `TopologySnapshot.fromSession()` identity in 0.19.0 / 0.23.0; per-node `materializeNodes()` in 0.20.0 / 0.24.0. Mongos `local.*` on the router aggregate stays tabled.

**TABLED:** overlapping topology fan-out. `materializeNodes` walks remotes in a `for` loop and `await`s `connectAndGather` one host at a time (`withChildSession` swaps global `db` and the session snapshot). Intra-node `$collStats` / `fetchDbStats` overlap stays. Parallel child gathers need `for(db)` so each member has its own session. Do not re-propose as the next leftover.

**TABLED:** Compass-style privilege-inferred namespaces ("ghosts"). Compass Settings → Infer Additional Namespaces from Privileges greys `connectionStatus` `{ showPrivileges: true }` resources that have `find` and a non-empty collection name, even when `listDatabases` / `listCollections` omit them. On Atlas M0 `atlasAdmin` that set is `config` as a database (listDatabases never returns it), `config.settings`, `local.replset.election`, `local.replset.minvalid`, plus `config.system.js` / `local.system.js` / `local.system.replset`. `local.oplog.rs` is already listed. Do not fold ghosts into `getDBNames`, the catalog walk, or `$collStats` (`atlasHide` still strips admin/config/local on shared-tier; most ghosts AtlasError 8000 on find/`collStats`; M0 `local.oplog.rs` `$collStats` is a shared-tier capped file). Later shape if opened: additive inferred list from the existing `connectionStatus` call with `showPrivileges: true`; skip `$collStats` and `catalogCoverageComplete`. Do not re-propose as the next leftover.

**TABLED (aspirational):** HTML report as a standalone viewer of the JSON contract. dbstats gathers; `htmlDocument` / `htmlReportBoot` stay inlined for `--file` stdout. A later split would lift the page so it binds `window.__DBSTATS` (or `load()` JSON) without the gatherer consuming Figma or an exported shell. No Figma two-way sync; Figma sketches the viewer only. An external HTML template and Code Connect stay closed. Pluggable stylesheets belong to the mdblib output-formatter plan, not this viewer. Do not re-propose as the next leftover.

**Non-goal:** live HTML refresh (in-page re-snapshot without a full page reload, durable run mode, companion listener). Static `htmlOut` is the report. Recs skip it. Do not re-propose.

**Apply (shell):** `resolveOptions` is shared (mdblib 0.28.0). dbstats overlays `dbstats-options.jsonc` then `--eval` `options` / `optionsFile`. Revive `filter.db` / `filter.collection` from strings; do not inline a second parser. CLI vs `load()` via `process.argv` is the pattern other scripts copy. Header tags this file as requiring this roadmap.

#### System namespace filter

Orthogonal to `filter.db` / `filter.collection` regexes. “System” means collection/view **names** matching `system.*` or `replset.*` (not admin/config/local DB exclusion — that stays in `getDBNames` / Atlas paths). Default **include** preserves historical dbstats behaviour; operators opt into `system: false` or `system: 'only'` instead of negative-lookahead regexes. Shared predicate lives in mdblib so dual catalog builders (legacy + `$listCatalog`) reuse it. Listing is `listCatalogSnapshot`; the unused `getAllNonSystem*` / `getAllSystemNamespaces` stubs are gone. `indexCacheUtil.js` v1.2.0 keeps its own local walker (`$listCatalog`, then `getCollectionInfos`, including `admin` / `config` / `local`).

#### Output formats

- **`json` (shipped contract, live 1.2.9).** `output.format: json` prints a **versioned object** (`ok`, `name`, `version`, `catalog`, `topology`, `totals`, `databases[]`, `namespaces[]`, `warnings[]`) — same payload `main()` returns for load() / module callers. `catalog` is `{ builder, fallback }` (`legacy` | `listCatalog` | `listClusterCatalog`). `topology` is `kind`, `setName`, `shardIds`, additive `configSetName`, `nodes[]` (identity plus per-node `stats` totals, additive `configsvr`; `databases` on remotes when replica/sharded is `expanded`), `errors[]`. Consumers: `discovery.js` (per-node job payloads), later `autoCompact` / `compact` / `onlineDefrag` targeting. Ranked flat list *and* hierarchical rollup (db → collection → index); namespace rows are `{ ns, kind, dataSize, storageSize, freeStorageSize, objects, compaction, … }`. Keep `n/a` free-space as `null`, not `0` (Atlas M0/Flex). Additive `totals.totalSize` is collection `storageSize` plus `totalIndexSize` (the dbPath **Total** line). Additive `fsUsedSize` / `fsTotalSize` / `fsFreeSize` are the mongod volume from `db.stats()` (same on every database; omitted on Atlas shared-tier and on a mongos `raw` aggregate). `topology.consumption` sums mongod dbPaths when two or more members have stats (skip the mongos router; include CSRS). When db/dbPath totals come from collection WT instead of `db.stats()`, include `freeStorageSizeSource` (`'dbStats'|'collStatsRollup'|'unknown'`) and `freeStorageComplete` (and the index equivalents); incomplete collStats free is a lower bound. Dedicated `$stats` sizes stay on the DB/dbPath rows even when `catalogCoverageComplete` is false. Peel the contract to stable keys; do not leak printer-only fields.
- **`html`.** **Shipped 0.23.0.** `htmlOut` embeds the JSON contract in a self-contained page (click-to-sort tables). Size columns sort by byte magnitude (IEC units on the cell, `data-unit=bytes`); **Free / reuse** sorts by free bytes. Verbosity / `topology.depth` expanded / `limit.*` top-N filter that payload in the browser. Colour is the inline stylesheet. A shared formatter with pluggable stylesheets is the mdblib output-formatter plan and is not started. dbstats keeps this stylesheet until a later slice moves its printers. Redirect stdout to a `.html` file.
- **Non-goal:** live HTML refresh. The page does not re-snapshot via script-side / local API hooks. Static `htmlOut` is the report. Recs skip it. Do not re-propose.
- **0.25.0 printer projection:** `limit.*` (`n` = hot top-N after verbosity; metric floors AND, 0 = off). Rank by the first non-zero `sort` key, else reclaimable bytes then compaction. JSON/module stay the full contract. `sort.compaction` / `sort.reuse` / `sort.idxFreeStorageSize` and format aliases (`tabular` / `table`) are shipped. `output.verbosity` (`full` / `summary` / `summaryIdx` / `compactOnly`) is the tabular printer as of 0.22.0 and the HTML initial view as of 0.23.0. Piped tabular colour is mdblib ANSI strip; there is no `output.colour`.

`compactionHelper` (20% collection / 50% index / 50% dbPath, plus WT min reclaim) stays the “is this worth it” predicate.

#### Dual catalog builder

**Shipped** in dbstats **0.16.0** / mdblib **0.20.0**. Namespace discovery bifurcates, then feeds the existing per-DB `$collStats` walker (no duplicate stats / print paths):

| Builder | When | Notes |
|--------|------|--------|
| **Legacy** | Fallback, `catalog: 'legacy'`, or servers below 6.0 | `listDatabases` + `fetchCollectionInfos` (`nameOnly` + `authorizedCollections`; driver `listCollections().toArray()`) so partial-privilege users still see names; `$collStats` may tag `(unauthorized)`. |
| **`$listCatalog` / `$listClusterCatalog`** | Newer servers when available and authorised | Whole-catalog materialisation, sliced per DB. `$listCatalog` from **6.0+** (collectionless admin; best-effort). `$listClusterCatalog` from **8.0.10+**, docs mark it **unsupported / unstable** — optional fast path on mongos, never the only path. |

Selection: `options.catalog` `auto` (default) | `legacy` | `listCatalog` | `listClusterCatalog`. Auto: mongos && 8.0.10+ tries `$listClusterCatalog`, else 6.0+ tries `$listCatalog`, else legacy. On catalog-stage failure or authz denial, fall back to legacy without aborting the report. Expanded mongos gather passes `shards: true` and keeps the owner ids for the `$collStats` completeness check; other gathers omit it. The stage is skipped when the connecting `connectionStatus` already lacks `clusterMonitor`. 8.0+ collectionless `$listCatalog` redaction of `system.*` is filled from `listCollections`. JSON `catalog.builder` / `catalog.fallback`; warning `catalogFallback` when the stage was unavailable.

Catalog identity still lands before stats. `fetchStats` / `materialize` shipped in dbstats **0.17.0** / mdblib **0.21.0** (see [`MetaStats` redesign](#metastats--typed-storage--topology-model)).

#### Concurrency (stats fetch)

Stats need **both** per-DB `$stats` and per-collection `$collStats` (dedicated: `db.stats()` wins when free-space is real; M0/Flex: collStats rollup is the lower bound). A DB’s free-space rollup still waits until that DB’s `$stats` and all of its collection stats are in; `onDatabase` fires when that DB’s remaining collections hit 0. The `$collStats` **in-flight cap is global** so other DBs can fill while one DB is still in flight.

P1 walk:

1. **All DB names** (`getDBNames`).
2. **Overlap `$stats` with catalogSnapshot.** `fetchDbStats` via `mapPool` (user-defined async + `awaitPlain` of driver `command()`; shell `runCommand` is synchronous and does not overlap; `$stats` stays the sync helper). Whole-catalog `$listCatalog` / `$listClusterCatalog` once (`catalog:legacy` skips the stage; auto still tries on shared-tier). `listDatabaseCatalog` waits until `$stats` is applied (`catalogSliceNeedsLegacy` uses `ncollections` / `nviews`).
3. **Per-DB catalog listing.** One untyped `fetchCollectionInfos` per DB (driver `listCollections().toArray()` so `mapPool` overlaps; shell `getCollectionInfos` is the fallback), types split client-side. Seeds HUD `N`.
4. **Global `$collStats` in-flight cap** (`output.concurrency`) across DBs; `onDatabase` sorts and `applyFreeStorageRollup` when each DB’s collections complete. Views stay nameOnly (no pool).
5. **dbPath rollup** once every DB has collection stats.

Pool size is an option (default conservative on mongos). The cap is cluster-wide; mutation and free-space rollup stay per-DB via `onDatabase`.

**Mini-HUD** (shipped, TTY tabular/nsTable; json / html / piped quiet): phase 1–2 light (`dbStats i/D`, `catalog i/D`); after catalog, `done/N` plus current DB and in-flight/queued in the global pool; cheap ETA. `MiniHud` + `mapPool` in mdblib. Clear the HUD before the report (including on gather failure).

#### Sharding and topology

- **mongos gaps (TABLED):** mongos does not surface **local** namespaces the way a mongod does. Preferred handling is an out-of-scope call-out on a pure mongos connection. Filling `local.*` / shard-local-only views depends on **per-node topology discovery** (`discovery.js` / `topology.discover`); do not invent per-shard stats from the router session.
- **Per-node stats (0.20.0 / 0.24.0; depth 0.24.0 / 0.27.0):** `topology.discover` (default true) connects to advertised replica members and/or shard seeds with discovery-style child `mongodb://` URIs inside mdblib (do not `load()` discovery.js). dbstats stays the measurement payload (`gatherDbPath` on each child session). `topology.depth` `summary` is `$stats` rollup per remote plus connecting catalog and member footer; `expanded` is catalog+`$collStats` per member and one catalog table per node (sharded expanded fans out seed hosts, including the config replica set). Cluster kind selects the walk. `replica` / `sharded` / `output.topology` alias `depth`. JSON remote `databases` follow `depth`. Shared-tier / serverless stay one connecting node (policy: compact / autoCompact cannot run on those tiers; M0/Flex still advertise a replica set). Do not re-propose shared-tier fan-out. Serial session swap until `for(db)`. This is the dependency for mongos local-NS coverage on mongod snapshots; do not gather `local.*` from the router. CSRS members are first-class mongod nodes (`configSetName`, `configsvr`); `topology.consumption` includes them. When those members are listed, mongos totals omit `config` and `local` and the row is labelled `cluster data (no local/metadata)`. Cluster footer label is `Cluster consumption (total)`. Compaction / Idx compaction stay on rollup tables; namespace/collection/index tables omit them except compactOnly. Do not query `config.mongos`.
- Standalone and single-mongod paths unchanged.

#### Hot summary

**Shipped 0.25.0** as a printer projection (`limit.n`), not a new verbosity. Tabular / nsTable / HTML initial view: verbosity filter, then `limit.*` metric floors (AND, 0 = off), then if `n` > 0 rank and slice. Rank is the first non-zero `sort` key for that section, else reclaimable bytes descending then compaction (`resync` > `rebuild` > `compact` > `wait`). Summary `n` is top-N databases; otherwise `n` is a global collection/namespace cap (per node when `topology.depth` is expanded). Indexes follow verbosity + floors, not `n`. Views skip when any limit is active. `compactOnly` stacks. JSON/module stay the full gather contract; dbPath/DB subtotals stay gather totals.

### `compact.js` / `onlineDefrag.js`

Per-namespace `compact` and update-based defrag.

**`compact.js`:** not in live `src/` (archive **v0.2.15** only). Do not restore it without a mongosh-line rewrite. Do not restore `const … reportLog`.

**`onlineDefrag.js` live: v1.8.0** (mdblib). **Archive: v0.1.4.** `--eval var` for `dbName` / `collName` / `defragOptions`. Do not top-level-await. This IIFE stays one namespace. Do not `load()` dbstats here. Header tags this file as requiring this roadmap.

**Shipped** on the live mongosh line (archive freeze stays v0.1.4): loads mdblib; `$collStats` is awaited; packed-temp WT is one shell `aggregate().toArray()[0]`; no `storageStats()` helper and no `withTransaction` (`startTransaction` is the writer). The loader banner prints only when `process.argv` names this file (`isOnlineDefragCliFile`). Do not read `mongo._uri`. **Page-fill autotune:** omit `pageFillRatio` and `autotunePageFillRatio` sets it from the packed sample’s settled `$collStats` (TFR × avg / C / leaf, clamped 0.5–0.95); WT too-small-to-compress pages (>5%) lower it further; set the knob to pin; 0.9 is only the tiny-sample fallback. **Double rewrite:** default `naturalReplay` parks a generation’s `_id`s (`freezeWindow`), rewrites, waits for a checkpoint, then rewrites the same batch (`maybeReplay`, `replay: 'onExtend'|'always'`). Reclaim is `$natural:-1` EOF-extend + replay so WT can shorten the file when the boundary page moves (`reuseFloor` 0.2 stops reclaim). Dirty path pauses while cache `bytes allocated for updates` ≥ `updatesSoft` (0.07); `updatesHard` (0.08) lowers that floor. Packing-induced reusable **up** in a **fixed** `storageSize` is compact-ready (`skip replay`); `storageSize` **up** is an extend (replay). This script’s job is **page occupancy**; `compact` / `autoCompact` then move allocated pages. Atlas M0/Flex [deny `compact`](https://www.mongodb.com/docs/atlas/unsupported-commands/); reclaim tail is the trim path there. **1.8.0 AIMD:** `dirtyBudgetRatio` (start from `dirtyBudgetRatio` or `generationRatio`, default 0.2) is the generation cap as a fraction of reusable. Settled (post-checkpoint) `storageSize` **up** halves the ratio (floor 0.05); no-extend settled stats add 0.02 (cap 1). The cover loop stops when `G` (reusable/storageSize) ≤ `reuseFloor` or density plateaus (|ΔG| < 0.005 for two settled cycles). Reclaim EOF-extend does not AIMD. Cache `updatesSoft` / `updatesHard` pause is unchanged.

Remaining mongosh-line work (do not block the archive): none.

Later (not this IIFE): point `compact` / `_id` rebuild at a single dbstats “compact” / “rebuild” row when autoCompact’s file walk is the wrong tool. Pre-v8 `compact` has no `freeSpaceTargetMB` — no oplog trim path on this script.

### `discovery.js`

**Live: v0.2.4.** **Legacy archive line: v0.2.1** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. Do not strip named capture groups for legacy mongo. Post-freeze feature work proceeds on the mongosh line only. Header tags this file as requiring this roadmap.

**0.2.2:** a multi-host parent URI is parsed from the first host. `URL()` rejects comma-separated hosts. Child userinfo is re-encoded.

**0.2.3:** when `config.mongos` has an advisory FQDN, the port is the last colon field of `_id`. That is `27017` for both `host:27017` and `[2001:db8::1]:27017`. The second field of a bracketed IPv6 id is not the port.

**0.2.4:** that port is `$last` of the `_id` split. On 4.4 this is the array operator, an alias of `$arrayElemAt` index `-1`.

**Apply (shell):** parent URIs stay `db.getMongo().getURI()` (already; do not switch to `mongo._uri`). WHATWG `URL` rejects comma-separated hosts: parse userinfo and query from the first host, and re-encode userinfo. Do not send awaitable `hello` (`maxAwaitTimeMS` / `topologyVersion`). A per-host job is `await load()` of a script whose argv test says it is not the CLI file (`dbstats.js` is the pattern), not a scraped banner.

- Plugable command profiles (autoCompact as a per-member job; **dbstats in module mode** as a measurement profile — JSON contract per host, no interactive table on the wire).
- Prefer invoking support scripts in **non-interactive / module mode** so fan-out results are structured (`ok`, host, payload, warnings), not ANSI logs to stitch together.
- **Direct-to-member for compact / per-node dbstats:** replica-set URI without `directConnection=true` lands on the primary; only that process is compacted (not replicated), and mongos-level dbstats misses mongod-local namespaces. Warn when `hello().me` ≠ connected host, or when `isWritablePrimary` and the seed list looks like a set. Pin each member (prefer secondaries first) and run autoCompact / dbstats per host.
- Standalone, load-balanced, arbiters.
- Execution modes: serial; shards in parallel / serial per shard; limited pool; jitter; timeout cancel. (dbstats’ internal stats **task pool** is separate — discovery owns cross-host fan-out.)
- Target primary vs secondaries only.
- Load / lag metrics beside each directed command.

### `congestionMonitor.js`

**Live: v0.5.1.** **Legacy archive line: v0.2.13** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. Known `.finally(process.stdout.write(…))` (write runs immediately) is **wontfix on this line**. Live restores the terminal on process exit. Post-freeze feature work proceeds on the mongosh line only.

**Shipped** on the live mongosh line (archive freeze stays v0.2.13): per-shard WT fold (collection-owning or all shard primaries; child `mongodb://` matches niceDeleteMany, no `load()`); MongoDB 8 execution-control on the snapshot + EQ (`executionControlDeprioritizationGate`, `usesThroughputProbing`, normal and low-priority `queues.execution.{read,write}.queueLength`, interval wait from `totalTimeQueuedMicros`); `bytes_dirty_intl` / `bytes_dirty_leaf` mapped from `tracked dirty internal/leaf page bytes in the cache`. Monitor-only — niceDeleteMany AIMD does not trip on execution-control. `lowPriorityAdmissionBypassThreshold` is dropped.

**0.5.0:** drops the `tenantMigrations` opt-in and the `activeShardMigrations` vital. That section was the serverless tenant-migration gauge, removed in 8.1. `activeRangeDeleter` stays on `shardingStatistics.rangeDeleterTasks`.

**0.5.1:** the alternate screen and the cursor are separate sequences (`?1049h`, then `?25l` after `clear()`; `?1049l` then `?25h` on the way out). A combined CSI ends at `l`, so the cursor stayed hidden and the alternate screen never opened. Restore runs on process exit. The EQ draws do not settle, so a `.finally` on those promises never ran.

Remaining mongosh-line work (do not block the archive): none.

### `niceDeleteMany.js`

**Live: v1.0.1.** **Archive: v0.4.11.** `--eval` must use `var`. Do not declare `dbName`/`collName`/`filter` in-file. Do not top-level-await. Do not restore `Mongo.setReadPref`. Header tags this file as requiring this roadmap. Shared AIMD (`maxInFlight` MD/AI) for WT and paceMaker; WT FSM vs pace delay stay separate gates. `hasUserHint` / `hasUserCollation` collapsed to `hasNonEmptyDoc`. Policy A is `POLICY_A_STEPS` (C1 cannotSpill scan, C2–C3 user hint, C4/C7 unhinted planner then Policy B, C6 `_id` scan). MongoDB 9.0 supported as of 1.0.1: the script walk/delete path is not dotted-path-null-sensitive; user filters follow the server matcher (9.0.2 factory default of `internalQueryLegacyDottedPathNullSemantics` is pre-9). Do not re-propose a filter/curation refactor for that matcher.

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

**Live: v1.5.0.** **Archive: v0.15.10** — pair archived scripts with 0.15.10, not live mdblib. **1.2.0** `resolveOptions` warns when the caller passes `optionsVersion` and a loaded file or `--eval` overlay does not match that contract. A missing `optionsVersion` on a loaded file warns. Unknown keys warn. Open paths and arrays are not walked. A missing default file stays silent. Callers that omit `optionsVersion` are unchanged. The run continues. Do not “fix” `fCV()` → `serverVer()` on M0/Flex. MiniHud + `mapPool` replace the stub `ProgressTracker`. `$collStats` is **async** (await the call; do not await the aggregate cursor — thenable drains). Drain via `drainAggCursor` / driver `_cursor.toArray()` (native Promise) so the dbstats `mapPool` overlaps; shell `toArray()` is rewriter-unwrapped to an array and serialises. Callers must `await` it (user-defined async is not rewriter-awaited): `CollectionStats.fetchStats`, oplogchurn, onlineDefrag. `$listCatalog` / `$listClusterCatalog` / `listCatalogSnapshot` list namespaces (`{ db, name, type }`; expanded mongos also keeps `shards` for owners). dbstats falls back to `fetchCollectionInfos`. The cluster stage is skipped when `connectionStatus` already lacks `clusterMonitor`. `bsonMax`, `maxMessageSizeBytes`, `maxWriteBatchSize`, `pid`, and `nonce` are first-read globals; `load()` does not call `hello`, `serverStatus`, or `features` for them. `$collStats` `$group` sums known-shard reuse as a lower bound (`freeStorageKnownCount` / `indexReuseKnownCount`, `freeStorageComplete` / `totalIndexBytesReusableComplete`); `statsIncomplete` when an owning shard (config.chunks / db primary) did not return — a collection on a subset of cluster shards is complete. **P2 first slice:** `parseDbStats` / `parseCollStats` / `parseIndexStats` plus `StorageMetrics` / `CollectionStats` / `DatabaseStats` / `DbPathStats`; `MetaStats` façade dropped; `HostNode` owns connecting-host identity. **fetchStats / materialize:** `collection.fetchStats()`, `database.fetchAllStats({ concurrency })`, `dbPath.materialize({ concurrency, onProgress, onDatabase })` (global `$collStats` in-flight cap; `onDatabase` when each DB completes); `fetchDbStats` is the async `$stats` path and awaits driver `MongoClient.command()` (shell `runCommand` is synchronous and does not overlap; `$stats` stays sync); cache `_statsPromise` per collection. Callers materialise then serialise. Owning-shard ids are cached on the Map for one `materialize` / `fetchAllStats` gather. A lone `$collStats` does not keep them. `__collStatsOnMongos` stays a session cache. `serverStatus(options, statusReadPref)` has no default read preference: an explicit string wins; omitted, `hello().secondary` selects `secondaryPreferred` on a secondary and `primaryPreferred` otherwise; `null` skips that hello and runs on the connected member. A thrown command returns `{ ok: 0, error }` and does not throw. That parameter does not hide the stats global `readPref`. `AutoFactor.format` returns `"unknown"` for a non-finite value, clamps negatives to 0, and keeps a value below 1 byte on the byte scale. **Session snapshot:** first read of atlas platform / `fCV` / `isSharded` shares one `hello` / `serverStatus({ wiredTiger: 1 })`; Atlas shared-tier (`atlasVersion` or `*.mongodb.net` host, no `wiredTiger`, not `isdbgrid`) skips doomed `hostInfo` / `getParameter` FCV / `listShards`; that `serverStatus` uses the read preference from the hello already taken; `hello` `isdbgrid` still sets sharded when `serverStatus` is `{ok:0}` and `listShards` did not return shards; a `proc` of `unknown` is not cached; `load()` does not fill the full snapshot and does not call `serverVer` / `db.version()`; `hello()` / `serverVer()` are first-read (`helloDoc`, `serverVerParsed`, `serverVerString`); `hello(true)` refreshes; `ensureServerFloor` runs on the first snapshot; `withChildSession` clears the sidecars; `db.hello()` stays live. Auto catalog still tries `$listCatalog` on shared-tier. `serverStatus` `none:true` is portable on 8.0 and Atlas M0 (`process`/`pid` remain). `SERVER_STATUS_OPTIONS_DEFAULTS` starts as `{ none: true }` and grows `section: false` from fat replies (`absorbServerStatusKeys`). `$stats` / `$collStats` still own version and Atlas quirks (`hideFree` stays). `compactionHelper(type, storageSize, freeStorageSize)` has no numeric defaults: omitted storage is not the 4 KiB display floor, and omitted or null free returns false. Thresholds stay 20% collection / 50% index / 50% dbPath. `parseDbStats` stores the index count as `nindexes` only (`db.stats()` names that field `indexes`). `UUID`/`Binary.base64()` is a method (`this.toString('base64')`). Unused `getAllNonSystem*` / `getAllSystemNamespaces` stubs are gone; listing is `listCatalogSnapshot` plus `systemCollectionFilter`. `TopologySnapshot.fromSession()` identity shipped in 0.23.0; `materializeNodes()` per-node stats in 0.24.0 (child `mongodb://` helpers in mdblib, do not `load()` discovery.js). Sharded identity includes the config replica set (`getShardMap` / `sharding.configDB`; `cluster.configSetName`, node `configsvr`). `$benford(expMin, expMax)` draws a positive magnitude from a precomputed significand table (inclusive powers of ten, default 0..6, result in `[10^expMin, 10^(expMax+1))`). Schema B `unit` and `price` call it. `$genRandWord` / `$genRandPhrase` use the built-in lexicon. `$genPoint()`, `$genLine()`, and `$genPolygon()` / `$genPolygon(true)` draw schema C GeoJSON (0.26.0). **1.3.0:** `$genMultiPoint`, `$genMultiLineString`, and `$genMultiPolygon` / `$genMultiPolygon(true)` draw the multi geometries. Positions stay inside the longitude and latitude bounds. Rings close and wind the way `$genPolygon` winds them. An omitted count is 2 to 4. An explicit count is capped at 8. **1.4.0:** `$genUniform`, `$genNormalDraw`, `$genBimodal`, `$genTruncatedLomax`, `$genTruncatedExponential`, and `$genPoisson` draw a number. `$genNormal` stays the raw normal. The truncated Lomax is not `$genRandIncPareto`. The truncated exponential is not `$genExponential`. `$poissonSampler` reuses one table per lambda. **0.28.0:** `resolveOptions` / `parseJsonc` / `loadJsoncFile` / `deepMergeOptions` (defaults → JSONC → `--eval`; regex revive; `--config` after `--`). **0.29.0:** `hello()` / `serverVer()` first-read on the session snapshot (`helloDoc`, `serverVerParsed`); `hello(true)` refreshes. **0.30.0:** `$listClusterCatalog` `shards: true` for expanded mongos owners. **0.31.0:** `fetchDbStats` (async `$stats` path; `$stats` stays sync); `materialize` global `$collStats` in-flight cap with per-DB `onDatabase`; snapshot `serverStatus({ wiredTiger: 1 })`; shared-tier skip of doomed `hostInfo` / `getParameter` / `listShards`; `serverVerString` / `ensureServerFloor`; auto still tries `$listCatalog`. **0.32.0:** `parseDbStats` / `DatabaseStats` / `DbPathStats` keep `fsUsedSize` / `fsTotalSize` (mongod volume; null on mongos `raw`). **1.0.0:** overlapping topology fan-out TABLED. **1.1.0:** config replica set in `TopologySnapshot.fromSession()` (`getShardMap` / `sharding.configDB`; `cluster.configSetName`, node `configsvr`). **1.1.1:** `$collStats` per-index shard merge sums accumulator `storageSize` / `freeStorageSize` (the first shard row is renamed off `file size in bytes` / `file bytes available for reuse`). **1.1.2:** `fetchDbStats` awaits driver `MongoClient.command()` so `mapPool` overlaps `$stats`. Shell `runCommand` stays synchronous. `$stats()` stays the sync helper. **1.1.3:** `fetchCollectionInfos` drains driver `listCollections().toArray()` so the per-DB catalog pool overlaps (shell `getCollectionInfos` is the fallback). **1.1.4:** `maxMessageSizeBytes` is a first-read global from the same `hello()`. `$genRandHex`, `$genRandStr`, and `$genRandAlpha` fill one buffer and convert once. **1.1.5:** `$rand` fills 4096 Web Crypto values and returns each as a fraction of `2^32`, in `[0, 1)`. **1.1.6:** `$genRandIntIncPareto` returns an integer in `[min, max]`. `$genRandCardNumber` reads `digits` (amex 15, the others 16) and the check digit passes Luhn. `$genRandCurrency` lists `₱` and `zł` separately. `$genArrayStrings` and `$genArrayInts` are removed.

Document generators now live in `fuzzer-lib.js`, loaded by fuzzer.js after this file. This file keeps the distribution helpers, `$rand`, `$floor`, `$ceil`, `$getRandInt`, `Uint32MaxVal`, and the temperature converters. Shipped in mdblib **1.5.0**.

- **TABLED:** awaitable aggregation cursor helper — Promise-of-cursor so `await coll.aggregate(…)` yields the cursor object (does not drain). Streaming `for-await` / `yield*` only. `$collStats` stays a one-document helper with driver `_cursor.toArray()` drain. See [Thenable cursors](mongosh-scripting-guide.md#thenable-cursors-do-not-await-a-live-cursor).
- **TABLED:** overlapping topology fan-out. `materializeNodes` stays serial (`withChildSession` global `db` swap). Intra-node `$collStats` overlap stays. Parallel children need `for(db)`. See dbstats.js TABLED fan-out.
- **TABLED:** Compass-style privilege-inferred namespaces. Do not merge `connectionStatus` `showPrivileges` resources into `getDBNames` / `listCatalogSnapshot`. See dbstats.js TABLED ghosts.
- **Do not uncomment `module.exports`.** `require` / `exports` run where the shell `db` global is missing. Callers `load()` this file. See the scripting guide. npm packaging / `fetch()` self-upgrade are TABLED under [Script consumption](#script-consumption-unify-standalone-vs-modular). Header tags this file as requiring this roadmap.
- Namespaced helpers / `for(db)` — **after** the library strategy change, not before.
- **Legacy `mongo` shims** — stripped (`mdblib.js` v0.15.11+). Do not restore `slaveOk` / dual `Timestamp` / `_getEnv` loaders. Integer `serverVer` / `fCV` / `shellVer` are in place; do not couple further cleanup to `for(db)`.
- **Shared emit helpers** (see [Script consumption](#script-consumption-unify-standalone-vs-modular)): finish the story beyond today’s `console.log` TTY overload — one path for markup→ANSI, non-TTY strip, progress suppress, and module-quiet. Bring `print` / raw-escape call sites onto it over time. The output formatter below calls this path. It does not replace it.
- **Plan: output formatter.** Not started. The version was not bumped. The formatter lives in `mdblib.js`. Other scripts grow onto it. A script builds a versioned output contract. The formatter renders that contract. `table` is the human report. `json` is the same contract for a caller, printed once, with no colour and no live progress. A stylesheet names the look of a human format. The default stylesheet is the look that script already prints. Another stylesheet replaces colours and rules. JSON is the contract and takes no stylesheet. Today fuzzer paints the HUD in `printHud` (sections run, window, collection, schemas, indexes, then the insert bar, then built index names). `load()` still runs and prints that table. The banner is the quiet part. dbstats already has its own versioned contract (live 1.2.9) and its own tabular, nsTable, and HTML printers. Its HTML colour is one inline stylesheet. Fuzzer’s first slice builds one contract for the run: namespace, documents, writer concurrency, options path, window, collection, schemas, indexes, built index names, insert result, and warnings. `table` renders that contract as the HUD. `json` prints that contract. The insert bar stays progress. It is not a field of the contract, and it stays quiet for `json` and for a pipe. A format key joins the fuzzer options contract when this opens, and `optionsVersion` moves with that key set. Until then an `output` key warns as unknown. dbstats keeps contract version 1.2.9. Moving its printers onto the formatter is a later slice. The standalone HTML viewer, an external HTML template, and Code Connect stay tabled. `fuzzer-lib.js` does not take the formatter. This plan is not a step of the distribution helpers, cardinality, or polymorphic.
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
- Full dbstats report should materialise in a **bounded pool** (not unbounded getter storms).
- Cache fetches on the entity (`_statsPromise`) to avoid duplicate `$collStats` under parallel walkers.
- Catalog identity must remain available when stats fail (existing `(unauthorized)` behaviour).

##### Suggested order

1. Extract DTO normalisers from `$stats` / `$collStats` (behaviour-preserving). **Done** (`parseDbStats` / `parseCollStats` / `parseIndexStats`).
2. Introduce `StorageMetrics` + `CollectionStats` / `DatabaseStats`; point dbstats at them; delete the `delete` soup. **Done** (`DbPathStats` / `IndexStats` / `ViewRef` too; `MetaStats` façade dropped in 0.15.1 / 0.19.1).
3. `HostNode` **Done** (connecting host; `DbPathStats.host`). `TopologySnapshot.fromSession()` **Done** (0.19.0 / 0.23.0). `TopologySnapshot.materializeNodes()` **Done** (0.20.0 / 0.24.0; `{ depth }` in 0.24.0 / 0.27.0): discovery-style child `Mongo()` per advertised remote; serial global-`db` swap; `topology.discover` / `topology.depth` summary|expanded. Shared-tier / serverless stay one node. Mongos `local.*` from the router stays tabled.
4. Dual catalog listing **Done** (`listCatalogSnapshot` / `$listCatalog` / `$listClusterCatalog` + `fetchCollectionInfos` fallback). Catalog-first + `fetchStats` / `materialize` **Done** (bounded per-DB pool, per-NS `_statsPromise` cache). Lazy getters remain REPL-only sugar (not shipped).

### `explainHisto.js`

Aggregation `explain('executionStats')` stage-timer histogram. **Live: v0.1.5.** **Legacy archive line: v0.1.4** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Not dual-shell (`require` / `jsonc-require` / `./pipeline.jsonc`). Do not load mdblib, restore a `[mongo|mongosh]` usage line, or redeclare `const pipeline`. Post-freeze feature work proceeds on the mongosh line only.

**0.1.5:** the bar is the per-stage cost. `executionTimeMillisEstimate` is cumulative from the start of the pipeline; the width uses the delta from the previous stage. A negative delta draws no bar. The printed total stays the sum of those deltas.

Remaining mongosh-line work (do not block the archive):

- **`pipeline.jsonc` is operator-supplied and not in the tree.** `jsonc-require` is still the load path; mdblib `parseJsonc` is now the shared stripper if this file drops the require. A stub file is optional; do not inline a pipeline just to make `--nodb` load. Header tags this file as requiring this roadmap.
- Always prepends `$sample`; reported times are of the **sampled** pipeline, not the production one.
- `explainOutput.stages` (fallback `executionStats.stages`) misses some sharded / newer explain shapes. Later: walk shard-local stages / `$cursor` (see [mongosh scripting guide](mongosh-scripting-guide.md) — do not treat the echoed command pipeline as an explain stage).
- No `--eval` overlay for `dbName` / `collName` / `sampleSize` (in-file consts). Same `var` + `typeof … === 'undefined'` pattern as other scripts if that lands.

### `fuzzer.js`

**Live: v1.14.2.** **Archive: v0.6.43.** Mongosh-only. Do not restore `db.getMongo().setReadPref('primary')` at the start of `main()`. Compact is archive-only. Schema C random geometries are fuzzer-lib `$genPoint`, `$genLine`, `$genPolygon`, `$genMultiPoint`, `$genMultiLineString`, and `$genMultiPolygon`. `$genPoint` takes an optional class. A named draw can share that point. Header tags this file as requiring this roadmap.

Options overlay is **`resolveOptions`**: in-file defaults → **`fuzzer-options.jsonc`** → `--eval` `var options`. Explicit path is `var optionsFile`. Search path, in-shell JSONC strip, and deep-merge live in mdblib. Do not declare `options` / `optionsFile` in this file. Namespace keys (`dbName`, `collName`, `totalDocs`, …) come from the resolved document, not from `--eval` scalars. In-file defaults stay the defaults. `fuzzer-options.jsonc` is shipped beside the script as the sample overlay. `writerConcurrency` is how many inserts stay in flight (default 2). `1` waits for each insert before the next batch is packed, so the shell holds one batch. A value that is not an integer of at least 1 stops the plan. The date draw is `fuzzer.distribution`: `uniform`, `normal`, `bimodal`, `pareto`, `exponential`, or `poisson`. Any other name stops the plan. `fuzzer.distributionParams` sets the shape, in days. Every distribution accepts `offset` and `range` there. Omitted, they use `fuzzer.offset` and `fuzzer.range` (defaults -300 and 365.2422). The HUD prints both. Uniform fills `[offset, offset + range]`. Normal takes `mu` and `sigma` (default center and `range/2`) and is not cut to the window. Bimodal takes `mix`, `mu1`, `sigma1`, `mu2`, and `sigma2` (default quartiles, `range/8`, and mix 0.5); `sigma` fills a width that was omitted. It is not cut to the window. Pareto is a Lomax draw cut to the window (`alpha` 1.161, `scale` = `range`, `origin` `start` or `end`). Exponential is cut to the window (`lambda` default `1/range`, or `mean` instead of `lambda`, same `origin`). Poisson is a frequency draw: each timestamp is a whole day from `origin`, and the day index is Poisson (`lambda` default `range`, or `mean`, same `origin`). It is not cut to the window. The window section of the HUD prints that shape. Normal and bimodal use an 8-sigma span, and poisson uses its practical count span, for the `ts` ObjectId check and the time series TTL warning. The run prints one HUD table of the resolved parameters, including the options file. Regular indexes are preceded by their collation, marked inherited from the collection or specified on `indexOptions`. 2d and text rows include the language. Built index names are a matching section after `createIndexes`. The documents value and the progress byte count are grouped in threes. Batch progress is a bar: `MiniHud` redraws it on a TTY, and a pipe prints one line per acknowledged batch. The live line adds an ETA after the batch number. The finished line omits both.

**Apply (shell):** do not restore `Bulk.execute(writeConcern)` — the argument is ignored. `insertMany(..., { writeConcern })` is the path. `createIndexes` returns names and throws. `insertedIds` is an object (count keys, including on a partial bulk error). The loader banner prints only when `process.argv` names this file (`isFuzzerCliFile`). `load()` stays quiet; mdblib and fuzzer-lib still load.

**Shipped:** reshard wait holds the command Promise and races an awaited timer (`sleep()` would stall the response); majority `wtimeout` defaults to 10000 ms when `w` waits past the primary (`0` waits with no limit); shared-tier `fCV()` → `serverVer()` is by design (see mdblib); **1.6.0** `--eval` `var options` overlays the JSONC file via `resolveOptions`. **1.6.1** `shardCollection` omits `numInitialChunks` unless the collection is empty and the shard key starts with a hashed field. `reshardCollection` still sends the count. **1.6.2** `createCollection` passes `timeseries`. The option flag stays `timeSeries`. `create.timeSeries` is an unknown field. **1.7.0** when `indexPrefs.build` is true, `collectionPlan` stops before create if a time series run would build an index the server rejects. Text and wildcard keys are rejected. Any other type besides `1`, `-1`, and `2dsphere` is rejected unless the field is the `metaField`. The lists are not rewritten. `expireAfterSeconds` of `0` is omitted. A positive number is sent, and the run warns when that threshold already covers the start of the date window. **1.7.1** sizes a bulk batch from `maxMessageSizeBytes` (95% headroom, count cap 1000 and `maxWriteBatchSize`). A sample at or under `bsonMax` still inserts. A sample over `bsonMax` skips the insert. When the largest sample is over 1 MiB, the next batch waits until the insert returns. **1.7.2** drops that headroom and the 1 MiB overlap gate. The batch is `min(1000, maxWriteBatchSize, floor(maxMessageSizeBytes / basis))`, where `basis` is the largest one-at-a-time sample. The average is logged. A sample nested past 64 levels warns, and the run continues. **1.7.3** compiles each schema expression once. Generation yields every 32 documents or 8 ms, so an in-flight insert can finish while the next batch is built. **1.7.4** measures one document from each live schema. The batch stays on the largest. The weighted average is logged. **1.8.0** packs each batch from the documents it inserts. A document that would pass the message limit, minus 32 KiB, starts the next batch while the current batch is inserted. A document over the BSON max is skipped. Progress is inserted over totalDocs. **1.8.1** keeps one packer and allows two inserts in flight. The packer waits while both writes are open. A failed insert stops packing, in-flight inserts are awaited, and a batch that has not been sent is dropped. **1.8.2** adds `writerConcurrency` (default 2). `1` waits for each insert before the next batch is packed. A value that is not an integer of at least 1 stops the plan. The run prints a coloured HUD table of the resolved parameters. The options path sits under the box. Batch progress is a bar, with a comma after the percent and after the byte count. **1.8.3** moves the options path into the run section and prints built index names in a matching section after `createIndexes`. Regular indexes are preceded by their collation, marked inherited or specified. 2d and text rows include the language. **1.8.4** groups the documents value and the progress byte count in threes. **1.8.5** draws the date window as uniform, normal, bimodal, pareto, or exponential. `fuzzer.distributionParams` sets the shape. Any other name stops the plan. **1.8.6** adds a poisson frequency draw: each timestamp is a whole day, and the day index is Poisson. **1.8.7** lets every distribution set `offset` and `range` on `distributionParams`. Omitted, they keep -300 and 365.2422. **1.8.8** adds an ETA after the batch number on the insert progress line. The finished line omits it. **1.8.9** shares the index-group list, the lambda/mean reader, and the day length, and drops the unused options-path helper and the second time-series schema walk. **1.9.0** accepts create slots (clustered index, pre/post images, validator, validation level and action, index option defaults, and views) and shard slots (zones and `presplitHashedZones`). Omitted keys are not sent. A view creates and does not insert. Zones are applied before `shardCollection`. A hashed key with zones sets `presplitHashedZones` and omits `numInitialChunks`. A hashed prefix presplits only one zone, from MinKey to MaxKey. Ranges are half-open. An overlay shard key replaces the merged key. **1.10.0** versions the options file. `optionsVersion` is 1. A loaded file without that version, or with a different one, warns. Unknown keys in the file or the `--eval` overlay warn. The run continues. `fuzzer.interval` is removed. **1.11.0** schema C multi geometries call `$genMultiPoint`, `$genMultiLineString`, and `$genMultiPolygon`. The geometry collection calls those helpers too. Point classes were still tabled. **1.12.0** the date window calls the mdblib distribution helpers. `offset`, `range`, and `origin` stay the window. Days and the HUD stay in this file. **1.13.0** adds `n` and `draws` to the document scope. `optionsVersion` is 2. **1.13.1** shares a named draw across consecutive documents. `span` is the group. `with` and `correlation` vary a child. A pareto or exponential window is `bound`. `optionsVersion` stays 2. **1.14.0** loads `fuzzer-lib.js` after mdblib. The document generators move there. `optionsVersion` stays 2. **1.14.1** `$genPoint` takes a class: land, ocean, city, regional, or port. An omitted or unknown class stays uniform. mdblib stays **1.5.0**. `optionsVersion` stays 2. **1.14.2** a named draw may set `point` to land, ocean, city, regional, or port. The stored value is one GeoJSON Point. Correlation reuses it or draws another of the same class. mdblib stays **1.5.0**. `optionsVersion` stays 2.

Remaining mongosh-line work (do not block the archive): none.

**Removed:** `fuzzer.interval`. The default `7` was unread. Each timestamp already comes from `distributionSpec().draw() * DAY_SECONDS`. The key is gone from `fuzzer.js` and `fuzzer-options.jsonc`. Do not restore it. Shipped in **1.10.0** with `optionsVersion` 1.

**Shipped: distribution helpers.** `$genUniform`, `$genNormalDraw`, `$genBimodal`, `$genTruncatedLomax`, `$genTruncatedExponential`, and `$genPoisson` draw a number for any field. The fuzzer timestamp path is the caller. `offset`, `range`, and `origin` stay the window, and the helper returns the draw. Truncation and origin sit on the Lomax and exponential helpers. `$genPoisson` returns a whole-number count, and an origin places that count on the window. `$poissonSampler` keeps the practical support for one lambda and reuses that table. `$genNormal` stays the raw normal. The date-window pareto is `$genTruncatedLomax`, not `$genRandIncPareto`. The date-window exponential is `$genTruncatedExponential`, not `$genExponential`. Days and the HUD stay in `fuzzer.js`. These helpers stay in `mdblib.js`. The `fuzzer-lib.js` split does not move them. Shipped in fuzzer **1.12.0** / mdblib **1.4.0**.

**Shipped: GeoJSON type helpers.** `$genMultiPoint`, `$genMultiLineString`, and `$genMultiPolygon` draw schema C multi geometries. Each position stays inside the longitude and latitude bounds. Each line is short and shares one corner, the way `$genLine` does. Each polygon ring closes and winds the way `$genPolygon` winds it. `$genMultiPolygon(true)` adds a clockwise hole inside each triangle. A hole stays at least one degree off either pole, because a south edge on the pole does not contain that hole on the sphere. An omitted count is 2 to 4. An explicit count is capped at 8. The geometry collection composes the single and multi helpers. There is no `GeometryCollection` helper. Point classes stay out of this. Shipped in fuzzer **1.11.0** / mdblib **1.3.0**.

**Shipped: cardinality.** Shipped in fuzzer **1.13.0**. mdblib stays **1.4.0**. `optionsVersion` is 2. The document scope is `oid`, `date`, `ts`, `idioma`, `totalDocs`, `n`, and `draws`. `n` is the generation index, starting at 0. `fuzzer.draws` names a shared value for that document. A `values` list is the pool. A `distribution` calls `$genUniform`, `$genNormalDraw`, `$genBimodal`, `$genTruncatedLomax`, `$genTruncatedExponential`, or `$genPoisson`. `pool` freezes that many draws, from 1 through 1000000. `follow` `"n"` reads `pool[n % length]`. Without `follow`, the document picks one index and every field shares it. A name with no pool draws once per document. Days and the date window stay the timestamp caller. A bad name, a param that does not apply, or both `values` and `distribution` stops the plan. The run section lists the names when any are set. The commented `fuzzer.polymorphic.cardinality` knob is not this feature.

**Shipped: cardinality across documents.** Shipped in fuzzer **1.13.1**. mdblib stays **1.4.0**. `optionsVersion` stays 2. The new keys sit inside `fuzzer.draws`.

`span` is how many consecutive documents share one cardinal value. It is an integer of at least 1. Omitted, it is 1, and the draw stays one value per document as in **1.13.0**. The group is `floor(n / span)`. That group's value is drawn once and kept for the run. A pool with `follow` `"n"` walks by group, `floor(n / span) % length`. A pool without `follow` picks one index for the group and keeps it. A name with no pool draws once for the group.

`with` names one parent draw. `correlation` is a number from 0 through 1. The parent group stores one value of the child, drawn from the child's own list or distribution. `1` uses that stored value on every document in the group. `0` draws a new value on every document. Between those, a `values` list uses the stored value when a uniform draw is below the correlation, and otherwise picks another list value. A numeric distribution blends `correlation * stored + (1 - correlation) * fresh` in the child's units. A poisson blend rounds to a whole number of at least 0. An omitted correlation on a child is 1. `correlation` without `with` stops the plan. `span` on a child stops the plan. The parent itself has no `with`. A cycle stops the plan. One parent level only.

A pareto or exponential named draw used `span` in **1.13.0** as the truncation window. That key is now the document group. The window is `bound`, default 1. A child may set `bound` and may not set `span`. The date window does not use this key.

Schema fields still read `=draws.<name>`. The scope stays the one document. Days and the date window stay the timestamp caller. This is one number on a named draw. It is not a constraint language. The polymorphic knob stays commented. A point class is a named draw and is not blended. The output formatter stays its own plan. The run section shows `every N` when `span` is greater than 1, and a child as `with parent correlation`.

**Polymorphic** gets its own plan. It is not a step of the helper sequence and not a step of cardinality. The commented block stays in both files (`enabled`, `varyTypes`, `nests`, `entropy`, `cardinality`, `sparsity`, `weighting`). No reader until that plan is written.

**Plan: output contract.** Not started. The version was not bumped. The formatter is the mdblib plan under [mdblib.js](#mdblibjs). Fuzzer’s part is one contract for the run. `table` renders it as the HUD `printHud` paints today (run, window, collection, schemas, indexes, then built index names). `json` is that same contract for a caller, with no colour and no live bar. The insert bar stays progress and stays off that contract. `load()` today still prints the table. Under this plan `load()` returns the contract and does not print it. A CLI `json` run prints it once. A format key joins the options contract when this opens, and `optionsVersion` moves with that key set. This plan is not a step of the distribution helpers, cardinality, or polymorphic.

**Shipped:** further GeoJSON point classes. Shipped in fuzzer **1.14.1**. mdblib stays **1.5.0**. `$genPoint()` stays a uniform point in `[-180, 180]` by `[-90, 90]`. `$genPoint("land")` and `$genPoint("ocean")` reject in that same measure against a coarse mask. Sixty-four misses fall back to a tested interior point, or to the mid-Pacific. `$genPoint("city")`, `$genPoint("regional")`, and `$genPoint("port")` return a listed coordinate. An unknown class stays uniform. Lines, polygons, and the multi helpers stay uniform. Schema C adds `land`, `ocean`, `majorCity`, `regionalCity`, and `port`. Their 2dsphere indexes stay commented. A named draw may set `point` to `land`, `ocean`, `city`, `regional`, or `port`. The stored value is one GeoJSON Point from `$genPoint`. `span`, `pool`, `follow`, `with`, and `correlation` are the cardinality keys. Correlation reuses that point or draws another of the same class. It does not blend coordinates. `optionsVersion` stays 2. The share shipped in fuzzer **1.14.2**.

**Shipped:** `fuzzer-lib.js`. Shipped in fuzzer **1.14.0** / mdblib **1.5.0**. One `load()` from the fuzzer banner after `mdblib.js`, on the same search path, on a CLI run and on `load()`, including when `__lib` is already defined. A second load is skipped when `__fuzzerLib` is set. The `$` global names stay so schema `=` expressions stay valid. Moved: the fuzzer-only generators and their data (phrase lists, Benford tables, `idiomas`, numeric bounds, `K`, the country table, `$genRandFrom`, and the GeoJSON helpers, including `$geoCount` and the multi helpers). The distribution helpers stay in `mdblib.js`. `$genUniform` still calls `$getRandNum`. `$genRandIntIncPareto` still calls `$getRandIntInc`. The temperature converters stay in `mdblib.js` and read `K` from `fuzzer-lib.js`. `$rand`, `$floor`, `$ceil`, `$getRandInt`, and `Uint32MaxVal` stay in `mdblib.js` because `shellPid` calls `$getRandInt`. No `module.exports`, no `for(db)`, and no helper-syntax redesign.

**Create and shard slots.** Omitted keys are not sent, so a default run matches a run that never set them. `create.clusteredIndex` needs fCV 5.3 and the key `{_id: 1}`. An omitted `unique` is sent as true. A set `unique` must be true. An optional `name` must be a string. It is rejected with capped, a time series, or a view. A sharded run must use the shard key `{_id: 1}`. `create.changeStreamPreAndPostImages` is `{enabled: boolean}` on fCV 6.0 or newer. It is rejected on a time series or a view. Capped is allowed. `create.validator` must be a document. `{}` is omitted. `validationLevel` is `off`, `strict`, `moderate`, or `constraint`. `constraint` needs fCV 8.0 and action `error` or `errorAndLog`. `validationAction` is `error`, `warn`, or `errorAndLog`. `errorAndLog` needs fCV 8.0. `indexOptionDefaults` is sent only when it has keys. `viewOn` creates a view. A missing `pipeline` is sent as `[]`. `pipeline` without `viewOn` stops the plan. The view run prints the HUD, drops, creates, prints the completed line, and returns. It does not pack, insert, build indexes, or shard. A view is rejected with capped, a time series, sharding, `clusteredIndex`, pre/post images, a validator, validation level or action, or index option defaults. `storageEngine` is omitted. Collation and write concern are still sent. The documents row is skipped. `shardedOptions.zones` is an array of `{min, max, zone}`. `zone` is a string or null. `min` and `max` use the shard key fields in order. A non-array stops the plan. An empty array is omitted. The ranges are applied with `sh.updateZoneKeyRange` before `shardCollection`. `presplitHashedZones` needs fCV 5.0, sharding this run, a hashed field anywhere in the key, a non-empty zones array, and an empty or missing collection. `dropNamespace` counts as missing. Zones on a hashed key set the flag even when the boolean is omitted, and `numInitialChunks` is not sent. A hashed prefix can presplit only one zone, from MinKey to MaxKey on every shard-key field. A hashed field later in the key presplits when each lower prefix is not MinKey or MaxKey, the hashed lower bound is MinKey, and an upper prefix differs. Ranges are half-open, so the next zone starts at the previous max. An overlay `shardedOptions.key` replaces the default key, so the field order stays the order in that layer. Zones on a ranged key are applied, the flag stays off, and `numInitialChunks` is not sent. `mayPresplitChunks()` is false when the flag is set or zones are set. An already sharded namespace still returns early. `reshardCollection` copies the same zones and still sends `numInitialChunks` and `forceRedistribution`. The HUD adds a row only for a slot that is set, and the sharding row adds the zone count and a presplit tag when those are set. Shipped in **1.9.0**.

**TABLED:** commented schema experiments. Schema A leaves `Code`, `CodeWithScope`, column-store `BinData(7)`, the sensitive-key `BinData(8)`, `objectArray`, `1dArray`, and the quote IIFE commented. Schema `=` expressions stay synchronous. Schema C multi geometries call `$genMultiPoint`, `$genMultiLineString`, and `$genMultiPolygon`. Schema C point classes call `$genPoint` with a class. Do not re-propose as the next leftover.

**TABLED:** generator gaps in mdblib. `$genRandIncPareto` and `$genExponential` still have no caller. The date window calls `$genTruncatedLomax` and `$genTruncatedExponential`. The `fuzzer-lib.js` split does not redesign them. Do not re-propose as the next leftover. `$genRandIntIncPareto` returns an integer in `[min, max]`. `$genRandCardNumber` reads `digits` (amex 15, the others 16) and the check digit passes Luhn. `$genRandCurrency` lists `₱` and `zł` separately. Shipped as mdblib **1.1.6**.

**TABLED:** `$genArrayStrings` and `$genArrayInts`. Removed in mdblib **1.1.6**. `$genArrayStrings(len)` built strings with `$genRandStr` of length 6..24. `$genArrayInts(len)` built integers in 1..1000. Samples keep `$genArrayElements` (strings of length 4..12) on `array` and `object.nestedArray`. Bring the two helpers back only as their own sample fields, in a pass that revises the helpers together. That pass may deprecate `$ftoc`, `$ctof`, `$ctok`, `$ktoc`, `$ftok`, and `$ktof`. Do not restore the array helpers, and do not delete the temperature converters, until Luke opens this. Do not re-propose as the next leftover.

### `oplogchurn.js`

**Live: v0.6.2.** **Archive: v0.5.22.** Mongosh-only. Do not restore `slaveOk(readPref)`. Per-command `options.readPreference = { mode: readPref }`. Keep `--eval var intervalHrs`. `Timestamp({ t, i })` only. Header tags this file as requiring this roadmap.

**Shipped:** `console.clear()` runs only on a TTY CLI invocation. The loader banner prints only when `process.argv` names this file (`isOplogchurnCliFile`). `load()` stays quiet; mdblib still loads. **0.6.1:** mdblib `serverCmdLineOpts()` (denied `getCmdLineOpts` → `dbPath` unknown); unknown `$collStats` free is n/a compression (StorageMetrics rule, still subtracts internal page size); oplog aggregate catch prints identity and n/a sample/churn. `hostInfo()` already falls back on M0. `$collStats` already uses the global `readPref`. Identity commands stay on the connected member. **0.6.2:** report labels print `N/A`; aggregate `comment` tracks `__script.version`.

Remaining mongosh-line work (do not block the archive): none.

### `latency.js`

**Live: v0.4.12.** **Archive: v0.4.9.** Mongosh-only (inline polyfill dropped). Do not restore `[mongo|mongosh]`.

**0.4.11:** drops `tenantMigrations: false` from the `serverStatus` probe. That section was the serverless tenant-migration gauge, removed in 8.1.

**0.4.12:** a global log with no line for this synthetic comment throws. It is not reported as a server time of `0 - slowms`. A line that does not parse is skipped.

Remaining mongosh-line work (do not block the archive):

- Replace `$function` + `sleep` with `$sleep` when the server exposes it; Flex / `javascriptEnabled: false` still bounce.
- `getLog("global")` can be noisy or denied on some Atlas tiers.
- Optional mdblib load for colour tags / version helpers.

### `schema-sampler.js`

**Live: v0.4.2.** **Archive: v0.2.16.** Mongosh-only. Do not restore `setReadPref`. Per-command RP on `$sample` and on `listDatabases` (`admin.runCommand`, not `adminCommand`). `filter.db` / `filter.collection` drive `listDatabases` / `getCollectionInfos` (RegExp, string, or array of names) and are re-checked client-side. `--eval` `var options` overlays in-file `optionDefaults` (filter keys merge). Do not declare `options` / `userOptions` in this file. Header tags this file as requiring this roadmap.

**Shipped:** **0.3.0** applies `filter` to the catalog walk. **0.4.0** `--eval` `var options` overlay.

**0.4.1:** the collection walk also lists `type: "timeseries"`. That name is the user namespace, and on FCV 9.0 it is the only one. Views stay a separate list. The default collection filter still skips `system.*`.

**0.4.2:** `getCollectionInfos` is not `nameOnly`. A view keeps `viewOn` and `pipeline`. A collection keeps `options`, including `options.timeseries`. `listDatabases` stays `nameOnly`.

Remaining mongosh-line work (do not block the archive):

- Optional mdblib load for colour tags / version helpers.

### `schema-import.js`

**Live: v0.2.2.** **Archive: v0.1.8.** Mongosh-only. Do not restore `db.getMongo().setReadPref(readPreference)` — writes already target primary. `--eval` `var options` overlays in-file `optionDefaults` (`schemaFile`, `drop`). Do not declare `options` / `userOptions` in this file. Parse-and-create reads JSON/EJSON of the schema-sampler array: collections (`createCollection`, passing `options.timeseries` / `expireAfterSeconds` / `collation` / capped `size`/`max` / `clusteredIndex` / `validator` with `validationLevel` and `validationAction`, `insertMany` of `$sample`, `createIndex` minus `_id_` and any index the server already built), then views (`createView` when `options.viewOn` / `options.pipeline` are present). `listDBs()` returns the `db` names. The shell `createIndexes` helper takes key patterns, so each spec is its own `createIndex`. `createIndex` returns the name and throws. `insertMany` `insertedIds` is an object; count keys, including a partial bulk error. Parenthesize `(await write(...)).field`. Existing namespaces are skipped unless `drop: true`. See the scripting guide. Header tags this file as requiring this roadmap.

**Shipped:** **0.2.0** parse-and-create from sampler JSON, `listDBs()` names, `--eval` overlay.

**0.2.1:** a collection with `options.timeseries.timeField` is created as a time series. The default meta/time index is not sent to `createIndex` again.

**0.2.2:** `createCollection` also passes capped `size`/`max`, `clusteredIndex`, and `validator` / `validationLevel` / `validationAction`.

Remaining mongosh-line work (do not block the archive): none.

### `killAgedSessions.js`

**Live: v0.2.3.** **Archive: v0.2.2.** Mongosh-only. Do not top-level-await. `--eval` Syntax and examples use `var`. Do not add IIFE parameters named `filter` / `age` / `batchSize` / `sortByAge` (a parameter hides the global). Keep the failure **throw**; `quit()` is not a reliable `mongosh --file` status. See the scripting guide. Header tags this file as requiring this roadmap.

### `rtt.js`

**Live: v0.3.3.** **Legacy archive line: v0.3.0** (mongosh-only; still the demarked snapshot for the whole-tree freeze — see [Legacy mongo shell retirement](#legacy-mongo-shell-retirement) §1). Do not top-level-await. TODOs stay TBA on the mongosh line.

**0.3.1:** the mongos child URI percent-encodes the driver username and password. Those values are plaintext. `@`, `:`, or `/` in the password no longer splits the URI. A null password is omitted rather than written as the word `null`.

**0.3.2:** when `config.mongos` has an advisory FQDN, the port is the last colon field of `_id`. That is `27017` for both `host:27017` and `[2001:db8::1]:27017`.

**0.3.3:** that port is `$last` of the `_id` split. On 4.4 this is the array operator, an alias of `$arrayElemAt` index `-1`.

### `sleepy.js`

**Live: v0.2.7.** **Archive: v0.2.6.** Mongosh-only (inline `console` polyfill dropped).

### `docSizes.js`

**Live: v0.1.36.** **Archive: v0.1.34.** Per-command RP on `$sample`. `--eval` `var options` overlays in-file `optionDefaults` (`dbName`, `collName`, `sampleSize`). Do not declare `options` in this file. Does not load mdblib.

**Shipped:** `--eval` `var options` overlay (no version bump).

**0.1.36:** a namespace the connected node does not list throws and stops. The old check printed the miss and then read `stats()`.

Remaining mongosh-line work (do not block the archive): none.

### `batchUpdater.js`

**Not in live `src/`.** Archive **v0.1.6** (strip briefly reached 0.1.7 on master then the file was removed). Invalid `$expr` / `endValue === null` stays archive-only.

### `oidGenerator.js` / `oidFunction.js`

**Legacy archive lines: v0.2.7 / v0.1.5.** OID generator and `$function` view reproduction (mongod 5.0+). Freeze as-is. Post-freeze feature work proceeds on the mongosh line only.

### `ctxDemo.js`

**Live sketch: v0.2.2.** **Archive: v0.1.0** at `legacy/mongo-shell/src/ctxDemo.js` — that copy is the frozen sketch and still falls back to `isMaster()`. Do not edit the archive.

The live file continues the sketch on the mongosh line. Stand-in library, no `load('mdblib.js')`. `hello()` only (SERVER-49989; replies differ). Sibling databases show the lexical-`db` trap and `mdblib.for(db)`. A targeted context is a `directConnection` client to one `hello.hosts` member (the primary, then each other host), not `connect(parent URI)`. Each facade reads its own snapshot under `Promise.all`. `identity()`, `hello()`, `snapshot()`, and `scope()` await the driver client's `command()`. `snapshot()` stores the in-flight hello promise on a `WeakMap` before the await, so one hello per member can be in flight together. Shell `hello()` / `runCommand()` / `stats()` stay synchronous and do not overlap. Section 6 still awaits, and stores the resolved hello in one module-level slot. A module-level snapshot filled by the direct primary still returns that primary when asked for a secondary; a `WeakMap` keyed by `getMongo()` stores the secondary. `admin` on the primary client shares that snapshot, and `scope()` keeps `dbName`. A global `db` swap of those member handles collapses every reader onto the last member. Do not log the rebuilt URI. Each section prints the use case, the restriction, and the values to read. This file is a walkthrough, not a smoke test. A pass/fail check waits until `mdblib.for()` exists and can be loaded. Do not land `for(db)` in `mdblib.js` from this sketch. See the scripting guide. Header tags this file as requiring this roadmap.

### `modifiedCountDocumentsByKey.js`

**Legacy archive line: v0.1.7** (mongosh-only). `countDocuments` prototype overload. Freeze as-is.

### `pcg-xsh-rr.js` / `aggregation-template.js` / `misc-scripts.js`

**Legacy archive line: as-is** (no `Version` field). Helpers and snippets. Freeze as-is; do not invent version numbers for the tag.

---

## See also

- [DB Storage tools](DB%20Storage%20tools.md) — mongosh-only dbstats report, compaction helper, autoCompact / onlineDefrag / indexCacheUtil
- [mongosh scripting guide](mongosh-scripting-guide.md)
- [`autoCompact` command](https://www.mongodb.com/docs/manual/reference/command/autocompact/)
- [`compact` command](https://www.mongodb.com/docs/manual/reference/command/compact/)
- [Unsupported commands in Atlas](https://www.mongodb.com/docs/atlas/unsupported-commands/) — M0/Flex deny `autoCompact` and `compact`; limited `serverStatus` / `dbStats`
