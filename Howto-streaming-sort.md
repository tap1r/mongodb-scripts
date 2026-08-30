# Howto: streaming sort - a non-blocking $group implementation

How to keep an ordered aggregation **streaming** (non-blocking) when you need a stable sort key for windowed or bucketed work — as used by `src/niceDeleteMany.js` to emit fixed-size `_id` buckets for concurrent deletes.

This is the documented evolution of the pipeline history (v1 → v2 → v3), the `src/niceDeleteMany.js` script is included for design context.

## Goal

1. `$match` a filter.
2. Walk matching documents in a **stable sort order**.
3. Derive fixed-size **buckets** of `_id`s and return them from a **server-side cursor** so a client can prefetch and process concurrently.
4. Keep the pipeline **non-blocking** when an index can provide that order; avoid designs that force a full in-memory/disk sort or a global count of all matches up front.

Related MongoDB docs:

- [`$setWindowFields`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/) — `sortBy` uses the **same syntax as [`$sort`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/)**
- [`$sort` and indexes](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance) — index can provide order when `$sort` is first or only preceded by `$match`
- [Aggregation pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/) — index-provided sort
- [`$documentNumber`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/documentNumber/), [`$bucketAuto`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/bucketAuto/)
- [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

---

## Why an index on `sortBy` is pivotal

[`$setWindowFields.sortBy`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/#std-label-setWindowFields-sortBy) is documented as using the **same syntax as `$sort`**. The manual does **not** spell out index behaviour for window `sortBy` in one place the way it does for `$sort`; it is easy to miss that **streaming depends on an index providing that order**.

In practice:

- If an index can supply `sortBy` (same rules of thumb as `$sort` after `$match`), the engine can avoid a blocking `SORT` and the window/bucketing stages can proceed in order as documents stream. Noting that `$setWindowFields` is still a blocking accumulater though, limited to the size of the stage window. So maybe semi-blocking is more accurate.
- If not, you get a physical **`SORT`** (often on top of `COLLSCAN` or a non-ordered `IXSCAN`). That blocks: the server must materialize/sort before window semantics that need order can finish — defeating “stream buckets forever” for large matches.

So for this pattern, **choosing `sortBy` is not cosmetic**. It must be a key an index can satisfy (or you must **hint** such an index). Policy A in `niceDeleteMany.js` exists mainly to enforce that: probe `$match` + `$sort` with `explain('queryPlanner')`, and only keep a filter-aligned `sortBy` when the winning plan has **no** `COLLSCAN` and **no** blocking `SORT` / `SORT_KEY_GENERATOR`; otherwise fall back to `{ _id: 1 }` + hint `{ _id: 1 }`.

**Bucket vs batch:** pipeline fields stay `bucket*` (consistent with operators like `$bucketAuto`). “Batch” is the client/task-pool name for a yielded bucket once it enters the delete worker pool.

---

## Shared inputs

| Symbol                      | Meaning                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `filter`                    | Match predicate                                                                      |
| `$$bucketSizeLimit`         | Aggregation `let` (bucket height, typically 100)                                     |
| `sortBy` / `curationSortBy` | Sort key, e.g. `{ _id: 1 }` or `{ qty: 1 }` — **must be index-backed for streaming** |
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

### v3 — Partitioned windows (current pattern)

**Intent:** Stream in `curationSortBy` order (index-backed via Policy A). Partitioned `$setWindowFields` builds each bucket’s `ids` / `bucketSize`. Emit **one document per completed bucket** (last row in the partition window).

**Trade-off:** No global remaining count (by design). Client may show elapsed, batch counts, and an **estimated** rate `(okBuckets × bucketSizeLimit) / elapsed`.

| Field         | Role                                                            |
| ------------- | --------------------------------------------------------------- |
| `ordinal`     | Document number in `curationSortBy` order                       |
| `bucketId`    | `ceil(ordinal / bucketSizeLimit)`                               |
| `cardinal`    | `1` per document for the bucket window sum                      |
| `idsInBucket` | Running count **within** the bucket (match-only; not projected) |
| `ids`         | `_id` array for the bucket                                      |
| `bucketSize`  | Count of ids in the emitted bucket                              |

```javascript
[
  { $match: filter },
  {
    $setWindowFields: {
      sortBy: curationSortBy, // must be index-providable
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

### Progression at a glance

|                    | v1            | v2           | v3                                             |
| ------------------ | ------------- | ------------ | ---------------------------------------------- |
| Sort key           | `{ _id: 1 }`  | `{ _id: 1 }` | Policy A `curationSortBy` (**index required**) |
| Global match count | Yes           | No           | No                                             |
| Bucketing          | `$bucketAuto` | `$group`     | Partitioned windows + last-row emit            |
| Streaming          | Weak          | Better       | Strong when index-ordered                      |

```text
v1  ordinal + IDsTotal + $bucketAuto + global windows
      ↓ drop global counts
v2  ordinal → bucketId → $group → renumber
      ↓ drop $group; partition; Policy A sort
v3  ordinal → bucketId → per-bucket window → emit last-in-bucket
```

---

## Verifying order with `explain` (Policy A)

Probe before the long cursor:

```javascript
db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: filter }, { $sort: sortBy }]);
```

**Keep `sortBy` only if** the winning plan has no `COLLSCAN` and no blocking `SORT` / `SORT_KEY_GENERATOR`. Otherwise fall back to `{ "_id": 1 }` (+ hint).

Inspect **`queryPlanner.winningPlan`** (or `$cursor.queryPlanner.winningPlan`). Do not treat a `$sort` merely echoed from the command pipeline as proof of a blocking sort.

| Signal                                              | Meaning                                    |
| --------------------------------------------------- | ------------------------------------------ |
| `FETCH` → `IXSCAN` (no `SORT`)                      | Index provides order — good for streaming  |
| `SORT` → `COLLSCAN` (or `SORT` over unordered scan) | Blocking — bad for large streaming buckets |
| `IXSCAN.keyPattern`                                 | Index that served filter/order             |
| Agg `stages[].$sort` with `sortPattern`             | Sort not absorbed into `$cursor`           |

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

Fall back to `{ "_id": 1 }` (or create `{ qty: 1 }` / a suitable compound index).

### Example C — filter-aligned index (good)

```javascript
db.collection.createIndex({ qty: 1 });
db.collection
  .explain("queryPlanner")
  .aggregate([{ $match: { qty: { $gte: 10 } } }, { $sort: { qty: 1 } }]);
// Typical: FETCH → IXSCAN { "qty": 1 }  (no SORT)
```

Then v3 may use `"curationSortBy": { "qty": 1 }` end-to-end.

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
```

---

## See also

- `src/niceDeleteMany.js` — reference implementation (`getIds`, Policy A `resolveCurationOrder`)
- [mongosh-scripting-guide.md](mongosh-scripting-guide.md) — explain false-positives, read preference, Atlas caveats
- [`$setWindowFields`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/) · [`$sort` performance](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance) · [pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/) · [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)
