# Tips and tricks

## Install some useful dependencies (match for your OS)

`nmap` is the cipher probe in [TLS/SSL commands](SSL%20commands.md) and the port check in [Split-Horizon Topology testing](Split-Horizon.md).

* macOS

  `ps`, `pgrep`, `lsof`, `tcpdump`, and `netstat` are already on the system.

  The certificate recipes in [TLS/SSL commands](SSL%20commands.md) use the Homebrew `openssl` on `PATH`. That formula is OpenSSL 4. `/usr/bin/openssl` is LibreSSL and rejects `-noenc`.

  ```bash
  brew install openssl
  brew install nmap
  ```

* Fedora / RHEL

  `ps` and `pgrep` come from `procps-ng`. `dnf` is the installer on Fedora, RHEL, and CentOS Stream.

  ```bash
  dnf install procps-ng
  dnf install openssl
  dnf install nmap
  dnf install tcpdump
  dnf install lsof
  ```

* Ubuntu / Debian

  `ps` and `pgrep` come from `procps`.

  ```bash
  apt-get install procps
  apt-get install openssl
  apt-get install nmap
  apt-get install tcpdump
  apt-get install lsof
  ```

## Proc handling

`pgrep -x mongod` matches the process name exactly. `pgrep mongod` matches any name that contains those letters, including `mongodump` and `mongodecrypt`. `-n` selects the newest when several match. The commands below use `-nx` for one process. The signal goes to every exact match. A pid file is the surer pick on a host that runs a shard and a config server.

```bash
ps -o user= -p "$(pgrep -nx mongod)"
ps -o args= -p "$(pgrep -nx mongod)"
```

`ps -o args=` is the command line of the running server. `db.adminCommand({ getCmdLineOpts: 1 })` is the parsed view from inside the server.

The packaged user has a nologin shell, so `-s /bin/bash` is what runs.

```bash
sudo su -s /bin/bash "$(ps -o user= -p "$(pgrep -nx mongod)" | tr -d '[:space:]')" -c 'whoami'
```

`SIGUSR1` rotates the log of each matched process. The server rotates when it is logging to a file (`systemLog.path`).

```bash
sudo kill -SIGUSR1 $(pgrep -x mongod)
```

Linux. The username search reads the PAM limits in `limits.conf` and `limits.d`. A `mongod` started by systemd takes `LimitNOFILE` from its unit. `/proc/<pid>/limits` is the value in force, and `/proc/<pid>/fd` is the open files. The first line of `numa_maps` is the one `mongod` reads. It says `interleave` when the server was started with `numactl --interleave=all`.

```bash
pid=$(pgrep -nx mongod)
grep -r "$(ps -o user= -p "$pid" | tr -d '[:space:]')" /etc/security/limits.conf /etc/security/limits.d
sudo cat /proc/$pid/limits
sudo ls -l /proc/$pid/fd
sudo head -n 1 /proc/$pid/numa_maps
```

## Network behaviour

* **Packet captures**

  The filter is the default listener, DNS, and Kerberos. `tcp` applies only to `27017`, so ports 53 and 88 stay UDP and TCP. Use the port the server is listening on.

  With no `-i`, tcpdump uses the first non-loopback interface, so a local `mongod` is missed. macOS has no `any` device. A local server is `lo0` on macOS and `lo` on Linux. `tcpdump -D` lists the names. `-nn` skips name lookups, which would themselves be port 53 traffic. `-s 0` keeps the whole packet. Once the server is on TLS, the `27017` payload is ciphertext. The DNS exchange and the handshake are the readable part.

  ```bash
  # macOS, local server
  sudo tcpdump -nn -s 0 -i lo0 -w /tmp/mongodb.pcap 'tcp port 27017 or port 53 or port 88'

  # Linux, local server
  sudo tcpdump -nn -s 0 -i lo -w /tmp/mongodb.pcap 'tcp port 27017 or port 53 or port 88'
  ```

  Wireshark uses the same BPF capture filter. `||` is display-filter syntax.

  ```text
  tcp port 27017 or port 53 or port 88
  ```

* **Socket stats**

  ```bash
  lsof -nP -p "$(pgrep -nx mongod)"
  lsof -nP -iTCP:27017 -sTCP:ESTABLISHED
  ```

  Linux. `ss` comes with `iproute2`.

  ```bash
  ss -lptn 'sport = :27017'
  ```

  macOS:

  ```bash
  netstat -an -p tcp | grep 27017
  ```
