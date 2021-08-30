# Split-Horizon Topology testing

A simple reproduction for split-horizon testing.  We simulate a port forwarding topology use case using port address translation (PAT).

## Installation

Add PAT rules (taken from <https://salferrarello.com/mac-pfctl-port-forwarding/>), and enable kernel IP forwarding

```bash
echo "
rdr on en0 proto tcp to any port 37017 -> 127.0.0.1 port 27017
rdr on en0 proto tcp to any port 37018 -> 127.0.0.1 port 27018
rdr on en0 proto tcp to any port 37019 -> 127.0.0.1 port 27019
" | sudo pfctl -ef -
sudo sysctl -w net.inet.ip.forwarding=1
sudo sysctl -w net.inet6.ip6.forwarding=1
```

OSX: Disable the firewall in system preferences

## Verification

Display your current port forwarding rules:

```bash
sudo pfctl -s nat
```

Scan for listening ports

```bash
nmap -sT -p 27017-27019,37017-37019 localhost external
```

Validate the SNI header by inspecting the returned SSL subject/SAN attributes.  Using the [TLS Server tests](https://github.com/tap1r/mongodb-scripts/blob/master/SSL%20commands.md#tls-server-tests) as a basis, we can fomulate this command:

```bash
openssl s_client -connect external:27017 < /dev/null | openssl x509 -noout -text | grep "subject=\|Subject:\|X509v3\ Subject\ Alternative\ Name:\|DNS:"
```

## Uninstallation

Remove all rules and forwarding

```bash
sudo pfctl -F all -f /etc/pf.conf
sudo sysctl -w net.inet.ip.forwarding=0
sudo sysctl -w net.inet6.ip6.forwarding=0
```

## Build a replica set

Start with a standard deployment with TLS enabled (required for split-horizon support), here using the _`mongodb.pk8`_ certificate (see [sample certificates](SSL%20commands.md#generating-common-use-certificates))

```bash
mlaunch init --replicaset --nodes=3 --sslMode preferSSL --sslCAFile mongodb.pk8 --sslPEMKeyFile mongodb.pk8 --sslAllowConnectionsWithoutCertificates
```

### Ensure correct hostname resolution

Modify _`/etc/hosts`_ if required, using "_`external`_" at the external PAT bound hostname

### Update the replica set topology

As reported by _`db.isMaster()`_

Connect without SSL:

```bash
mongo mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=replset
```

Add the split-horizon topology definitions

```javascript
var config = rs.conf();
config.version += 1;
config.members[0].horizons = { "external": "external:37017" };
config.members[1].horizons = { "external": "external:37018" };
config.members[2].horizons = { "external": "external:37019" };
rs.reconfig(config);
```

## Testing

Connect to the native port:

```bash
mongo "mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=replset" --sslCAFile mongodb.pk8 --ssl --eval 'db.isMaster()["hosts"]'
```

The SDAM topology should appear as:

```json
["localhost:27017", "localhost:27018", "localhost:27019"]
```

Connect to the translated port:

```bash
mongo "mongodb://external:37017,external:37018,external:37019/?replicaSet=replset" --sslCAFile mongodb.pk8 --ssl --eval 'db.isMaster()["hosts"]'
```

The SDAM topology should appear as:

```json
["external:37017", "external:37018", "external:37019"]
```
