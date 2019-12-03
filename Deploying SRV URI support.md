# Roll your own SRV resource records for _`mongodb+srv://`_ protocol support

## Deploying a test `named` for *SRV* record support - or OnPrem installation

- Derive the replicat set topology from the  _`rs.conf()`_ command or a _`db.isMaster()`_ driver SDAM call (via the _`isMaster.hosts`_ and _`isMaster.setName`_ documents)
- Take input on domain name, and replica set parameters

### Install some dependencies

```bash
rpm install nsupdate
```

```text
SRV
TXT
TSSIG considerations?
```

## Anatomy of DNS records and limitations

*A* records
*CNAME* records (optional)
*TXT* record
*SRV* records

## Publish *A* and optional *CNAME* records with `nsupdate` (if required)

```bash
$ nsupdate
prereq nxdomain mongodb.net
update add tapir-shard-00-00-vwwps.mongodb.net. 86400 a 192.0.2.100
update add tapir-shard-00-01-vwwps.mongodb.net. 86400 a 192.0.2.101
update add tapir-shard-00-02-vwwps.mongodb.net. 86400 a 192.0.2.102
update add node0.mongodb.net. 3600 cname tapir-shard-00-00-vwwps.mongodb.net.
update add node1.mongodb.net. 3600 cname tapir-shard-00-01-vwwps.mongodb.net.
update add node2.mongodb.net. 3600 cname tapir-shard-00-02-vwwps.mongodb.net.
send
```

## Publish *SRV* and *TXT* records with `nsupdate`

```bash
$ nsupdate
prereq nxdomain mongodb.net
update add tapir-vwwps.mongodb.net 86400 TXT "authSource=admin&replicaSet=Tapir-shard-0"
update add _mongodb._tcp.tapir-vwwps.mongodb.net 86400 SRV 0 0 27017 tapir-shard-00-00-vwwps.mongodb.net.
update add _mongodb._tcp.tapir-vwwps.mongodb.net 86400 SRV 0 0 27017 tapir-shard-00-01-vwwps.mongodb.net.
update add _mongodb._tcp.tapir-vwwps.mongodb.net 86400 SRV 0 0 27017 tapir-shard-00-02-vwwps.mongodb.net.
send
```

## What the DNS records should look like

Use this [srvatlas.sh](src/srvatlas.sh) script, or manaully lookup the records:

```bash
$ dig +short tapir-vwwps.mongodb.net TXT
"authSource=admin&replicaSet=Tapir-shard-0"

$ dig +short _mongodb._tcp.tapir-vwwps.mongodb.net SRV
0 0 27017 tapir-shard-00-01-vwwps.mongodb.net.
0 0 27017 tapir-shard-00-02-vwwps.mongodb.net.
0 0 27017 tapir-shard-00-00-vwwps.mongodb.net.

$ dig +short tapir-shard-00-01-vwwps.mongodb.net. A
mtm-0-26-shard-00-01-yf1oj.mongodb.net.
ec2-34-194-201-110.compute-1.amazonaws.com.
34.194.201.110

$ dig +short tapir-shard-00-02-vwwps.mongodb.net. A
mtm-0-26-shard-00-02-yf1oj.mongodb.net.
ec2-52-200-205-74.compute-1.amazonaws.com.
52.200.205.74

$ dig +short tapir-shard-00-00-vwwps.mongodb.net. A
mtm-0-26-shard-00-00-yf1oj.mongodb.net.
ec2-34-202-120-213.compute-1.amazonaws.com.
34.202.120.213
```
