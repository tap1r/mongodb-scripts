# mongodb-scripts

A collection of MongoDB scripts and command notes.

Live scripts are in [`src/`](src/). They run under **mongosh** 1.10 / 2.10+ (`mongosh --file` and `load()`). [DB Storage tools](DB%20Storage%20tools.md) covers dbstats, autoCompact, onlineDefrag, and indexCacheUtil. The [mongosh scripting guide](mongosh-scripting-guide.md) records shell quirks those scripts keep hitting. Planned work is in the [roadmap](ROADMAP.md).

The last dual-shell (`mongo` / mongosh) tree is the [legacy mongo shell snapshot](legacy/mongo-shell/README.md). It is unmaintained. Pair those files with archived `mdblib.js` v0.15.10.

Use at your own risk. Read the [disclaimer](DISCLAIMER.md) before running anything outside a test environment.

## Scripts and shell notes

* [DB Storage tools](DB%20Storage%20tools.md)
* [mongosh scripting guide](mongosh-scripting-guide.md)
* [Roadmap](ROADMAP.md)
* [Legacy mongo shell snapshot](legacy/mongo-shell/README.md)
* [Aggregation tips](Aggregation%20tips.md)
* [Howto: streaming sort](Howto-streaming-sort.md)
* [Roll your own SRV records](Deploying%20SRV%20URI%20support.md)

## Command notes

* [DISCLAIMER](DISCLAIMER.md)
* [Atomic backups using _fsyncLock()_](fsyncLock.md)
* [BI Connector reproductions](BI%20Connector%20reproductions.md)
* [Command tool tips](Tool%20tips.md)
* [DNS over HTTPS](DoH.md)
* [FIPS enablement](FIPS%20cert%20generation.md)
* [Kerberos commands](Kerberos%20CMDs.md)
* [Kerberos MIT/AD interoperability](Kerberos%20AES.md)
* [LDAP anon bindings](LDAP%20anon%20bindings.md)
* [Split-Horizon Topology testing](Split-Horizon.md)
* [Sweet32 protection in Ops Manager (Java)](Sweet32.md)
* [TLS/SSL commands](SSL%20commands.md)
* [VM ballooning detection](VM%20ballooning%20driver%20detection.md)
