# mongosh scripting guide

Practical quirks and patterns for writing scripts that run under [`mongosh`](https://www.mongodb.com/docs/mongodb-shell/) against replica sets, Atlas, and sharded clusters. This is not a full mongosh manual. It captures behaviours that repeatedly bite long-running or topology-aware scripts in this repository (for example `src/niceDeleteMany.js`, `src/congestionMonitor.js`, `src/discovery.js`, `src/mdblib.js`, `src/fuzzer.js`, `src/autoCompact.js`, `src/dbstats.js`).

Where a point is specific to one workflow, the surrounding prose names that workflow instead of using opaque project jargon.

---

## Read preference

### Prefer per-command options

For routing a **single** read, pass `readPreference` in the command or helper options rather than relying only on connection-wide settings:

```javascript
// hello / generic commands (mongosh 2.0+)
db.runCommand({ hello: 1 }, { readPreference: 'secondaryPreferred' });
// or with tags:
db.runCommand(
  { hello: 1 },
  { readPreference: { mode: 'secondaryPreferred', tags: [{ diskState: 'READY' }, {}] } }
);

// aggregation / explain
collection.aggregate(pipeline, { readPreference: { mode: 'secondaryPreferred', tags: [...] } });
collection.explain('queryPlanner').aggregate(pipeline, { readPreference: { mode: 'secondaryPreferred' } });

// find — same per-command RP in the options document (mongosh find(query, projection, options)).
// Also apply cursor.readPref(mode, tags) so a later .sort()/.hint() cannot drop it.
collection.find(filter, { _id: 1 }, { readPreference: { mode: 'secondaryPreferred', tags: [...] } });
// Unknown FindOptions such as readOnce are stripped — see “readOnce and _runCursorCommand”.
```

Background: [Read preference](https://www.mongodb.com/docs/manual/core/read-preference/), [`db.runCommand()`](https://www.mongodb.com/docs/manual/reference/method/db.runcommand/), [`Mongo.setReadPref()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/), [`cursor.readPref()`](https://www.mongodb.com/docs/manual/reference/method/cursor.readpref/).

### `runCommand` ignores connection-level read preference (mongosh 2.0+)

Starting in **mongosh 2.0**, `db.runCommand()` **ignores** global read preference from the connection string and from `Mongo.setReadPref()`. If you omit options, it defaults to **primary**. You must pass `options.readPreference` on the call.

Documented under [Interaction with `db.runCommand()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/#interaction-with-db-runcommand--) and the [`db.runCommand()` options](https://www.mongodb.com/docs/manual/reference/method/db.runcommand/).

Implication: a script that only calls `db.getMongo().setReadPref('secondaryPreferred')` and then `db.runCommand({ hello: 1 })` will still land on the **primary**. Helpers such as `db.hello()` may still follow connection RP — do not assume `runCommand` and `db.hello()` behave the same.

### `RunCommandCursor` read preference

`db.runCommand(..., { readPreference: { mode, tags } })` accepts a **document**. mongosh `database._runCursorCommand` builds a Node [`RunCommandCursor`](https://mongodb.github.io/node-mongodb-native/6.3/classes/RunCommandCursor.html), which stores `options.readPreference` only when the value is a driver **`ReadPreference` instance**. A `{ mode, tags }` document is ignored and the cursor defaults to **primary**, so `secondaryPreferred` and Atlas tags never take effect.

```javascript
const ReadPreference = db.getMongo()._serviceProvider.mongoClient.db(dbName).readPreference.constructor;
const rp = ReadPreference.fromOptions({
  readPreference: { mode: 'secondaryPreferred', tags: [{ diskState: 'READY' }, {}] }
});
database._runCursorCommand(findCmd, { readPreference: rp });
```

FindCursor / AggregationCursor still use `cursor.readPref(mode, tags)`. RunCommandCursor has no `readPref()`. Sending find-command flags the `find()` helper strips is covered under [`readOnce` and `_runCursorCommand`](#readonce-and-_runcursorcommand).

### `Mongo.setReadPref()` reconnects the client

Calling [`Mongo.setReadPref()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/) updates connection options. In practice mongosh applies that via a connection reset (`resetConnectionOptions`), which **closes checked-out connections**. If an aggregation cursor or other operation is in flight, you can see:

```text
MongoClientClosedError: Operation interrupted because client was closed
```

So even when connection RP is useful for find/aggregate helpers, **do not flip `setReadPref` while cursors or concurrent samples are running**. Prefer per-command RP for mixed workloads (secondary reads + primary `adminCommand` vitals in the same process).

### `adminCommand` always targets the primary

Commands issued through [`db.adminCommand()`](https://www.mongodb.com/docs/manual/reference/method/db.admincommand/) are admin-scoped and, in mongosh usage for things like `serverStatus` / `getParameter`, effectively always hit a **writable primary**. Do not use `adminCommand` when you need to discover or verify which secondary a secondaryPreferred read would select. Use `db.runCommand(..., { readPreference })` on a user database (or an equivalent non-admin path) instead.

### `hello` is one-shot

`db.hello()` and `db.adminCommand({ hello: 1 })` are a one-shot topology probe. Do **not** pass `topologyVersion` or `maxAwaitTimeMS`. That is [awaitable hello](https://www.mongodb.com/docs/manual/reference/command/hello/#awaitable-hello): the command blocks until the topology changes or `heartbeatFrequencyMS` (often 10 seconds) on a quiet node. `mdblib.js` `hello()` never sends those fields.

Send `hello`. Do not wrap `isMaster`. The replies differ (`isWritablePrimary` vs `ismaster`) — [SERVER-49989](https://jira.mongodb.org/browse/SERVER-49989). `hello` exists on mongod 4.2+ and this repo’s server floor is 4.4, so there is no `isMaster` fallback. `ctxDemo.js` still falls back; do not copy that.

The parent session string is `db.getMongo().getURI()`. `mongo._uri` is private and can lag the session. Shard child URIs are rebuilt from `getURI()` — see [Child `mongodb://` URIs](#child-mongodb-uris-to-shard-primaries).

### Sessions vs connection vs command

[`Mongo.startSession()`](https://www.mongodb.com/docs/manual/reference/method/mongo.startsession/) accepts `readPreference` in [session options](https://www.mongodb.com/docs/manual/reference/method/sessionoptions/). That is appropriate for:

- multi-document transactions (which require read preference **primary** — see [Transactions and read preference](https://www.mongodb.com/docs/manual/core/transactions/#read-preference)),
- write-heavy session work,
- residual validation that must use majority read concern on primary.

It is **not** a complete substitute for secondary-targeted aggregation or `runCommand` landing checks. Also: a single session must not be used concurrently; operations on one session run sequentially ([`Mongo.startSession()`](https://www.mongodb.com/docs/manual/reference/method/mongo.startsession/)).

**Example (bucketed delete scripts):** secondaryPreferred + Atlas tags belong on the **read path** that builds `_id` batches (`hello` / `explain` / `aggregate` options, and `_runCursorCommand` with a driver `ReadPreference` instance). Deletes and majority residual counts stay on **primary-oriented sessions**. Do not assume one session RP covers both.

---

## Sessions, cursors, and long-running reads

MongoDB associates most operations with a [server session](https://www.mongodb.com/docs/manual/reference/server-sessions/). Idle sessions expire (commonly on the order of **30 minutes**). When the server closes the session it can kill in-progress operations and open cursors — see [`cursor.noCursorTimeout()`](https://www.mongodb.com/docs/manual/reference/method/cursor.nocursortimeout/) (session idle timeout overrides `noCursorTimeout`).

Practical lessons:

- Running `explain` on a **DriverSession** and then expecting a long aggregation on the same session to survive can fail with session-expiry errors (`MongoExpiredSessionError` in the driver/mongosh stack). For long batching pipelines, prefer connection-scoped collection helpers for explain + aggregate, or manage explicit session refresh if you must use a session ([`refreshSessions`](https://www.mongodb.com/docs/manual/reference/command/refreshSessions/)).
- If you open a cursor yourself, close it in `finally` (`cursor.close()`), ignoring “already closed” where appropriate.
- Do **not** `await` a mongosh cursor to “unwrap” it — see [Thenable cursors](#thenable-cursors-do-not-await-a-live-cursor).

### `readOnce` and `_runCursorCommand`

[`readOnce`](https://www.mongodb.com/docs/manual/reference/command/find/) is a **find-command** flag. It tells WiredTiger the scan is one-shot, so those pages need not stay in cache. The field is IDL **unstable / deprecated**. It exists on `find` only.

mongosh `collection.find(query, projection, options)` forwards **known FindOptions** only. Extra keys such as `readOnce` are dropped before the command is built — the helper succeeds and the profiler shows no `readOnce`. Confirm with `system.profile` / a `command.comment`.

`collection.aggregate(pipeline, { readOnce: true })` is the same silent drop. `runCommand({ aggregate, …, readOnce: true })` fails with **40415** `IDLUnknownField` because the aggregate command is strict and has no such field.

Public `db.runCursorCommand` is a Help object (`typeof` is `object`, not a function). mongosh’s path is `database._runCursorCommand(findCmd, options)`, which wraps the Node `RunCommandCursor`. That cursor **pins getMore** to the member that served `find`. `runCommand({ find })` followed by `runCommand({ getMore })` with `secondaryPreferred` selects a server per command and can miss the cursor owner (`CursorNotFound`).

Read preference on this cursor is a driver **instance** — see [`RunCommandCursor` read preference](#runcursorcommand-read-preference). Shell `RunCommandCursor.batchSize()` throws (`batchSize must be configured on the command document directly, to configure getMore.batchSize use cursor.setBatchSize()`). `find.batchSize` is **firstBatch**; later getMore size is `cursor._cursor.setBatchSize(n)`.

`_runCursorCommand` is a plain `async` method (the rewriter does not unwrap it), so the first value is `Promise<RunCommandCursor>`. Unwrap only while there is no `.close`, then stream — see [Thenable cursors](#thenable-cursors-do-not-await-a-live-cursor). Keep the cursor connection-scoped (implicit session); a DriverSession can expire under a long walk.

Hit in `niceDeleteMany.js` on the hinted `_id` scan walk (`getIdsByIdIndexScan`). Window `$setWindowFields` stays on `aggregate()`. Residual `countIds` stays on aggregate without `readOnce`.

```javascript
const database = db.getSiblingDB(dbName);
const ReadPreference = db.getMongo()._serviceProvider.mongoClient.db(dbName).readPreference.constructor;
const findCmd = {
  find: collName,
  filter,
  projection: { _id: 1 },
  sort: { _id: 1 },
  hint: { _id: 1 },
  batchSize: 100,          // firstBatch
  maxTimeMS: 0,
  noCursorTimeout: true,
  readOnce: true,
  comment: 'one-shot _id walk'
};
let cursor = database._runCursorCommand(findCmd, {
  readPreference: ReadPreference.fromOptions({ readPreference: cmdRP })
});
if (cursor && typeof cursor.then === 'function' && typeof cursor.close !== 'function') {
  cursor = await cursor;
}
if (typeof cursor._cursor?.setBatchSize === 'function') {
  cursor._cursor.setBatchSize(100); // getMore.batchSize
}
try {
  for await (const doc of cursor) { /* stream */ }
} finally {
  try { await cursor.close(); } catch (_) { /* already closed */ }
}
```

---

## Async JavaScript in mongosh

### Constructors and other forbidden contexts

mongosh cannot pass database query results through several JavaScript contexts. Official guidance: [Script considerations](https://www.mongodb.com/docs/mongodb-shell/write-scripts/considerations/).

In particular, **class constructors** must not synchronously call the database. This fails:

```javascript
class FindResults {
  constructor() {
    this.value = db.students.find(); // fails
  }
}
```

Documented alternatives:

- wrap the DB call in an async IIFE assigned in the constructor, or
- use a sync constructor plus an `init()` method that performs the DB work after `new`.

`mdblib.js` follows the same idea: avoid awaiting topology probes inside constructors (commented patterns around `MetaStats`), and prefer init/lazy evaluation.

Also called out in that doc: non-async generator functions, `.sort()` callbacks that hit the DB, and class setters.

### Top-level `async` and sync shell APIs

mongosh does **not** run `--file` / `--eval` as a plain Node script. [`@mongosh/async-rewriter2`](https://www.npmjs.com/package/@mongosh/async-rewriter2) wraps the source in an IIFE and inserts implicit `await` around **shell-API** promises (so `db.collection.find().toArray()` can look synchronous). Consequences:

- `node --check script.js` can pass while `mongosh --file script.js` throws `SyntaxError`. Always parse-check with mongosh (`mongosh --nodb --file script.js`).
- Real top-level `await` is **not** available in `--file`, `--eval`, or a piped REPL snippet (verified mongosh 2.10). `await main()` at the true top of a file fails with `'await' is only allowed within async functions…`.
- **Do not** write `await (async () => { … })();` as the entrypoint. The rewriter turns `await (callee)()` into a maybe-awaited call and the result is:

```text
SyntaxError: Unexpected token ','
```

Same error from `--eval 'await (async () => { … })()'` and from typing that in the REPL (`autoCompact.js`).

**Do** drive the script with an async IIFE and `await` *inside* it. Do not `await` the IIFE itself:

```javascript
(async () => {
  await main();
})();
```

Same pattern in `fuzzer.js`, `discovery.js`, `autoCompact.js`, `niceDeleteMany.js`. Inner `await` and `for await` are fine. `--file` keeps the process alive until pending promises settle, so you do not need a top-level `await` on the IIFE to prevent early exit.

User-defined `async function`s are **not** implicitly awaited — only marked shell-API methods are. If the script would return while work is still in flight, hold the Promise (see the resharding wait in `fuzzer.js`).

Many shell helpers such as `db.adminCommand()` are **synchronous** in mongosh. Writing `await db.adminCommand(...)` does not schedule I/O by itself. If you need a thenable for in-flight coalescing (one shared `serverStatus` for concurrent callers), wrap explicitly:

```javascript
inflight = Promise.resolve().then(() => db.adminCommand({ serverStatus: 1, /* … */ }));
```

### Read the field after the call resolves

The rewriter inserts `await` around the **shell call**. A property on that same expression is read on the Promise, and the field is `undefined`:

```javascript
// WRONG — deletedCount is always undefined
const n = await coll.deleteMany(filter, opts).deletedCount;

// RIGHT — resolve the write result, then read the field
const n = (await coll.deleteMany(filter, opts)).deletedCount;
```

Same shape for `insertMany`, `updateMany`, `bulkWrite`, and any other shell helper that returns a result document. Assign the result, then read the field. `niceDeleteMany.js` `deleteManyTask` still uses the unparenthesized form.

Without your own `await`, a rewriter-unwrapped call already is the result, so `const result = coll.insertMany(docs, opts); result.insertedIds` is fine. The trap is `await helper(...).field`.

### Shell `toArray()` is not a Promise you can overlap

On a mongosh cursor, `cursor.toArray()` is rewriter-unwrapped to an **array**. It looks synchronous and it **serialises** a pool: each call runs to completion before the next worker continues. `Promise.all` of shell `toArray()` does not overlap getMores.

The Node driver cursor’s `cursor._cursor.toArray()` is a **native Promise**. That is what `mdblib.js` `$collStats` awaits so `mapPool` can overlap one-document drains. Unwrap a bare `Promise<cursor>` first (no `.close`), then call the driver method:

```javascript
let cursor = namespace.aggregate(pipeline, opts);
if (cursor && typeof cursor.then === 'function' && typeof cursor.close !== 'function') {
  cursor = await cursor;
}
const driverToArray = cursor && cursor._cursor && cursor._cursor.toArray;
let docs = (typeof driverToArray === 'function')
  ? driverToArray.call(cursor._cursor)
  : cursor.toArray();
if (docs && typeof docs.then === 'function') docs = await docs;
```

A single sequential `aggregate(...).toArray()[0]` (`onlineDefrag.js` packed-temp WT) is fine. A thread pool (`indexCacheUtil.js`, when it lands) must use the driver Promise.

### Sync shell calls do not overlap by themselves

`db.adminCommand()`, `db.stats()`, and most helpers run to completion on the current turn. `Promise.all` of those calls still runs them one after another. `mapPool` in `mdblib.js` `await Promise.resolve()` before and after each item so other workers start and a HUD can paint **between** sync commands. Overlap of real I/O still requires a native Promise (driver `toArray`, or `Promise.resolve().then(() => adminCommand(...))` only coalesces — it does not make one `adminCommand` async).

### `finally` takes a function

`Promise.prototype.finally` **calls** whatever you pass when you build the chain. A shell or stdout call in that slot runs immediately:

```javascript
// WRONG — write() runs now; finally receives its return value
p.finally(process.stdout.write('\x1b[?1049l'));

// RIGHT
p.finally(() => { process.stdout.write('\x1b[?1049l'); });
```

`congestionMonitor.js` still passes `process.stdout.write(...)` directly. That teardown does not wait for the monitor.

### Thenable cursors: do not `await` a live cursor

mongosh [`FindCursor`](https://www.mongodb.com/docs/manual/reference/method/js-cursor/) **and** aggregation cursors are **thenable** so the REPL can treat `await db.coll.find()` / `await db.coll.aggregate(…)` as “give me the documents.” `Cursor.prototype.then` consumes the cursor (typically via [`toArray()`](https://www.mongodb.com/docs/manual/reference/method/cursor.toArray/)). That is **not** “wait until the cursor object exists.”

This is the same trap for **`find` and `aggregate`**. Both collection methods are rewriter-awaited; both return a thenable cursor.

```javascript
// WRONG — Cursor has .then, so this drains the whole result (breaks streaming)
let cursor = collection.find(filter, { _id: 1 });
if (typeof cursor.then === 'function') cursor = await cursor;
// equally wrong:
cursor = await collection.aggregate(pipeline, opts);

// RIGHT — unwrap only a bare Promise (no cursor methods). Leave a live cursor alone.
let cursor = collection.find(filter, { _id: 1 }, findOpts);
// or: collection.aggregate(pipeline, opts)
if (cursor && typeof cursor.then === 'function' && typeof cursor.close !== 'function') {
  cursor = await cursor;
}
for await (const doc of cursor) { /* stream */ }
// aggregate: yield* cursor;  — do not await first
```

Discriminate with a method **both** cursor types have, such as `.close` or `Symbol.asyncIterator`, not `.then`. Do **not** use `.sort`: that exists on `find` cursors only; an aggregation cursor has `.then` and **no** `.sort`, so a `.sort` check would treat a live agg cursor as a Promise and drain it.

A `Promise` has `.then` and no `.close`; a mongosh find, aggregation, or `RunCommandCursor` has both.

In `--file` scripts the [async rewriter](https://www.npmjs.com/package/@mongosh/async-rewriter2) already inserts implicit `await` around marked **shell-API** methods (`find`, `aggregate`, …). You usually receive a **cursor object**, not `Promise<Cursor>`. `Database._runCursorCommand` is a plain `async` method (not rewriter-marked), so the first value **is** `Promise<RunCommandCursor>` — unwrap that Promise, then stream. Do not `await` a live cursor.

Hit in `niceDeleteMany.js`: window `aggregate()` and the `_runCursorCommand` `_id` walk both unwrap only a bare Promise (no `.close`), then stream (`yield*` / `for await`). `await` on the live cursor would materialise every matching `_id` instead of yielding 100-id buckets.

The object you hold is the **mongosh cursor**, not the server cursor. It wraps a Node driver cursor (`_cursor`). `for await` / `yield*` on the shell object uses `Symbol.asyncIterator`, which (unless `.map()` is set) **delegates to the driver iterator**. `close()` is `await this._cursor.close()` (killCursors on the server when the id is still live).

That wrapper **buffers and reports its own state**:

- **Driver buffer** — `objsLeftInBatch()` is `bufferedCount()` from the last getMore, not “how many the server still has.”
- **REPL print batch** — inspecting a cursor in the shell runs `_it()` with `_displayBatchSize()` (often ~20). That path is **not** used by `for await` / `yield*` / `next()`.
- **`isClosed()`** — the driver `closed` flag, not a separate shell flag. The driver async iterator also `close()`s in its `finally` when the loop ends or breaks; a generator `finally { cursor.close() }` is then a second close on an already-closed wrapper (ignore “already closed”).

So generators should keep **one** shell cursor, iterate it, and `close()` it. They cannot read the real server cursor id or remaining count through mongosh. Wire `batchSize` on `find` / `aggregate` still controls getMore size on the driver/server side. On `RunCommandCursor`, `find.batchSize` is firstBatch only; getMore size is `cursor._cursor.setBatchSize(n)` — see [`readOnce` and `_runCursorCommand`](#readonce-and-_runcursorcommand).

### Blocking `sleep()` vs `await` delays

[`sleep(ms)`](https://www.mongodb.com/docs/mongodb-shell/reference/native-methods/) is a mongosh helper that **blocks** the JavaScript thread. That is fine for a simple poll loop (`congestionMonitor.js`). It is not fine if other promises must run during the wait (background `$listCatalog` cursor in `autoCompact.js`). Use `await new Promise(resolve => setTimeout(resolve, ms))` (or equivalent) so the event loop can continue.

### Passing options with `--eval`

Scripts that take a user document (`autoCompactOptions`, `options`) must **not** declare that binding in the file. `--eval` runs first; `--file` then sees it as a global. Probe with `typeof autoCompactOptions === 'undefined'` and merge. Prefer `var` in `--eval` so a second `load()` or re-run does not hit `let`/`const` redeclaration (mongosh sloppy mode). On mongosh 2.10, `let` / `const` in `--eval` also leak into `--file`, but `var` remains the least surprising.

```javascript
// CLI: mongosh --eval 'var autoCompactOptions = { runOnce: false };' -f autoCompact.js
const userOptions = typeof autoCompactOptions === 'undefined' ? {} : autoCompactOptions;
```

An async IIFE **parameter** of the same name is also a shadow. `(async (options) => { … })()` binds `options` to `undefined` and hides the `--eval` global. Probe the global inside an IIFE that takes no parameters (`killAgedSessions.js`, `onlineDefrag.js`). `dbstats.js` leaves `(async (db, options) => …)` commented for this reason.

`--eval` examples must use `var`. On mongosh 2.10, `let` / `const` in `--eval` also leak into `--file`, and a second run then redeclares. `killAgedSessions.js` examples still show `let`.

### JSONC options file

`fuzzer.js` (v0.15.0) overlays in-file defaults from `fuzzer-options.jsonc`. That file is the reference until a shared resolver exists. Do not paste the parser into every script.

- Search a relative name in this order: the options file’s own directory, the working directory, `__dirname` (set for `--file`), `$MDBLIB`, `~/.mongodb`. An absolute path is used as given. A missing file is not an error.
- Strip JSONC in-process (BOM, `//` and `/* */` outside strings, trailing commas) and `JSON.parse`. Do not `require('jsonc-require')` for options. That module is a separate resolve (`explainHisto.js` still needs it for an operator `pipeline.jsonc`).
- Deep-merge plain objects. Arrays and scalars replace.
- JSON has no RegExp. Defaults that are regexes (`dbstats.js` `filter.db` / `filter.collection`) need an explicit string revive. A regex literal does not belong in the file.
- `--eval` stays a thin `var` override and must still not be declared in the file. Fuzzer’s `--eval` overlay is unwired; the JSONC file is the overlay.

### Version strings

`version()` and `db.version()` are strings. `Number("2.10")` and `+"2.10"` are `2.1`. Compare integer `major.minor.patch`. `mdblib.js` `shellVer` / `serverVer` do that (`2.10` ≠ `2.1`). A major-only `parseInt` (`autoCompact.js` binary ≥ 8) is a different check and is fine for that gate.

### Process status

`mongosh --file` does not reliably surface `quit(n)` or the process status byte. Signal a hard failure by **throwing** (`killAgedSessions.js`). Cron and wrappers should read the exception, not depend on the exit code.

---

## Connection lifecycle and “libraries”

- Driver apps call `MongoClient.close()`. In mongosh the **shell owns** the connection; there is no reliable script-level `db.close()` that means “tear down this script’s client and leave the shell.” Tear down **cursors**, **sessions**, and your own background loops/flags instead.
- Sharing code with `load('helper.js')` reuses the same **`db` global**. That makes a shared “congestion library” attractive but multi-context awkward (which `db`? which read preference?). Until a clearer module story exists, duplication or carefully namespaced helpers is often safer than a hidden global singleton.
- `require()` / `module.exports` initialise in a **different** context. The shell `db` global is not there. `mdblib.js` leaves `module.exports` commented. Helpers that touch `db` use `load()`. `require` of a pure parser (`jsonc-require`, a pipeline file) does not need `db`.

### `--file` vs `load()`

`process.argv` lists the script passed as `-f` / `--file` / a positional `*.js`. `load('other.js')` does not change that list. `dbstats.js` treats “argv names `dbstats.js`” as the interactive CLI. Any other entry (`load()`, or another `--file` that loads it) is module mode: no banner, and the async IIFE returns the JSON contract.

```javascript
const report = await load('dbstats.js');
```

`await` the `load()`. The file’s async IIFE is user code; the rewriter does not await it for the caller. The IIFE’s return value is the contract (`return dbStats` at the bottom of `dbstats.js`).

Loader IIFEs in `autoCompact.js`, `onlineDefrag.js`, `fuzzer.js`, and `oplogchurn.js` still print a banner when the file is `load()`ed. Gate them with the same argv test before a fan-out `load()`s them. `onlineDefrag.js` does not `load()` dbstats; a snapshot belongs on `await load('dbstats.js')`, not a scraped table.

---

## Output, TTY, and ANSI

- Detect an interactive terminal with `process.stdout.isTTY` (allow `--eval` overrides for forced interactive / log mode).
- Piped or CI runs: strip CSI colour sequences (e.g. `\x1b[…m`), avoid `console.clear()`, prefer append-only status lines. `mdblib.js` overloads `console.log` to expand markup tags on TTY and strip escapes otherwise.
- In JavaScript source strings, `\xNN` is a **single Latin-1** code unit (0–255). Unicode block elements (`░`, `▓`) need a literal character or `\uXXXX` / `\u{…}`. A UTF-8 byte sequence written as `\xe2\x96\x91` is **three** characters, not one `░`.
- A one-line progress HUD is `process.stdout.write('\r' + line + '\x1b[K')`. `console.log` always advances a line, and `mdblib.js`’s `console.log` overload also rewrites markup. `MiniHud` (`mdblib.js`) writes that `\r` line, no-ops when stdout is not a TTY or the mode is json/html, and `clear()`s before the report. `autoCompact.js`’s planned catalog bar should use `MiniHud`, not a second painter.

---

## Write results and index builds

`collection.createIndexes(keys, options)` resolves to the **index names** (an array). A failure **throws**. It does not return `{ ok: 1 }`. `fuzzer.js` prints those names.

`Bulk.execute(writeConcern)` **ignores** that argument. Put `writeConcern` on `insertMany(docs, { ordered: false, writeConcern })`. Do not bring `Bulk.execute(writeConcern)` back.

`insertMany`’s `insertedIds` is an **object** (index → id), not a count and not an array. A thrown bulk error may still carry a partial `insertedIds`, sometimes nested on `.result`. Count with `Object.keys`. `schema-import.js` will hit both of these when the create path is implemented.

`db.stats(scale)` as a bare number misses `freeStorage` on some shells. mongosh 1.2+ together with mongod 5.0.6+ want a document `{ freeStorage: 1, scale: 1 }` ([MONGOSH-1108](https://jira.mongodb.org/browse/MONGOSH-1108), [SERVER-62277](https://jira.mongodb.org/browse/SERVER-62277); scale `1` keeps byte precision, [SERVER-69036](https://jira.mongodb.org/browse/SERVER-69036)). `$stats` in `mdblib.js` passes the document only when `serverVer('5.0.6') && shellVer(1.2)`.

---

## Explain plans (aggregation)

[`explain`](https://www.mongodb.com/docs/manual/reference/explain-results/) output for aggregations can include the **command pipeline** as submitted. A naive walk of the whole document looking for `$sort` will treat the echoed pipeline stage as a “blocking sort” even when the winning plan is index-ordered.

Safer approach for “is this plan a collection scan / blocking sort?” checks:

- Walk **`queryPlanner.winningPlan`** (and shard-local winning plans / `$cursor.queryPlanner.winningPlan`).
- Treat classic stages such as `COLLSCAN`, `SORT`, `SORT_KEY_GENERATOR` as signals.
- Only treat a top-level aggregation `$sort` stage as blocking when it looks like an explain stage (for example includes `sortPattern`), not a bare sort-key document echoed from the command.

Used by scripts that choose an index-friendly sort key for windowed / ordered batching (e.g. deriving sort from the filter, falling back to `{ _id: 1 }` when the plan is unsafe).

---

## Sharded clusters and direct-to-shard commands

### Prefer `mongos` for application data

Clients should connect via [`mongos`](https://www.mongodb.com/docs/manual/sharding/) for ordinary reads and writes on user collections. Connecting to a single shard for application CRUD is unsupported as a general pattern ([Sharding](https://www.mongodb.com/docs/manual/sharding/)).

### MongoDB 8.0+ allowlist on shard nodes

Starting in **MongoDB 8.0**, only a documented allowlist of commands may run when you connect **directly to a shard node**. Attempting unsupported commands returns an error directing you to use a router (`mongos`). See:

- [Sharded node direct commands](https://www.mongodb.com/docs/manual/reference/supported-shard-direct-commands/)
- Overview note in [Sharding](https://www.mongodb.com/docs/manual/sharding/) (8.0 improper direct shard connection)

**Allowlisted examples relevant to ops scripts:** `serverStatus`, `hello`, `hostInfo`, `getParameter`, `replSetGetStatus`, session helpers, etc.

**Not a substitute for app data paths:** user-collection `aggregate` / `delete` / general CRUD are **not** the intended direct-shard model on 8.0+; keep batch reads and deletes on **mongos**.

Limited exceptions exist for reads/aggregations on certain `admin` / `local` / `config` collections (with further config collections that **must** go through `mongos` — listed on the same page).

### Dual-path design for shell tooling

When a script needs **WiredTiger / replica-set vitals** on shards but must delete or scan **user data**:

1. **Data plane** → always via `mongos` (or a replica set primary for non-sharded).
2. **Vitals plane** → optional direct connections to shard members using **allowlisted** commands only; probe reachability first.
3. **Fallback** → if Atlas networking (for example VPC peering) blocks shard hosts, or auth fails, degrade to mongos-only behaviour (for example time-based pacing when `serverStatus.wiredTiger` is missing).

Used by bucketed delete scripts that sample collection-owning shard primaries for WT admission (`listShards` + child `Mongo()`), and by `discovery.js` for directed topology commands.

### Child `mongodb://` URIs to shard primaries

`mongos` has no process-wide WiredTiger cache. `$collStats` through the router is per-table, not shard-process dirty/triggers. `rs.status()` on a mongos session is the **config replica set**, not shard lag.

To sample a shard primary from a router session:

1. Resolve owners (`collStats.shards`, else `config.chunks`, else the database primary). Map ids through `listShards` — `host` is `setName/h1:27017,h2:27017` or a standalone `host:port`.
2. Rebuild a **legacy `mongodb://` child URI**. Take the parent from `db.getMongo().getURI()`. Rewrite `mongodb+srv:` → `mongodb:` so `URL()` accepts it. WHATWG `URL` rejects comma-separated hosts: parse userinfo/query via the first host; keep the full seed list from the authority for labels. Child hosts come from topology (`listShards`), not a second SRV lookup. Do not read `mongo._uri`. `niceDeleteMany.js` and `congestionMonitor.js` copy `decomposeParentUri` / `formatLegacyMongoUri` / `parseReplSetHosts` inside each IIFE (do not `load()` `discovery.js`).
3. Copy parent username/password and query params (`authSource`, `tlsCAFile`, …). Re-encode userinfo (decode then `encodeURIComponent`; `URL()` userinfo form varies by Node). Drop `srvMaxHosts` / `srvServiceName` / `srvQueryTimeoutMS`. Drop `loadBalanced` (incompatible with `replicaSet` and `directConnection`). If the parent was SRV and `tls`/`ssl` are absent, set `tls=true`.
4. Replica-set shards: `replicaSet=<setName>`, `directConnection=false`, `readPreference=primary`. Standalone shards: `directConnection=true`, `readPreference=primary`. Vitals children also set `maxPoolSize=2` and 5s `serverSelectionTimeoutMS` / `connectTimeoutMS` / `socketTimeoutMS` so Atlas-unreachable fails fast.
5. Open with `new Mongo(uri)` (or `connect(uri)`), run allowlisted commands on that handle, close the child in `finally`. Do **not** `Mongo.setReadPref` (reconnects the client).
6. Shard lag is `admin.runCommand({ replSetGetStatus: 1 })` on the **child**. Do not use the parent `rs` helper.

Do not log the rebuilt URI (credentials). If any required shard is unreachable, keep mongos-only fallback rather than half-metrics from `shardingStatistics`.

```javascript
// Parent may be mongodb+srv://user:pass@cluster.mongodb.net/?authSource=admin
// listShards host: "shard0/s0a:27017,s0b:27017"
const child = new Mongo(
  'mongodb://user:pass@s0a:27017,s0b:27017/?replicaSet=shard0&readPreference=primary&directConnection=false&tls=true&authSource=admin'
);
const admin = child.getDB('admin');
const ss = admin.runCommand({ serverStatus: 1 }, { readPreference: { mode: 'primary' } });
const rsSt = admin.runCommand({ replSetGetStatus: 1 }, { readPreference: { mode: 'primary' } });
child.close();
```

---

## Atlas / shared tiers

- Flex / M0-style tiers may omit large parts of `serverStatus` (notably **WiredTiger** cache metrics). Treat missing metrics as **unknown**, not as “no pressure / run wide open.”
- Shared tiers often show **burst then stall** under load (platform rate limiting). For admission control without WT signals, a useful future input is **pool clear rate** (how fast in-flight tasks complete) rather than fixed sleep alone.

---

## Quick reference

| Do | Don’t |
|----|--------|
| Pass `readPreference` on `runCommand` / `aggregate` / `explain` / `find` | Assume `setReadPref` alone fixes `runCommand` (mongosh 2.0+) |
| Stream `find`/`aggregate`/`_runCursorCommand` with `for await` / `yield*` | `await cursor` because it is thenable (drains via `toArray`) |
| Put `readOnce` on `database._runCursorCommand({ find, readOnce: true })` with a driver `ReadPreference` instance + `_cursor.setBatchSize` | Pass `readOnce` on `collection.find()` / `aggregate()` (stripped) or on `runCommand({ aggregate })` (40415) |
| Pass `ReadPreference.fromOptions({ readPreference: cmdRP })` into `_runCursorCommand` | Pass a `{ mode, tags }` document into `_runCursorCommand` (cursor defaults to primary) |
| Pin find+getMore via `_runCursorCommand` | `runCommand({ find })` then `runCommand({ getMore })` under `secondaryPreferred` (cursor owner can change) |
| Keep connection RP stable while cursors run | Flip `setReadPref` under concurrent load |
| Use `runCommand` + RP to verify secondary targeting | Use `adminCommand` for secondary landing |
| Wrap sync `adminCommand` when you need a Promise | Assume `await adminCommand` is inherently async |
| Drive `--file` with `(async () => { await main(); })();` | `await (async () => { … })();` or top-level `await main()` (rewriter `SyntaxError`) |
| Parse-check with `mongosh --nodb --file` | Trust `node --check` alone |
| `await` a `setTimeout` Promise when other work must overlap | `sleep()` during concurrent promises (it blocks the thread) |
| `--eval 'var options = {…}'` and probe `typeof` in the file | Declare the same binding in the `--file` script |
| Follow [script considerations](https://www.mongodb.com/docs/mongodb-shell/write-scripts/considerations/) for classes/generators | Put DB calls in sync constructors |
| Route user data ops through `mongos` on 8.0+ | Plan general CRUD via direct shard connections |
| Rebuild child `mongodb://` from parent auth/TLS + `listShards` host | Re-expand `mongodb+srv` DNS for shard members |
| `replSetGetStatus` on the shard `Mongo()` handle | `rs.status()` on mongos (that is CSRS) |
| Gate coloured HUDs on TTY; strip ANSI in logs | Assume `console.clear` + colour is CI-safe |
| `(await coll.deleteMany(…)).deletedCount` | `await coll.deleteMany(…).deletedCount` (field on the Promise) |
| Overlap drains with `cursor._cursor.toArray()` | `Promise.all` of shell `cursor.toArray()` (rewriter returns an array; the pool serialises) |
| `await Promise.resolve()` between sync `adminCommand`s in a pool | Assume `Promise.all` of sync helpers overlaps I/O |
| `p.finally(() => process.stdout.write(…))` | `p.finally(process.stdout.write(…))` (the write runs immediately) |
| `db.adminCommand({ hello: 1 })` with no `maxAwaitTimeMS` | Awaitable hello (`topologyVersion` / `maxAwaitTimeMS`) on a quiet node |
| `db.getMongo().getURI()` for the parent string | `mongo._uri` (private; can lag) |
| Probe `--eval` globals inside an IIFE with **no** parameter of that name | `(async (options) => {})()` (parameter hides the global) |
| Overlay defaults from a JSONC file (fuzzer search path, deep-merge objects) | `require('jsonc-require')` for options, or a regex literal inside JSON |
| `await load('dbstats.js')` when argv does not name that file | Scrape the interactive report, or expect `load()` to be rewriter-awaited |
| `load()` for helpers that use `db` | `module.exports` (different context; `db` is missing) |
| Throw on hard failure | `quit(1)` and trust `mongosh --file` to surface the status |
| Integer `major.minor` compares (`2.10` ≠ `2.1`) | `Number(version())` / unary `+` on `"2.10"` |
| `createIndexes` → names, or catch the throw | Treat the return value as `{ ok: 1 }` |
| `insertMany(docs, { writeConcern })`; count `Object.keys(insertedIds)` | `Bulk.execute(writeConcern)` (argument ignored) |
| `process.stdout.write('\r' + line)` via `MiniHud` | `console.log` for a progress bar |
| `{ freeStorage: 1, scale: 1 }` on `db.stats` when the shell and server are new enough | `db.stats(1)` when you need `freeStorage` |

---

## See also

- [mongosh write scripts](https://www.mongodb.com/docs/mongodb-shell/write-scripts/)
- [Script considerations (constructors, generators, …)](https://www.mongodb.com/docs/mongodb-shell/write-scripts/considerations/)
- [`@mongosh/async-rewriter2`](https://www.npmjs.com/package/@mongosh/async-rewriter2) (how `--file` / `--eval` are wrapped)
- [Cursor methods](https://www.mongodb.com/docs/manual/reference/method/js-cursor/) / [`cursor.toArray()`](https://www.mongodb.com/docs/manual/reference/method/cursor.toArray/)
- [`sleep()`](https://www.mongodb.com/docs/mongodb-shell/reference/native-methods/)
- [`db.runCommand()`](https://www.mongodb.com/docs/manual/reference/method/db.runcommand/)
- [`find` command](https://www.mongodb.com/docs/manual/reference/command/find/) (`readOnce`)
- [`Mongo.setReadPref()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/)
- [Read preference](https://www.mongodb.com/docs/manual/core/read-preference/)
- [`Mongo.startSession()`](https://www.mongodb.com/docs/manual/reference/method/mongo.startsession/) / [Session options](https://www.mongodb.com/docs/manual/reference/method/sessionoptions/)
- [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)
- [Sharded node direct commands](https://www.mongodb.com/docs/manual/reference/supported-shard-direct-commands/)
- [Sharding](https://www.mongodb.com/docs/manual/sharding/)
