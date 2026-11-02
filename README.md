# mongodb-scripts

A collection of MongoDB scripts and command notes.

Live scripts are in [`src/`](src/). They run under **mongosh** 1.10 / 2.10+. Read the [disclaimer](DISCLAIMER.md) before running anything outside a test environment.

## Start here

* [`src/`](src/)
* [DB Storage tools](DB%20Storage%20tools.md)
* [mongosh scripting guide](mongosh-scripting-guide.md)
* [Roadmap](ROADMAP.md)

## Howtos

* [Aggregation tips](Aggregation%20tips.md)
* [Howto: streaming sort](Howto-streaming-sort.md)
* [Roll your own SRV records](Deploying%20SRV%20URI%20support.md)

## Command notes

* **Auth and TLS.** [TLS/SSL commands](SSL%20commands.md), [FIPS enablement](FIPS%20cert%20generation.md), [Kerberos commands](Kerberos%20CMDs.md), [Kerberos MIT/AD interoperability](Kerberos%20AES.md), [LDAP anon bindings](LDAP%20anon%20bindings.md).
* **Topology and clients.** [Split-Horizon Topology testing](Split-Horizon.md), [BI Connector reproductions](BI%20Connector%20reproductions.md), [DNS over HTTPS](DoH.md), [VM ballooning detection](VM%20ballooning%20driver%20detection.md).
* **Operations.** [Atomic backups using `fsyncLock()`](fsyncLock.md), [Sweet32 protection in Ops Manager (Java)](Sweet32.md), [Command tool tips](Tool%20tips.md).

## Legacy

The last dual-shell (`mongo` / mongosh) tree is the [legacy mongo shell snapshot](legacy/mongo-shell/README.md). It is unmaintained. Pair those files with archived `mdblib.js` v0.15.10.
