# Howto: streaming sort

How to keep an ordered walk **streaming** (non-blocking) when you need a stable sort key for windowed or bucketed work — as used by `src/niceDeleteMany.js` to emit fixed-size `_id` buckets for concurrent deletes.

This is the documented evolution of the pipeline history (v1 → v2 → v3). `src/niceDeleteMany.js` is the reference implementation. As of 1.1.1 the current pattern is three find walks: an index-ordered find, a natural index scan with no sort, or a hinted `{_id:1}` find. Each uses `readOnce` and builds the buckets in the client. The 1.1.0 aggregation is history below.

## Goal

1. `$match` a filter.
2. Walk matching documents in a **stable sort order**.
3. Derive fixed-size **buckets** of `_id`s (typically 100) and yield them so a client can prefetch and process concurrently.
4. Explain the find that will run. When that plan is an index scan with no blocking SORT, open it with `readOnce` and the explained hint. Add the sort only when the index provides it. Otherwise walk a hinted `{_id:1}` find. Buckets are assembled in the client. Atlas M0/Flex omit `noCursorTimeout` and still use that same find.

Related MongoDB docs:

- [`$setWindowFields`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/) — `sortBy` uses the **same syntax as [`$sort`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/)**
- [`$sort` and indexes](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance) — index can provide order when `$sort` is first or only preceded by `$match`
- [Aggregation pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/) — index-provided sort
- [`$documentNumber`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/documentNumber/), [`$bucketAuto`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/bucketAuto/)
- [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)

---

## Why an index on `sortBy` is pivotal

