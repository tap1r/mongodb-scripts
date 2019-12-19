# Split-Horizon Topology testing

A quick reproduction for split-horizon testing on OSX

## Installation

### Simulate a port forwarding topology use case

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

Display your current port forwarding rules:

```bash
sudo pfctl -s nat
```

Remove all rules and forwarding

```bash
sudo pfctl -F all -f /etc/pf.conf
sudo sysctl -w net.inet.ip.forwarding=0
sudo sysctl -w net.inet6.ip6.forwarding=0
```

### Build a replica set

Start with a standard deployment with TLS enabled (required for split-horizon support)

```bash
mlaunch init --replicaset --nodes=3 --sslMode preferSSL --sslCAFile mongodb.pk8 --sslPEMKeyFile mongodb.pk8 --sslAllowConnectionsWithoutCertificates
```

### Update the replica set topology

As reported by _`db.isMaster()`_

Connect without SSL:

```bash
mongo mongodb://host1:27017/?replicaSet=replset
```

...

### Ensure correct hostname resolution

Modify _`/etc/hosts`_ if required

## Testing

Connect to the native port

```bash
mongo mongodb://host1:27017/?replicaSet=replset&ssl=true --eval 'db.isMaster()'
```

Connect to the translated port

```bash
mongo mongodb://host1:37017/?replicaSet=replset&ssl=true --eval 'db.isMaster()'
```
