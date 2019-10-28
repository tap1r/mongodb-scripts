# Roll your own SRV resource records for _`mongodb+srv://`_ protocol support

## Deploying a test _`named`_ for SRV support - or OnPrem installation

- Derive the replicat set topology from the  _`rs.conf()`_ command or a _`db.isMaster()`_ driver SDAM call (via the _`isMaster.hosts`_ and _`isMaster.setName`_ documents)
- Take input on domain name, and replica set parameters

### Install some dependencies

```bash
rpm install named
```

```text
_SRV
TXT
TSSIG considerations?
```

## Anatomy of DNS records and limitations

A records
CNAME records (optional)
TXT record
SRV records

## Publish with _nsupdate_

```bash
$ nsupdate
prereq nxdomain mongodb.net
update add tapir-vwwps.mongodb.net 86400 TXT "authSource=admin&replicaSet=Tapir-shard-0"
update add _mongodb._tcp.tapir-vwwps.mongodb.net 86400 SRV 0 0 27017 tapir-shard-00-00-vwwps.mongodb.net.
update add _mongodb._tcp.tapir-vwwps.mongodb.net 86400 SRV 0 0 27017 tapir-shard-00-01-vwwps.mongodb.net.
update add _mongodb._tcp.tapir-vwwps.mongodb.net 86400 SRV 0 0 27017 tapir-shard-00-02-vwwps.mongodb.net.
send
```

### What the DNS records should look like

```bash
$ nslookup -debug -type=TXT tapir-vwwps.mongodb.net
Server:		1.1.1.1
Address:	1.1.1.1#53

------------
    QUESTIONS:
	tapir-vwwps.mongodb.net, type = TXT, class = IN
    ANSWERS:
    ->  tapir-vwwps.mongodb.net
	text = "authSource=admin&replicaSet=Tapir-shard-0"
	ttl = 60
    AUTHORITY RECORDS:
    ADDITIONAL RECORDS:
------------
Non-authoritative answer:
tapir-vwwps.mongodb.net	text = "authSource=admin&replicaSet=Tapir-shard-0"

Authoritative answers can be found from:
```

```bash
$ nslookup -debug -type=SRV _mongodb._tcp.tapir-vwwps.mongodb.net
Server:		1.1.1.1
Address:	1.1.1.1#53

------------
    QUESTIONS:
	_mongodb._tcp.tapir-vwwps.mongodb.net, type = SRV, class = IN
    ANSWERS:
    ->  _mongodb._tcp.tapir-vwwps.mongodb.net
	service = 0 0 27017 tapir-shard-00-00-vwwps.mongodb.net.
	ttl = 60
    ->  _mongodb._tcp.tapir-vwwps.mongodb.net
	service = 0 0 27017 tapir-shard-00-01-vwwps.mongodb.net.
	ttl = 60
    ->  _mongodb._tcp.tapir-vwwps.mongodb.net
	service = 0 0 27017 tapir-shard-00-02-vwwps.mongodb.net.
	ttl = 60
    AUTHORITY RECORDS:
    ADDITIONAL RECORDS:
------------
Non-authoritative answer:
_mongodb._tcp.tapir-vwwps.mongodb.net	service = 0 0 27017 tapir-shard-00-00-vwwps.mongodb.net.
_mongodb._tcp.tapir-vwwps.mongodb.net	service = 0 0 27017 tapir-shard-00-01-vwwps.mongodb.net.
_mongodb._tcp.tapir-vwwps.mongodb.net	service = 0 0 27017 tapir-shard-00-02-vwwps.mongodb.net.

Authoritative answers can be found from:
```
