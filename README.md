# mongodb-scripts

A collection of MongoDB scripts and command notes.

Live scripts are in [`src/`](src/). They run under **mongosh** 1.10 / 2.10+ (`mongosh --file` and `load()`). Read the [disclaimer](DISCLAIMER.md) before running anything outside a test environment.

## Start here

* [`src/`](src/) — operator scripts for storage, deletes, schema, latency, and cluster checks.
* [DB Storage tools](DB%20Storage%20tools.md) — WiredTiger disk use. dbstats reports it. autoCompact, onlineDefrag, and indexCacheUtil act on or inspect the same storage.
* [mongosh scripting guide](mongosh-scripting-guide.md) — read preference, sessions, async, and `--eval` behaviour that long-running scripts keep hitting.
* [Roadmap](ROADMAP.md) — planned work, plus the live and archived version of each script.

## Howtos

* [Aggregation tips](Aggregation%20tips.md) — pipelines for a rolling date window, oplog churn, and schema shape.
* [Howto: streaming sort](Howto-streaming-sort.md) — keep an ordered walk streaming, as niceDeleteMany does when it buckets `_id` values.
* [Roll your own SRV records](Deploying%20SRV%20URI%20support.md) — publish TXT and SRV records for `mongodb+srv://` in a zone you control.

## Command notes

### Auth and TLS

* [TLS/SSL commands](SSL%20commands.md) — OpenSSL commands for MongoDB certificates, Atlas CAs, ciphers, and x509 cluster auth.
* [FIPS enablement](FIPS%20cert%20generation.md) — regenerate a certificate so the key and signature meet FIPS.
* [Kerberos commands](Kerberos%20CMDs.md) — keytab export, delegation tests, and S4U.
* [Kerberos MIT/AD interoperability](Kerberos%20AES.md) — enable AES and build an Active Directory service keytab.
* [LDAP anon bindings](LDAP%20anon%20bindings.md) — an anonymous bind leaves `queryUser` and `queryPassword` unset.

### Topology and clients

* [Split-Horizon Topology testing](Split-Horizon.md) — stand up a replica set with split horizons and check the external names.
* [BI Connector reproductions](BI%20Connector%20reproductions.md) — mongosqld 2.13.1 startup and MySQL connection strings, with and without SSL and auth.
* [DNS over HTTPS](DoH.md) — turn on DNS over HTTPS on macOS, including a local resolver on port 53.
* [VM ballooning detection](VM%20ballooning%20driver%20detection.md) — detect the hypervisor and whether a ballooning driver is present.

### Operations

* [Atomic backups using `fsyncLock()`](fsyncLock.md) — which single-mongod file backups are consistent, through 9.0.
* [Sweet32 protection in Ops Manager (Java)](Sweet32.md) — historical Ops Manager deny list for 3DES. Do not add it on a current Ops Manager.
* [Command tool tips](Tool%20tips.md) — process and network commands used alongside these notes.

## Legacy

The last dual-shell (`mongo` / mongosh) tree is the [legacy mongo shell snapshot](legacy/mongo-shell/README.md), cut 2026-09-01 at tag `legacy-mongo-shell`. It is unmaintained. Pair those files with archived `mdblib.js` v0.15.10.
