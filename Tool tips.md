# Tips and tricks

## Proc handling

```bash
grep -ri $(ps -p $(pgrep mongod) -o user=) /etc/security/limits.d/*

grep -ri $(ps -p $(pgrep mongod) -o pid=) /etc/security/limits.d/*

sudo cat /proc/`pgrep -n mongod`/numa_maps
sudo cat /proc/`pgrep -n mongod`/limits
ls -l /proc/`pgrep -n mongod`/fd

ps -o user= -p $(pgrep -n mongod)

su -s /bin/bash - mongod -c "mongod +startup_options"

su -s /bin/bash - `ps -o user= -p $(pgrep -n mongod)` -c "whoami"
su - $(ps -o user= -p $(pgrep -n mongod)) -c "whoami"
```

## Network behaviour

* **Packet captures**

Capture _interesting_ traffic related to the SDAM routines and Kerberos:

```bash
sudo tcpdump -s 0 port 27017 or port 53 or port 88 -w /tmp/mongodb.pcap
```

* **Socket stats**

```bash
lsof
netstat -a
```