[`$setWindowFields.sortBy`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/#std-label-setWindowFields-sortBy) uses the **same syntax as `$sort`**. Index absorption is documented for [`$sort` after `$match`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance); window `sortBy` is **not** fused into `$cursor` the same way.

In 1.1.0, v3 put an explicit **`$sort` immediately after `$match`**. When that `$sort` was absorbed, `$cursor` was `FETCH` → `IXSCAN` (no `SORT`) and the ordinal window consumed an already-ordered stream. On 9.0 that absorbed window often explains as `FETCH` → `SORT_KEY_GENERATOR` → `IXSCAN`. The generator attaches sort-key metadata. It is not a blocking `SORT`.

A `$setWindowFields` whose `sortBy` is the first ordering stage injects a physical **`SORT`** (often on `COLLSCAN` or an unordered index scan). That SORT materializes keys in the aggregation blocking-sort budget, `internalQueryMaxBlockingSortMemoryUsageBytes`, default **100MiB**. Atlas M0 / Flex ignore `allowDiskUse` and do not spill. Policy A treats that as a failed ordered plan.

`partitionBy` on the public stage always adds the partition field to a `$sort`, even when `sortBy` is `{}` and `bucketId` is already one contiguous run. That second sort is the 100MiB / code-292 path. `$_internalSetWindowFields` does not sort. `sortBy` only describes the order the input already has, and `{}` adds no `$sort`. Boundaries are runs of equal keys; the stage does not regroup interleaved keys. Document bounds still require the field (error 5339901). `$documentNumber` rejects an empty `sortBy` (error 5371602); a running `$sum: 1` over documents `[unbounded, current]` is the ordinal that accepts `{}`. `sortBy: {}` is server behaviour, not a documented contract. 1.1.1 does not open that pipeline. The find explain is the plan the cursor runs, and `readOnce` exists only on find.

**Choosing `sortBy` is the plan.** It must be a key an index can satisfy. `resolveCurationOrder` walks `POLICY_A_STEPS`. The first non-null result wins. The live cursor is that find, hinted with the explained `keyPattern`.

1. Derive `sortBy` from the filter (`{}` / non-field predicates → `_id`).
2. **User hint (C2, C3, C3nat, then C3scan).** Explain `find` with that hint, `projection: {_id: 1}`, and the candidate sort. Ordered find when the plan is an index scan with no blocking `SORT`. Otherwise Policy B reuses the hint: hinted explains, no ranked fallback, cap 8. If those miss, explain the same find with no sort. Natural find when that plan is a selective index scan. Otherwise WARN and take the `_id` scan. A user hint stops there. It does not continue into the unhinted planner.
3. **C4, unhinted.** Explain `find` with the sort and no hint. If `winningPlan` is index-ordered, pin its `keyPattern`. Else walk `rejectedPlans` in planner order and **hint** the first plan that is index-ordered on a window-safe btree (`listCurationIndexes`). Then explain that hinted find.
4. **Ordered find** only when the plan is an index scan, no `COLLSCAN` / `COLLECTIONSCAN`, and no blocking `SORT`. Index-scan stages are `IXSCAN`, `EXPRESS_IXSCAN`, `CLUSTERED_IXSCAN`, `IDHACK`, `COUNT_SCAN`, and `INDEXSCAN`. `SORT_KEY_GENERATOR` over one of those stages is index-provided order, not a blocking sort. Two different index scans in one plan are not pinned to one hint.
5. **C7 Policy B.** When that first-field `sortBy` has no viable ranked plan, probe btree indexes whose prefix keys are **equality** fields of the filter: prefix keys in index order, then the next (trailing) key — ESR, Example D. Each unique `sortBy` uses the same unhinted ranked-plan matching. Cap 8.
6. **C5 natural.** When no ordered candidate wins, explain the find with no sort. Natural find when the winning plan is one selective index scan. Do not promote a rejected index the planner passed over. A COLLSCAN stays on the `_id` walk.
7. **C6 scan.** Hinted `{_id:1}` find, sort `{_id:1}`, residual filter as FETCH, buckets assembled in process.
8. **Sort overflow.** If a live ordered or natural find still hits the in-memory sort limit before the first bucket, continue as the `_id` scan. A failure after a bucket has already been yielded is not retried on a second walk.

**Bucket vs batch:** pipeline fields stay `bucket*` (consistent with operators like `$bucketAuto`). “Batch” is the client/task-pool name for a yielded bucket once it enters the delete worker pool. Both modes yield the same document shape, **100 `_id`s per bucket** by default.

---

## Shared inputs

| Symbol                      | Meaning                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `filter`                    | Match predicate                                                                      |
| `$$bucketSizeLimit`         | Aggregation `let` / in-process height (typically 100)                                |
| `sortBy` / `curationSortBy` | Sort key, e.g. `{ _id: 1 }` or `{ qty: 1 }` — **must be index-backed for the ordered find**. Natural mode omits sort |
| `mode`                      | `ordered` (hinted find + sort), `natural` (hinted find, no sort), or `scan` (hinted `{_id:1}` find). All three bucket in process |
| `buckets` (v1 only)         | Large `$bucketAuto` bucket count (historically near `2^31 - 1`)                      |

---

## Current cursor (1.1.1)

Policy A explains the find the walk will open: `projection: { _id: 1 }`, a sort only when the index provides it, and a hint when one is pinned. The live cursor is that find, sent through `database._runCursorCommand` so `readOnce` reaches the server. Buckets of `bucketSizeLimit` ids (default 100) are assembled in the client. The yielded document is unchanged:

```javascript
{ bucketId, bucketSize, bucketSizeLimit, ids }
```

```javascript
const findCmd = {
  find: namespace.getName(),
  filter,
  projection: { _id: 1 },
  batchSize: bucketSizeLimit, // firstBatch; getMore is cursor._cursor.setBatchSize
  maxTimeMS: 0,
  readOnce: true
  // sort: curationSortBy     — ordered and scan; natural omits sort
  // hint: explained keyPattern, or { _id: 1 } for scan
  // noCursorTimeout: true     — omitted on Atlas M0/Flex
  // collation: user collation, on the find only
};
database._runCursorCommand(findCmd, {
  readPreference: driverReadPreference(cmdRP)
});
```

| Mode | Find | When |
| --- | --- | --- |
| `ordered` | sort + pinned hint | one index scan, no blocking `SORT` |
| `natural` | no sort, pinned hint | ordered probes miss, and the no-sort plan is one selective index scan (a hashed `IXSCAN` counts) |
| `scan` | sort `{ _id: 1 }`, hint `{ _id: 1 }` | `COLLSCAN`, blocking `SORT`, shards that disagree, or two different `IXSCAN` keyPatterns |

A user hint that produces an index scan is kept. Otherwise the walk pins the single explained `keyPattern`. The find sort cap is smaller than the aggregation 100MiB budget. Code 292 (`QueryExceededMemoryLimitNoDiskUseAllowed`) before the first bucket continues as the `_id` scan. A failure after a bucket has been yielded is not retried on a second walk.

The sections below are the pipeline history that led here. 1.1.1 does not open them.

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

### v3 — Partitioned windows (1.1.0 aggregation; the live cursor is the find walk as of 1.1.1)

**1.1.0 history.** This pipeline yielded fixed-size `_id` buckets on the server. Policy A opened the **ordered window** when `$match` + `$sort` was index-ordered, the full pipeline stayed an index scan without a blocking SORT, and the host could spill. The bucket stage was `$_internalSetWindowFields` with `sortBy: {}`, so a monotonic `bucketId` was not sorted again. When that ordered plan missed but `$match` was a selective index scan, the **natural window** bucketed in index arrival order with no `$sort`. Otherwise **scan** mode used a hinted `{_id:1}` find. Atlas M0/Flex skipped the ordered window. 1.1.1 replaced all three cursors with the find walk above. A find with no `SORT` does not need spill, so M0/Flex can take the ordered or natural find and only omit `noCursorTimeout`.

**Trade-off (1.1.0):** No global remaining count (by design). The client showed elapsed, batch counts, and an **estimated** rate `(okBuckets × bucketSizeLimit) / elapsed`. Natural order was the index's arrival order. Scan order was `_id` and the filter was residual on FETCH. On a sharded collection the server ran `$_internalSetWindowFields` on the merging half, so the window could not set `readOnce`. That is the reason 1.1.1 moved the bucket loop into the client on a find cursor.

| Field         | Role                                                            |
| ------------- | --------------------------------------------------------------- |
| `ordinal`     | `$documentNumber` in `curationSortBy` order (ordered window), or a running `$sum: 1` (natural window) |
| `bucketId`    | `ceil(ordinal / bucketSizeLimit)` (window) or 1-based counter (scan) |
| `cardinal`    | `1` per document for the bucket window sum                      |
| `idsInBucket` | Running count **within** the bucket (match-only; not projected) |
| `ids`         | `_id` array for the bucket                                      |
| `bucketSize`  | Count of ids in the emitted bucket                              |

Yielded document (both modes):

```javascript
{ bucketId, bucketSize, bucketSizeLimit, ids }
```

#### Ordered window — `$match` + `$sort` + internal bucket stage

`$sort` sits immediately after `$match` so an index can provide order. Keep that `$sort` immediately after `$match`: a `$project` between them left a real `$sort` on `_id`. The ordinal stage stays the public `$setWindowFields` with `$documentNumber`. The bucket stage is `$_internalSetWindowFields` (`partitionBy: "$bucketId"`, `sortBy: {}`). Aggregation options **fail closed**: `allowDiskUse: false`. Cursor `batchSize` is **1** because each agg document is already one bucket of `bucketSizeLimit` ids. `noCursorTimeout` is set only when the host can spill.

```javascript
const aggOpts = {
  allowDiskUse: false, // leftover SORT is a failed plan
  cursor: { batchSize: 1 },
  maxTimeMS: 0, // override a cluster defaultMaxTimeMS (8.0+)
  noCursorTimeout: true,
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
    $_internalSetWindowFields: {
      partitionBy: "$bucketId",
      sortBy: {}, // already one contiguous bucketId run; do not sort
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

#### Natural window — selective index scan, no `$sort`

Used when no index absorbs the ordered `$sort`, and the `$match` winning plan is still an index scan. Arrival order follows that index, not `_id`. A hashed index is unordered and still qualifies: `listCurationIndexes` skips it for the ordered probes, and the natural explain accepts the `IXSCAN`. A natural COLLSCAN does not.

```javascript
[
  { $match: filter },
  { $project: { _id: 1 } },
  {
    $_internalSetWindowFields: {
      sortBy: {},
      output: {
        ordinal: {
          $sum: 1,
          window: { documents: ["unbounded", "current"] }
        }
      }
    }
  },
  {
    $set: {
      bucketId: { $ceil: { $divide: ["$ordinal", "$$bucketSizeLimit"] } },
      cardinal: 1
    }
  }
  // same $_internalSetWindowFields partition, last-row $match, and $project as the ordered window
];
```

#### Scan mode — hinted `{_id:1}` find command + in-process buckets

1.1.1 uses this command shape for every mode (`getIdsByIndexScan`). Ordered adds the absorbed sort and the pinned hint. Natural omits `sort`. The block below is the scan shape: COLLSCAN, a blocking SORT, a user hint that is not a selective index scan, or code 292 before the first bucket. Residual filter is a FETCH. `batchSize` equals `bucketSizeLimit` so each batch is one yielded bucket.

mongosh `collection.find()` keeps known FindOptions. `readOnce` is a find-command field, so the walk sends the command through `database._runCursorCommand`. `find.batchSize` is the first batch. Later getMore size is `cursor._cursor.setBatchSize(bucketSizeLimit)`. Read preference on this cursor is a driver `ReadPreference` instance. Atlas M0/Flex reject `noCursorTimeout`, so that flag is set only when the host can spill.

```javascript
const findCmd = {
  find: namespace.getName(),
  filter,
  projection: { _id: 1 },
  sort: { _id: 1 },
  hint: { _id: 1 },
  batchSize: bucketSizeLimit,
  maxTimeMS: 0,
  readOnce: true
  // noCursorTimeout: true only when the host can spill
  // collation on the find, same document as explain
};

database._runCursorCommand(findCmd, {
  readPreference: driverReadPreference(cmdRP)
});
// for-await docs; every bucketSizeLimit _ids, yield { bucketId, bucketSize, bucketSizeLimit, ids }
```

The Policy A explain probe stays on `collection.find()`, which is enough to read the plan. `readOnce` stays on the walk command:

```javascript
namespace.find(filter, { _id: 1 }, {
  sort: { _id: 1 },
  hint: { _id: 1 }
}).explain("queryPlanner");
```

### Progression at a glance

|                    | v1            | v2           | v3 ordered window                                      | v3 natural                                      | v3 scan                                      |
| ------------------ | ------------- | ------------ | ------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------- |
| Sort key           | `{ _id: 1 }`  | `{ _id: 1 }` | Policy A `curationSortBy` (index-ordered)              | none (index arrival order)                      | `{ _id: 1 }` (hinted)                        |
| Global match count | Yes           | No           | No                                                     | No                                              | No                                           |
| Bucketing          | `$bucketAuto` | `$group`     | Internal partition + last-row emit                     | Same tail, no `$sort`                           | In-process, 100 ids per bucket               |
| Streaming          | Weak          | Better       | Strong when `$sort` is absorbed into `$cursor`         | Strong: selective IXSCAN, no blocking sort      | Strong: hinted `_id` index scan + residual FETCH |

```text
v1  ordinal + IDsTotal + $bucketAuto + global windows
      ↓ drop global counts
v2  ordinal → bucketId → $group → renumber
      ↓ drop $group; partition; Policy A sort
v3  Policy A (1.1.0 drops the bucketId sort):
      ordered: $match → $sort → ordinal $setWindowFields → bucketId → $_internalSetWindowFields → emit last-in-bucket
      natural: $match → $project {_id:1} → $_internalSetWindowFields ($sum: 1, sortBy {}) → same bucket tail
      scan:    hinted {_id:1} find command (readOnce) → residual FETCH → in-process 100-id buckets
1.1.1  same three choices, one find cursor (readOnce), buckets in the client:
      ordered: find + sort + pinned keyPattern
      natural: find, no sort, pinned selective index (hashed counts)
      scan:    find sort/hint {_id:1}
```

---

## Verifying order with `explain` (Policy A)

Probe the find **before** the long cursor. Explain is `collection.find()`, not an aggregation. Sort goes on the find only for the ordered candidate. Natural explains the same find with no sort. `readOnce` is not on the explain. On mongos the winning-plan root is often `SINGLE_SHARD`; the shard plan is `shards[].winningPlan`. `SORT_KEY_GENERATOR` over an index scan is index order, not a blocking `SORT`.

```javascript
// Ordered candidate — sort + optional hint. Index scan, no SORT.
db.collection.find(filter, { _id: 1 }, {
  sort: sortBy,
  hint: hint, // omit when asking the planner
  collation: collation
}).explain("queryPlanner");

// Natural candidate, only after the ordered probes miss — no sort.
db.collection.find(filter, { _id: 1 }, {
  hint: hint,
  collation: collation
}).explain("queryPlanner");
```

Pass the same **hint**, **collation**, and per-command **readPreference** the live find will use. Apply sort and hint on the options document and again with `cursor.sort()` / `cursor.hint()`. mongosh does not always keep both from the options object.

Unhinted explain also reads `rejectedPlans`. A `COLLSCAN`+`SORT` winner with a rejected index-ordered plan on a btree from `listCurationIndexes` takes that `keyPattern` as the fallback hint, then that hinted find is explained again. A user hint is tried first and does not fall through to the unhinted planner. If shards disagree, or one plan has two different `IXSCAN` keyPatterns, do not pin a hint.

**Ordered find** when every winning plan is one index scan and there is no blocking `SORT`. **Natural find** when the ordered probes miss and the no-sort plan is one selective index scan. **Scan** otherwise: hinted `{_id:1}` find. Code 292 before the first bucket continues as that scan. Atlas M0/Flex run the same probes and omit `noCursorTimeout` on the live cursor.

| Signal | Meaning |
| --- | --- |
| `PROJECTION_SIMPLE` → `FETCH` → `IXSCAN`, `EXPRESS_IXSCAN`, `CLUSTERED_IXSCAN`, or `IDHACK` (no `SORT`) | Index provides order — ordered find is eligible. Pin that one `keyPattern` |
| `FETCH` → `SORT_KEY_GENERATOR` → `IXSCAN` | Same thing on 9.0: index-provided order, not a blocking sort |
| `IXSCAN` on a find with no sort (no `COLLSCAN`, no `SORT`), including hashed | Selective index scan — natural find is eligible. Pin that `keyPattern` |
| `SORT` → `COLLSCAN` or `COLLECTIONSCAN` (or `SORT` over an unordered scan) | Blocking ordered plan. Natural may still apply on the no-sort find |
| `COLLSCAN` / `COLLECTIONSCAN` on the no-sort find | Not selective — scan mode (hinted `{_id:1}` find, `readOnce`) |
| Two `keyPattern` values, or shards that disagree | Do not pin. Fall through |
| `SINGLE_SHARD` with the real plan at `shards[].winningPlan` | mongos find explain. Walk `winningPlan`, not only `inputStage` |

### Example A — index-ordered `_id` (good)

```javascript
db.collection.find(
  { qty: { $gte: 10 } },
  { _id: 1 },
  { sort: { _id: 1 } }
).explain("queryPlanner");
// Typical: FETCH → IXSCAN { "_id": 1 }  (no SORT stage)
```

### Example B — sort key without a supporting index (blocking)

```javascript
// No { qty: 1 } index
db.collection.find(
  { qty: { $gte: 10 } },
  { _id: 1 },
  { sort: { qty: 1 } }
).explain("queryPlanner");
// Observed shape: planStages [ 'SORT', 'COLLSCAN' ]
```

With no index this is a COLLSCAN, so Policy A takes **scan** mode: hinted `{_id:1}` find (or create `{ qty: 1 }` / a suitable compound index to stay on the ordered find). A selective index that cannot satisfy `{ qty: 1 }` — a hashed `{ qty: "hashed" }`, for example — takes the **natural** find instead of that `_id` walk.

### Example C — filter-aligned index (good)

```javascript
db.collection.createIndex({ qty: 1 });
db.collection.find(
  { qty: { $gte: 10 } },
  { _id: 1 },
  { sort: { qty: 1 } }
).explain("queryPlanner");
// Typical: FETCH → IXSCAN { "qty": 1 }  (no SORT)
```

The ordered find then uses `curationSortBy` `{ qty: 1 }` and pins that `keyPattern` as the hint.

### Example D — compound equality → trailing sort

```javascript
// Index: { "status": 1, "region": 1, "createdAt": 1 }
db.collection.find(
  { status: "active", region: "EU" },
  { _id: 1 },
  { sort: { createdAt: 1 } }
).explain("queryPlanner");
// Good: IXSCAN on that compound key without SORT
```

Policy B in `niceDeleteMany.js` probes this when the first filter field is not an index prefix (for example sort `{ region: 1 }` against `{ status: 1, region: 1, createdAt: 1 }`).

### Example E — scan mode (hinted `{_id:1}` find command)

Scan mode is this walk when the natural plan is a COLLSCAN: there is no selective index, or the user hint is neither index-ordered nor a selective index scan. A blocking `SORT` rejects the ordered find before that choice. Atlas M0/Flex use the same three walks and omit `noCursorTimeout`. The explain probe is:

```javascript
db.collection.find(filter, { _id: 1 }, {
  sort: { _id: 1 },
  hint: { _id: 1 }
}).explain("queryPlanner");
```

Typical plan: `FETCH` → `IXSCAN { _id: 1 }` (or `EXPRESS_IXSCAN` / `CLUSTERED_IXSCAN` / `IDHACK` on the same key). The filter is residual. Prefetch tasks still receive **100 `_id`s** per bucket, matching the ordered and natural walks.

### Compact stage dump (mongosh)

```javascript
function planStages(node, acc = []) {
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => planStages(n, acc));
    return acc;
  }
  if (node.stage || node.nodeType) acc.push(node.stage || node.nodeType);
  for (const k of [
    "inputStage", "inputStages", "thenStage", "elseStage",
    "innerStage", "outerStage", "shards", "winningPlan", "queryPlan"
  ])
    if (node[k] != null) planStages(node[k], acc);
  return acc;
}
const expl = db.collection.find(filter, { _id: 1 }, { sort: sortBy }).explain("queryPlanner");
const wp = expl.queryPlanner?.winningPlan;
printjson(planStages(wp));
// On mongos, walk shards[].winningPlan (the root is often SINGLE_SHARD).
// SORT_KEY_GENERATOR over IXSCAN is index order. A physical SORT is blocking.
```

---

## See also

- `src/niceDeleteMany.js` — reference implementation (`getIds`, Policy A `resolveCurationOrder`, `getIdsByIndexScan`)
- [mongosh-scripting-guide.md](mongosh-scripting-guide.md) — thenable cursors, per-command read preference, explain false-positives, `readOnce` / `_runCursorCommand`, Atlas caveats
- [`$setWindowFields`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/setWindowFields/) · [`$sort` performance](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sort/#-sort-operator-and-performance) · [pipeline optimization](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-optimization/) · [Explain results](https://www.mongodb.com/docs/manual/reference/explain-results/)
