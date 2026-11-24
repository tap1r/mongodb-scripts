# Roll your own SRV resource records for `mongodb+srv://`

The URI is one host and no port: `mongodb+srv://example.net/`. The driver looks up a TXT record on that host and SRV records at `_mongodb._tcp.<host>`. `srvServiceName` changes the first label. It defaults to `mongodb`.

The TXT value may contain only `authSource`, `replicaSet`, and `loadBalanced`. One TXT record per name. Several strings inside that record are joined in order. A second TXT record is an error. `retryWrites`, `w`, and `readPreference` belong on the URI. A URI option overrides the same option in the TXT record. `mongodb+srv://` turns TLS on. `tls=false` is allowed on the URI. A TXT record cannot set `tls` or `ssl`.

Each SRV target is `priority weight port host`. The port lives on the SRV record, and the records may use different ports. Drivers ignore priority and weight, so `0 0` is a placeholder. The target is a name with an A or AAAA record, and it ends with a dot. The seed name itself does not need an address record. [srvatlas.sh](src/srvatlas.sh) warns and continues when one is present.

Every target has to fall under the parent inferred from the seed. For `example.net` that parent is `example.net`, and each target must sit one label deeper, as `node0.example.net` does. For `cluster.prod.example.net` the parent is `prod.example.net`, so `node0.example.net` is rejected. `srvAllowedHostsSuffix` is a client option for naming that parent yourself. It is not a DNS record, and a wider suffix admits more hosts from a forged answer.

A replica set puts `replicaSet` in the TXT and one SRV record per member. Take that list from `rs.conf().members` or from `db.hello()` (`hosts` and `setName`). `hello` replaced `isMaster`. A sharded cluster omits `replicaSet` and lists the `mongos` hosts. A load balancer is one SRV target and `loadBalanced=true`, with no `replicaSet`. `srvMaxHosts` applies to a sharded seed list that has neither `replicaSet` nor `loadBalanced=true`.

The `mongodb+srv` hostname is the TXT and SRV owner. Leave it without a CNAME. A resolver that follows a CNAME on that name can break the parent check.

Publish these names in a zone you control. `mongodb.net` is Atlas's zone. An update there is refused, and `prereq nxdomain mongodb.net` aborts as soon as that name exists. `prereq` applies to the whole batch.

Every name in `nsupdate` needs a trailing dot. Without it, `nsupdate` appends the default origin and the record is stored under the wrong name.

A server that requires authenticated updates needs a TSIG key: `nsupdate -k /path/to/key`.

## Install `nsupdate`

`nsupdate` is not an rpm name. It is in the BIND client package.

```bash
# Fedora / RHEL
dnf install bind-utils

# Debian / Ubuntu
apt-get install bind9-dnsutils
```

macOS already ships `nsupdate`, or `brew install bind`.

## Publish address records

The targets need an A or AAAA record. The seed name does not. `prereq nxrrset` fails the batch if that record is already there. `update add` appends a record. To change a published set, delete that name's records and add the new ones in the same update.

```bash
nsupdate
prereq nxrrset node0.example.net. A
update add node0.example.net. 86400 A 192.0.2.100
update add node1.example.net. 86400 A 192.0.2.101
update add node2.example.net. 86400 A 192.0.2.102
send
```

## Publish SRV and TXT records

The TXT owner is the `mongodb+srv` host. The SRV owner is `_mongodb._tcp.` plus that host.

```bash
nsupdate
prereq nxrrset example.net. TXT
update add example.net. 86400 TXT "authSource=admin&replicaSet=example-rs"
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node0.example.net.
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node1.example.net.
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node2.example.net.
send
```

The same delete-then-add replaces a TXT or SRV set:

```bash
nsupdate
update delete example.net. TXT
update delete _mongodb._tcp.example.net. SRV
update add example.net. 86400 TXT "authSource=admin&replicaSet=example-rs"
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node0.example.net.
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node1.example.net.
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node2.example.net.
send
```

A load-balanced `mongos` is one target and a different TXT value. `lb.example.net` is a two-label seed, so the target sits one label deeper:

```bash
nsupdate
prereq nxrrset lb.example.net. TXT
update add lb.example.net. 86400 TXT "loadBalanced=true"
update add _mongodb._tcp.lb.example.net. 86400 SRV 0 0 27017 ingress.example.net.
send
```

## What the records look like

[srvatlas.sh](src/srvatlas.sh) 1.0.0 validates the name, then latency, TCP, TLS, and `hello` agreement.

```bash
bash srvatlas.sh [--ciphers] [--tls|--plaintext] example.net
```

A name ending in `.mongodb.net` or `.mongodbgov.net` is Atlas. TLS is mandatory there, and `--plaintext` exits. Any other name is on-prem: both plaintext and TLS are probed unless you pass one of those flags. `--ciphers` walks every local cipher and is slower than the default peel. The script titles every name `Validating Atlas cluster name`, including this on-prem example.

The listing below is the report shape for the replica-set records above. Latency numbers, the wire version, the compressors, the tags, and the cipher lists are illustrations. A real run prints every node.

```text
Profile: onprem (plaintext and TLS are probed; both may be enabled)

Validating Atlas cluster name:	example.net

	TXT resource record:	"authSource=admin&replicaSet=example-rs"

	SRV resource record:	node0.example.net.
	Resolves to CNAME/A:	192.0.2.100
	Service parameter:	TCP/27017

	SRV resource record:	node1.example.net.
	Resolves to CNAME/A:	192.0.2.101
	Service parameter:	TCP/27017

	SRV resource record:	node2.example.net.
	Resolves to CNAME/A:	192.0.2.102
	Service parameter:	TCP/27017

DNS query latency:

	TXT query latency:	12ms
	SRV query latency:	11ms
	A query latency:	9ms (slowest A lookup)

	DNS batch latency:	40ms

DNS tests done.

Host connectivity tests on: node0.example.net:27017 node1.example.net:27017 node2.example.net:27017

	node:			node0.example.net:27017
	TCP connectivity:	succeeded
	plaintext:		disabled
	TLS:			enabled
	TLS protocol:		TLSv1.3
	TLS ciphersuite:	TLS_AES_128_GCM_SHA256
	TLS group:		X25519

Transport: tls

Evaluating connection properties to individual nodes: node0.example.net:27017 …

	node:			node0.example.net:27017
	saslSupportedMechs:	SCRAM-SHA-256
	compression:		snappy,zstd,zlib
	chosen compressor:	snappy
	maxWireVersion:		25
	TLS cipher scanning:
		tls1: None
		tls1_1: None
		tls1_2: ECDHE-RSA-AES128-GCM-SHA256 …
		tls1_3: TLS_AES_128_GCM_SHA256 …
		groups: x25519 …

Connectivity tests done.

Replica set consistency tests:
	TXT replicaSet:	example-rs

	Evaluating:	node0.example.net:27017

	Host type:	mongod
	Identity:	node0.example.net:27017
	replset name:	example-rs
	replset hosts:	node0.example.net:27017,node1.example.net:27017,node2.example.net:27017
	replset tags:	{dc:east}
	agreement:	ok

Replica set tests done.

Complete!
```

The same records with `dig`. The trailing dot keeps the lookup absolute.

```bash
dig +short example.net. TXT
dig +short _mongodb._tcp.example.net. SRV
dig +short node0.example.net. A
```
