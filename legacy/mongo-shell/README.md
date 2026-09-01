# Legacy mongo shell snapshot

Last **dual-shell** (`mongo` 4.4+ / mongosh) snapshot of `src/`.

| | |
|--|--|
| Cut date | 2026-09-01 |
| Intended git tag | `legacy-mongo-shell` (on the commit that adds this tree) |
| Library | `src/mdblib.js` **v0.15.10** — pair archived scripts with this file |
| mongod floor | 4.4 |
| Legacy `mongo` floor | 4.4 |
| mongosh floor (as frozen) | 1.10 / 2.10+ |

This tree is **unmaintained** except critical fixes if ever. New work happens in repository [`src/`](../../src/), which after this cut is the **GA mongosh** line.

Scripts here still contain `isMongosh()` / `slaveOk` / dual `Timestamp` / `runCommand` shapes. Do not expect them to track mongosh-line features (auto-trim, JSON module contracts, `mdblib.for(db)`).

Per-script freeze versions are in [`ROADMAP.md`](../../ROADMAP.md) → Legacy mongo shell retirement §1.

See [DISCLAIMER.md](DISCLAIMER.md). Use at your own risk; test thoroughly before any non-testing environment.
