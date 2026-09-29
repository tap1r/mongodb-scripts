# Howto: streaming sort

How to keep an ordered walk **streaming** (non-blocking) when you need a stable sort key for windowed or bucketed work — as used by `src/niceDeleteMany.js` to emit fixed-size `_id` buckets for concurrent deletes.

This is the documented evolution of the pipeline history (v1 → v2 → v3). `src/niceDeleteMany.js` is the reference implementation. v3 is two modes: an index-ordered aggregation, or a hinted `{_id:1}` `find()` with in-process buckets.

## Goal

1. `$match` a filter.
2. Walk matching documents in a **stable sort order**.
3. Derive fixed-size **buckets** of `_id`s (typically 100) and yield them so a client can prefetch and process concurrently.
4. Use an index-ordered `$match` + `$sort` when Policy A confirms **IXSCAN without a blocking SORT**. Otherwise walk a hinted `{_id:1}` `find()` with residual FETCH and in-process buckets. Window aggregation sets `allowDiskUse: false` so a leftover SORT fails closed.

Related MongoDB docs:

- [`$setWindowFields`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/) — `sortBy` uses the **same syntax as [`$sort`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/)**
- [`$sort` and indexes](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance) — index can provide order when `$sort` is first or only preceded by `$match`
- [Aggregation pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/) — index-provided sort
- [`$documentNumber`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/documentNumber/), [`$bucketAuto`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/bucketAuto/)
- [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

---

## Why an index on `sortBy` is pivotal

[`$setWindowFields.sortBy`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/#std-label-setWindowFields-sortBy) uses the **same syntax as `$sort`**. Index absorption is documented for [`$sort` after `$match`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance); window `sortBy` is **not** fused into `$cursor` the same way.

v3 therefore puts an explicit **`$sort` immediately after `$match`**. When that `$sort` is absorbed, `$cursor` is `FETCH` → `IXSCAN` (no `SORT`) and `$setWindowFields` consumes an already-ordered stream. `$setWindowFields` is still a blocking accumulator, limited to the stage window — semi-blocking is the accurate term.

A `$setWindowFields` whose `sortBy` is the first ordering stage injects a physical **`SORT`** (often on `COLLSCAN` or an unordered `IXSCAN`). That SORT materializes keys in the **32MiB** in-memory sort budget. Atlas M0 / Flex ignore `allowDiskUse` and do not spill. Policy A treats that as a failed plan.

**Choosing `sortBy` is the plan.** It must be a key an index can satisfy. Policy A in `niceDeleteMany.js`:

1. Derive `sortBy` from the filter (`{}` / non-field predicates → `_id`).
2. Explain `$match` + `$sort` (`queryPlanner`) with the candidate hint when one is in play.
3. When that plan is index-ordered, also explain the **window prefix** (`$match` + `$sort` + ordinal `$setWindowFields`).
4. **Window** mode only when **both** plans are IXSCAN with no `COLLSCAN` and no blocking `SORT` / `SORT_KEY_GENERATOR`.
5. Otherwise **scan** mode: hinted `{_id:1}` `find()`, residual filter as FETCH, buckets assembled in-process.
6. A user hint is honored only when that hinted explain is index-ordered; otherwise WARN and take the `_id` scan.

**Bucket vs batch:** pipeline fields stay `bucket*` (consistent with operators like `$bucketAuto`). “Batch” is the client/task-pool name for a yielded bucket once it enters the delete worker pool. Both modes yield the same document shape, **100 `_id`s per bucket** by default.

---

## Shared inputs

| Symbol                      | Meaning                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `filter`                    | Match predicate                                                                      |
| `$$bucketSizeLimit`         | Aggregation `let` / in-process height (typically 100)                                |
| `sortBy` / `curationSortBy` | Sort key, e.g. `{ _id: 1 }` or `{ qty: 1 }` — **must be index-backed for window mode** |
| `mode`                      | `window` (agg pipeline) or `scan` (`find()` + in-process buckets)                    |
| `buckets` (v1 only)         | Large `$bucketAuto` bucket count (historically near `2^31 - 1`)                      |

---

## Pipeline evolution (v1 → v2 → v3)

### v1 — Blocking mode with count estimations

**Intent:** Global ordinal, total match count (`IDsTotal`), `$bucketAuto`, then windowed global progress (`bucketsTotal`, cumulative counts).

**Trade-off:** Good for ETA-style fields; poor for large streaming deletes (blocking counts / heavy bucketing).

```javascript
[
  { $match: filter },
  {
    $setWindowFields: {
      sortBy: { _id: 1 },
      output: {
        ordinal: { $documentNumber: {} },
        IDsTotal: { $count: {} }
      }
    }
  },
  {
    $bucketAuto: {
      groupBy: { $ceil: { $divide: ["$ordinal", "$$bucketSizeLimit"] } },
      buckets: buckets,
      output: {
        IDs: { $push: "$_id" },
        bucketSize: { $sum: 1 },
        IDsTotal: { $max: "$IDsTotal" }
      }
    }
  },
  {
    $setWindowFields: {
      sortBy: { _id: 1 },
      output: {
        bucketId: { $documentNumber: {} },
        bucketsTotal: { $count: {} },
        IDsCumulative: {
          $sum: "$bucketSize",
          window: { documents: ["unbounded", "current"] }
        }
      }
    }
  }
];
```

### v2 — Reduced mode without global counts

**Intent:** Ordinal → `bucketId` → `$group` buckets; drop global `IDsTotal`. Still `_id`-ordered.

**Trade-off:** No full match count; `$group` + `$push` per bucket remains memory-heavy on large keys.

```javascript
[
  { $match: filter },
  {
    $setWindowFields: {
      sortBy: { _id: 1 },
      output: { ordinal: { $documentNumber: {} } }
    }
  },
  {
    $set: {
      bucketId: { $ceil: { $divide: ["$ordinal", "$$bucketSizeLimit"] } }
    }
  },
  {
    $group: {
      _id: "$bucketId",
      IDs: { $push: "$_id" },
      bucketSize: { $sum: 1 }
    }
  },
  {
    $setWindowFields: {
      sortBy: { _id: 1 },
      output: {
        bucketId: { $documentNumber: {} },
        IDsCumulative: {
          $sum: "$bucketSize",
          window: { documents: ["unbounded", "current"] }
        }
      }
    }
  }
];
```

### v3 — Partitioned windows, or hinted `_id` find (current pattern)

**Intent:** Yield fixed-size `_id` buckets. Policy A picks **window** mode when `$match` + `$sort` is index-ordered and the window prefix stays IXSCAN-without-SORT. Otherwise **scan** mode: hinted `{_id:1}` `find()`, residual FETCH, in-process buckets of the same shape.

**Trade-off:** No global remaining count (by design). Client may show elapsed, batch counts, and an **estimated** rate `(okBuckets × bucketSizeLimit) / elapsed`. Scan order is `_id` rather than a filter-aligned key; the filter is residual on FETCH.

| Field         | Role                                                            |
| ------------- | --------------------------------------------------------------- |
| `ordinal`     | Document number in `curationSortBy` order (window mode)         |
| `bucketId`    | `ceil(ordinal / bucketSizeLimit)` (window) or 1-based counter (scan) |
| `cardinal`    | `1` per document for the bucket window sum                      |
| `idsInBucket` | Running count **within** the bucket (match-only; not projected) |
| `ids`         | `_id` array for the bucket                                      |
| `bucketSize`  | Count of ids in the emitted bucket                              |

Yielded document (both modes):

```javascript
{ bucketId, bucketSize, bucketSizeLimit, ids }
```

#### Window mode — `$match` + `$sort` + partitioned `$setWindowFields`

`$sort` sits immediately after `$match` so an index can provide order. `$setWindowFields.sortBy` then matches that key. Aggregation options **fail closed**: `allowDiskUse: false`. Cursor `batchSize` is **1** because each agg document is already one bucket of `bucketSizeLimit` ids.

```javascript
const aggOpts = {
  allowDiskUse: false, // leftover SORT is a failed plan
  cursor: { batchSize: 1 },
  let: { bucketSizeLimit },
  // hint, collation, readPreference as Policy A resolved
};

[
  { $match: filter },
  { $sort: curationSortBy }, // index-absorbable; required before SWF
  {
    $setWindowFields: {
      sortBy: curationSortBy,
      output: { ordinal: { $documentNumber: {} } }
    }
  },
  {
    $set: {
      bucketId: { $ceil: { $divide: ["$ordinal", "$$bucketSizeLimit"] } },
      cardinal: 1
    }
  },
  {
    $setWindowFields: {
      partitionBy: "$bucketId",
      sortBy: curationSortBy,
      output: {
        idsInBucket: {
          $sum: "$cardinal",
          window: { documents: ["unbounded", "current"] }
        },
        ids: { $push: "$_id" },
        bucketSize: { $sum: 1 }
      }
    }
  },
  {
    $match: {
      $expr: { $eq: ["$idsInBucket", "$bucketSize"] }
    }
  },
  {
    $project: {
      _id: 0,
      bucketId: 1,
      bucketSize: 1,
      bucketSizeLimit: "$$bucketSizeLimit",
      ids: 1
    }
  }
];
```

#### Scan mode — hinted `{_id:1}` `find()` + in-process buckets

Used when the window plan would COLLSCAN or inject a blocking SORT. Residual filter is a FETCH (object scan). Wire `batchSize` equals `bucketSizeLimit` so each getMore is one yielded bucket.

```javascript
const findOpts = {
  sort: { _id: 1 },
  hint: { _id: 1 },
  batchSize: bucketSizeLimit, // 100 ids per getMore = one bucket
  // collation, readPreference as on the aggregate path
};

namespace.find(filter, { _id: 1 }, findOpts);
// for-await docs; every bucketSizeLimit _ids, yield { bucketId, bucketSize, bucketSizeLimit, ids }
```

### Progression at a glance

|                    | v1            | v2           | v3 window                                         | v3 scan                                      |
| ------------------ | ------------- | ------------ | ------------------------------------------------- | -------------------------------------------- |
| Sort key           | `{ _id: 1 }`  | `{ _id: 1 }` | Policy A `curationSortBy` (index-ordered)         | `{ _id: 1 }` (hinted)                        |
| Global match count | Yes           | No           | No                                                | No                                           |
| Bucketing          | `$bucketAuto` | `$group`     | Partitioned windows + last-row emit               | In-process, 100 ids per bucket               |
| Streaming          | Weak          | Better       | Strong when `$sort` is absorbed into `$cursor`    | Strong: IXSCAN `_id` + residual FETCH        |

```text
v1  ordinal + IDsTotal + $bucketAuto + global windows
      ↓ drop global counts
v2  ordinal → bucketId → $group → renumber
      ↓ drop $group; partition; Policy A sort
v3  Policy A:
      window: $match → $sort → ordinal SWF → bucketId → per-bucket window → emit last-in-bucket
      scan:   find({_id:1} hint) → residual FETCH → in-process 100-id buckets
```

---

## Verifying order with `explain` (Policy A)

Probe **before** the long cursor. Window mode requires **both** probes to be index-ordered (IXSCAN, no `COLLSCAN`, no blocking `SORT` / `SORT_KEY_GENERATOR`):

```javascript
// 1. Prefix — $sort after $match must be absorbed into $cursor
db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: filter }, { $sort: sortBy }], explainOpts);

// 2. Window prefix — $setWindowFields must not inject a leftover SORT
db.collection.explain("queryPlanner").aggregate(
  [
    { $match: filter },
    { $sort: sortBy },
    {
      $setWindowFields: {
        sortBy: sortBy,
        output: { ordinal: { $documentNumber: {} } }
      }
    }
  ],
  explainOpts
);
```

`explainOpts` carry the candidate **hint** (when one is in play), **collation**, and the same per-command **readPreference** as the live cursor.

**Window** mode when both winning plans are index-ordered. **Scan** mode otherwise: `find()` with `hint: { _id: 1 }`, `sort: { _id: 1 }`. A user hint is kept only when the hinted explain is index-ordered; otherwise WARN and take the `_id` scan.

Inspect **`queryPlanner.winningPlan`** (or `$cursor.queryPlanner.winningPlan`). A `$sort` merely echoed from the command pipeline is not a blocking sort. A leftover agg `stages[].$sort` with `sortPattern` **is** blocking — that is the 32MiB query SORT `$setWindowFields` injects when order was not absorbed.

| Signal                                              | Meaning                                         |
| --------------------------------------------------- | ----------------------------------------------- |
| `FETCH` → `IXSCAN` (no `SORT`)                      | Index provides order — window mode is eligible  |
| `SORT` → `COLLSCAN` (or `SORT` over unordered scan) | Blocking — scan mode (`find()` `{_id:1}`)       |
| `IXSCAN.keyPattern`                                 | Index that served filter/order                  |
| Agg `stages[].$sort` with `sortPattern`             | Sort not absorbed into `$cursor` — scan mode    |

### Example A — index-ordered `_id` (good)

```javascript
db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: { qty: { $gte: 10 } } }, { $sort: { _id: 1 } }]);
// Typical: FETCH → IXSCAN { "_id": 1 }  (no SORT stage)
```

### Example B — sort key without a supporting index (blocking)

```javascript
// No { qty: 1 } index
db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: { qty: { $gte: 10 } } }, { $sort: { qty: 1 } }]);
// Observed shape: planStages [ 'SORT', 'COLLSCAN' ]
```

Policy A takes **scan** mode: hinted `{_id:1}` `find()` (or create `{ qty: 1 }` / a suitable compound index to stay in window mode).

### Example C — filter-aligned index (good)

```javascript
db.collection.createIndex({ qty: 1 });
db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: { qty: { $gte: 10 } } }, { $sort: { qty: 1 } }]);
// Typical: FETCH → IXSCAN { "qty": 1 }  (no SORT)
```

Then v3 **window** mode may use `"curationSortBy": { "qty": 1 }` end-to-end (`$match` + `$sort` + `$setWindowFields`).

### Example D — compound equality → trailing sort

```javascript
// Index: { "status": 1, "region": 1, "createdAt": 1 }
db.collection
  .explain("queryPlanner")
  .aggregate([
    { $match: { status: "active", region: "EU" } },
    { $sort: { createdAt: 1 } }
  ]);
// Good: IXSCAN on that compound key without SORT
```

Useful when extending beyond a single filter field (Policy B–style probes).

### Example E — scan mode (`find()` `{_id:1}`)

When either probe fails (no supporting index, leftover `$sort.sortPattern` after `$cursor`, or a user hint that does not produce IXSCAN-without-SORT), `niceDeleteMany.js` walks:

```javascript
db.collection.find(filter, { _id: 1 }, {
  sort: { _id: 1 },
  hint: { _id: 1 },
  batchSize: 100,
  readPreference: cmdRP
});
```

Typical plan: `FETCH` → `IXSCAN { _id: 1 }`. The filter is residual. Prefetch tasks still receive **100 `_id`s** per bucket, matching window mode.

### Compact stage dump (mongosh)

```javascript
function planStages(node, acc = []) {
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => planStages(n, acc));
    return acc;
  }
  if (node.stage || node.nodeType) acc.push(node.stage || node.nodeType);
  for (const k of ["inputStage", "inputStages", "queryPlan"])
    if (node[k] != null) planStages(node[k], acc);
  return acc;
}
const expl = db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: filter }, { $sort: sortBy }]);
const wp =
  expl.queryPlanner?.winningPlan ||
  expl.stages?.[0]?.$cursor?.queryPlanner?.winningPlan;
printjson(planStages(wp));
// Dump the window prefix the same way ($match + $sort + ordinal $setWindowFields).
```

---

## See also

- `src/niceDeleteMany.js` — reference implementation (`getIds`, Policy A `resolveCurationOrder`, `getIdsByIdIndexScan`)
- [mongosh-scripting-guide.md](mongosh-scripting-guide.md) — thenable cursors, per-command read preference, explain false-positives, Atlas caveats
- [`$setWindowFields`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/) · [`$sort` performance](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance) · [pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/) · [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)
