# mongosh scripting guide

Practical quirks and patterns for writing scripts that run under [`mongosh`](https://www.mongodb.com/docs/mongodb-shell/) against replica sets, Atlas, and sharded clusters. This is not a full mongosh manual. It captures behaviours that repeatedly bite long-running or topology-aware scripts in this repository (for example `src/niceDeleteMany.js`, `src/congestionMonitor.js`, `src/discovery.js`, `src/mdblib.js`, `src/fuzzer.js`, `src/autoCompact.js`).

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
```

Background: [Read preference](https://www.mongodb.com/docs/manual/core/read-preference/), [`db.runCommand()`](https://www.mongodb.com/docs/manual/reference/method/db.runcommand/), [`Mongo.setReadPref()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/), [`cursor.readPref()`](https://www.mongodb.com/docs/manual/reference/method/cursor.readpref/).

### `runCommand` ignores connection-level read preference (mongosh 2.0+)

Starting in **mongosh 2.0**, `db.runCommand()` **ignores** global read preference from the connection string and from `Mongo.setReadPref()`. If you omit options, it defaults to **primary**. You must pass `options.readPreference` on the call.

Documented under [Interaction with `db.runCommand()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/#interaction-with-db-runcommand--) and the [`db.runCommand()` options](https://www.mongodb.com/docs/manual/reference/method/db.runcommand/).

Implication: a script that only calls `db.getMongo().setReadPref('secondaryPreferred')` and then `db.runCommand({ hello: 1 })` will still land on the **primary**. Helpers such as `db.hello()` may still follow connection RP — do not assume `runCommand` and `db.hello()` behave the same.

### `Mongo.setReadPref()` reconnects the client

Calling [`Mongo.setReadPref()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/) updates connection options. In practice mongosh applies that via a connection reset (`resetConnectionOptions`), which **closes checked-out connections**. If an aggregation cursor or other operation is in flight, you can see:

```text
MongoClientClosedError: Operation interrupted because client was closed
```

So even when connection RP is useful for find/aggregate helpers, **do not flip `setReadPref` while cursors or concurrent samples are running**. Prefer per-command RP for mixed workloads (secondary reads + primary `adminCommand` vitals in the same process).

### `adminCommand` always targets the primary

Commands issued through [`db.adminCommand()`](https://www.mongodb.com/docs/manual/reference/method/db.admincommand/) are admin-scoped and, in mongosh usage for things like `serverStatus` / `getParameter`, effectively always hit a **writable primary**. Do not use `adminCommand` when you need to discover or verify which secondary a secondaryPreferred read would select. Use `db.runCommand(..., { readPreference })` on a user database (or an equivalent non-admin path) instead.

### Sessions vs connection vs command

[`Mongo.startSession()`](https://www.mongodb.com/docs/manual/reference/method/mongo.startsession/) accepts `readPreference` in [session options](https://www.mongodb.com/docs/manual/reference/method/sessionoptions/). That is appropriate for:

- multi-document transactions (which require read preference **primary** — see [Transactions and read preference](https://www.mongodb.com/docs/manual/core/transactions/#read-preference)),
- write-heavy session work,
- residual validation that must use majority read concern on primary.

It is **not** a complete substitute for secondary-targeted aggregation or `runCommand` landing checks. Also: a single session must not be used concurrently; operations on one session run sequentially ([`Mongo.startSession()`](https://www.mongodb.com/docs/manual/reference/method/mongo.startsession/)).

**Example (bucketed delete scripts):** secondaryPreferred + Atlas tags belong on the **read path** that builds `_id` batches (`hello` / `explain` / `aggregate` options). Deletes and majority residual counts stay on **primary-oriented sessions**. Do not assume one session RP covers both.

---

## Sessions, cursors, and long-running reads

MongoDB associates most operations with a [server session](https://www.mongodb.com/docs/manual/reference/server-sessions/). Idle sessions expire (commonly on the order of **30 minutes**). When the server closes the session it can kill in-progress operations and open cursors — see [`cursor.noCursorTimeout()`](https://www.mongodb.com/docs/manual/reference/method/cursor.nocursortimeout/) (session idle timeout overrides `noCursorTimeout`).

Practical lessons:

- Running `explain` on a **DriverSession** and then expecting a long aggregation on the same session to survive can fail with session-expiry errors (`MongoExpiredSessionError` in the driver/mongosh stack). For long batching pipelines, prefer connection-scoped collection helpers for explain + aggregate, or manage explicit session refresh if you must use a session ([`refreshSessions`](https://www.mongodb.com/docs/manual/reference/command/refreshSessions/)).
- If you open a cursor yourself, close it in `finally` (`cursor.close()`), ignoring “already closed” where appropriate.
- Do **not** `await` a mongosh cursor to “unwrap” it — see [Thenable cursors](#thenable-cursors-do-not-await-a-live-cursor).

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

### Thenable cursors: do not `await` a live cursor

mongosh [`FindCursor`](https://www.mongodb.com/docs/manual/reference/method/js-cursor/) / aggregation cursors are **thenable** so the REPL can treat `await db.coll.find()` as “give me the documents.” `Cursor.prototype.then` consumes the cursor (typically via [`toArray()`](https://www.mongodb.com/docs/manual/reference/method/cursor.toArray/)). That is **not** “wait until the cursor object exists.”

```javascript
// WRONG — Cursor has .then, so this drains the whole result (breaks streaming)
let cursor = collection.find(filter, { _id: 1 });
if (typeof cursor.then === 'function') cursor = await cursor;

// RIGHT — unwrap only a bare Promise (no cursor methods). Leave a live cursor alone.
let cursor = collection.find(filter, { _id: 1 }, findOpts);
if (cursor && typeof cursor.then === 'function' && typeof cursor.sort !== 'function') {
  cursor = await cursor;
}
for await (const doc of cursor) { /* stream */ }
```

Discriminate with a **cursor method** such as `.sort`, not with `.then`. A `Promise` has `.then` and no `.sort`; a mongosh cursor has both.

In `--file` scripts the [async rewriter](https://www.npmjs.com/package/@mongosh/async-rewriter2) already inserts implicit `await` around marked **shell-API** methods (`find`, `aggregate`, …). You usually receive a **cursor object**, not `Promise<Cursor>`. Stream it with `for await` or `yield*`. Do not `await` it first.

Hit in `niceDeleteMany.js` on the hinted `_id` `find()` fallback: `typeof cursor.then === 'function'` was true for a live cursor, and `await cursor` would materialise every matching `_id` instead of yielding 100-id buckets.

### Blocking `sleep()` vs `await` delays

[`sleep(ms)`](https://www.mongodb.com/docs/mongodb-shell/reference/native-methods/) is a mongosh helper that **blocks** the JavaScript thread. That is fine for a simple poll loop (`congestionMonitor.js`). It is not fine if other promises must run during the wait (background `$listCatalog` cursor in `autoCompact.js`). Use `await new Promise(resolve => setTimeout(resolve, ms))` (or equivalent) so the event loop can continue.

### Passing options with `--eval`

Scripts that take a user document (`autoCompactOptions`, `options`) must **not** declare that binding in the file. `--eval` runs first; `--file` then sees it as a global. Probe with `typeof autoCompactOptions === 'undefined'` and merge. Prefer `var` in `--eval` so a second `load()` or re-run does not hit `let`/`const` redeclaration (mongosh sloppy mode). On mongosh 2.10, `let` / `const` in `--eval` also leak into `--file`, but `var` remains the least surprising.

```javascript
// CLI: mongosh --eval 'var autoCompactOptions = { runOnce: false };' -f autoCompact.js
const userOptions = typeof autoCompactOptions === 'undefined' ? {} : autoCompactOptions;
```

---

## Connection lifecycle and “libraries”

- Driver apps call `MongoClient.close()`. In mongosh the **shell owns** the connection; there is no reliable script-level `db.close()` that means “tear down this script’s client and leave the shell.” Tear down **cursors**, **sessions**, and your own background loops/flags instead.
- Sharing code with `load('helper.js')` reuses the same **`db` global**. That makes a shared “congestion library” attractive but multi-context awkward (which `db`? which read preference?). Until a clearer module story exists, duplication or carefully namespaced helpers is often safer than a hidden global singleton.

---

## Output, TTY, and ANSI

- Detect an interactive terminal with `process.stdout.isTTY` (allow `--eval` overrides for forced interactive / log mode).
- Piped or CI runs: strip CSI colour sequences (e.g. `\x1b[…m`), avoid `console.clear()`, prefer append-only status lines. `mdblib.js` overloads `console.log` to expand markup tags on TTY and strip escapes otherwise.
- In JavaScript source strings, `\xNN` is a **single Latin-1** code unit (0–255). Unicode block elements (`░`, `▓`) need a literal character or `\uXXXX` / `\u{…}`. A UTF-8 byte sequence written as `\xe2\x96\x91` is **three** characters, not one `░`.

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

---

## Atlas / shared tiers

- Flex / M0-style tiers may omit large parts of `serverStatus` (notably **WiredTiger** cache metrics). Treat missing metrics as **unknown**, not as “no pressure / run wide open.”
- Shared tiers often show **burst then stall** under load (platform rate limiting). For admission control without WT signals, a useful future input is **pool clear rate** (how fast in-flight tasks complete) rather than fixed sleep alone.

---

## Quick reference

| Do | Don’t |
|----|--------|
| Pass `readPreference` on `runCommand` / `aggregate` / `explain` / `find` | Assume `setReadPref` alone fixes `runCommand` (mongosh 2.0+) |
| Stream `find`/`aggregate` with `for await` / `yield*` | `await cursor` because it is thenable (drains via `toArray`) |
| Keep connection RP stable while cursors run | Flip `setReadPref` under concurrent load |
| Use `runCommand` + RP to verify secondary targeting | Use `adminCommand` for secondary landing |
| Wrap sync `adminCommand` when you need a Promise | Assume `await adminCommand` is inherently async |
| Drive `--file` with `(async () => { await main(); })();` | `await (async () => { … })();` or top-level `await main()` (rewriter `SyntaxError`) |
| Parse-check with `mongosh --nodb --file` | Trust `node --check` alone |
| `await` a `setTimeout` Promise when other work must overlap | `sleep()` during concurrent promises (it blocks the thread) |
| `--eval 'var options = {…}'` and probe `typeof` in the file | Declare the same binding in the `--file` script |
| Follow [script considerations](https://www.mongodb.com/docs/mongodb-shell/write-scripts/considerations/) for classes/generators | Put DB calls in sync constructors |
| Route user data ops through `mongos` on 8.0+ | Plan general CRUD via direct shard connections |
| Gate coloured HUDs on TTY; strip ANSI in logs | Assume `console.clear` + colour is CI-safe |

---

## See also

- [mongosh write scripts](https://www.mongodb.com/docs/mongodb-shell/write-scripts/)
- [Script considerations (constructors, generators, …)](https://www.mongodb.com/docs/mongodb-shell/write-scripts/considerations/)
- [`@mongosh/async-rewriter2`](https://www.npmjs.com/package/@mongosh/async-rewriter2) (how `--file` / `--eval` are wrapped)
- [Cursor methods](https://www.mongodb.com/docs/manual/reference/method/js-cursor/) / [`cursor.toArray()`](https://www.mongodb.com/docs/manual/reference/method/cursor.toArray/)
- [`sleep()`](https://www.mongodb.com/docs/mongodb-shell/reference/native-methods/)
- [`db.runCommand()`](https://www.mongodb.com/docs/manual/reference/method/db.runcommand/)
- [`Mongo.setReadPref()`](https://www.mongodb.com/docs/manual/reference/method/mongo.setreadpref/)
- [Read preference](https://www.mongodb.com/docs/manual/core/read-preference/)
- [`Mongo.startSession()`](https://www.mongodb.com/docs/manual/reference/method/mongo.startsession/) / [Session options](https://www.mongodb.com/docs/manual/reference/method/sessionoptions/)
- [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)
- [Sharded node direct commands](https://www.mongodb.com/docs/manual/reference/supported-shard-direct-commands/)
- [Sharding](https://www.mongodb.com/docs/manual/sharding/)
