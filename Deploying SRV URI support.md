# Roll your own SRV resource records for `mongodb+srv://`

`mongodb+srv://` looks up a TXT record on the host name and SRV records at `_mongodb._tcp.<host>`. The TXT value is connection options (`authSource`, `replicaSet`, and so on). Each SRV target is `priority weight port host`.

Take the member list from `rs.conf().members` or from `db.hello()` (`hosts` and `setName`). `hello` replaced `isMaster`.

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

## Publish A and optional CNAME records

`prereq nxrrset` fails the batch if that record is already there. Drop the prereq line to replace it.

```bash
nsupdate
prereq nxrrset node0.example.net. A
update add node0.example.net. 86400 A 192.0.2.100
update add node1.example.net. 86400 A 192.0.2.101
update add node2.example.net. 86400 A 192.0.2.102
update add rs0.example.net. 3600 CNAME node0.example.net.
send
```

## Publish SRV and TXT records

The TXT owner is the `mongodb+srv` host. The SRV owner is `_mongodb._tcp.` plus that host. The target of each SRV record is a name with an A or AAAA record, and it ends with a dot.

```bash
nsupdate
prereq nxrrset example.net. TXT
update add example.net. 86400 TXT "authSource=admin&replicaSet=example-rs"
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node0.example.net.
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node1.example.net.
update add _mongodb._tcp.example.net. 86400 SRV 0 0 27017 node2.example.net.
send
```

## What the records look like

[srvatlas.sh](src/srvatlas.sh) 1.0.0 validates the name, then latency, TCP, TLS, and `hello` agreement.

```bash
bash srvatlas.sh [--ciphers] [--tls|--plaintext] example.net
```

A name ending in `.mongodb.net` or `.mongodbgov.net` is Atlas. TLS is mandatory there, and `--plaintext` exits. Any other name is on-prem: both plaintext and TLS are probed unless you pass one of those flags. `--ciphers` walks every local cipher and is slower than the default peel.

The listing below is the report shape for the records above. Latency numbers and the cipher lists are illustrations. A real run prints every node.

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
