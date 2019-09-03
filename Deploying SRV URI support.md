# Roll your own SRV resource records for _mongodb+srv://_ protocol support

## Deploying a test _named_ for SRV support - or OnPrem install

- Use topology via driver SDAM to extract rs.conf()
- Take input on domain name, and repl params

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

What is should look like:

```bash
$ nslookup -type=TXT tapir-vwwps.mongodb.net
Server:   1.1.1.1
Address:  1.1.1.1#53

Non-authoritative answer:
tapir-vwwps.mongodb.net text = "authSource=admin&replicaSet=Tapir-shard-0"

$ nslookup -type=SRV _mongodb._tcp.tapir-vwwps.mongodb.net
Server:   1.1.1.1
Address:  1.1.1.1#53

Non-authoritative answer:
_mongodb._tcp.tapir-vwwps.mongodb.net   service = 0 0 27017 tapir-shard-00-00-vwwps.mongodb.net.
_mongodb._tcp.tapir-vwwps.mongodb.net   service = 0 0 27017 tapir-shard-00-01-vwwps.mongodb.net.
_mongodb._tcp.tapir-vwwps.mongodb.net   service = 0 0 27017 tapir-shard-00-02-vwwps.mongodb.net.
```
