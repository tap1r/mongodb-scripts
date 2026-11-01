# Tips and tricks

## Install some useful dependencies (match for your OS)

* macOS

  `ps`, `pgrep`, `lsof`, and `tcpdump` are already on the system. Homebrew `openssl` is keg-only. It does not replace `/usr/bin/openssl`.

  ```bash
  brew install openssl
  brew install nmap
  ```

* Fedora/Red Hat/CentOS

  `ps` and `pgrep` come from `procps-ng`. `dnf` is the current installer. `yum` still works as a wrapper on older releases.

  ```bash
  dnf install procps-ng
  dnf install openssl
  dnf install nmap
  dnf install tcpdump
  dnf install lsof
  ```

* Ubuntu/Debian APT
  
  ```bash
  apt-get install procps
  apt-get install openssl
  apt-get install nmap
  apt-get install tcpdump
  apt-get install lsof
  ```

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

sudo kill -SIGUSR1 $(ps -p $(pgrep mongod) -o pid=)
```

## Network behaviour

* **Packet captures**

  Capture _interesting_ traffic related to the SDAM routines (the MongoDB _wireprotocol_ + DNS) and Kerberos:

  * Using _tcpdump_ for *nix

    ```bash
    sudo tcpdump -s 0 tcp port 27017 or port 53 or port 88 -w /tmp/mongodb.pcap
    ```

  * Using a _Wireshark_ capture filter (BPF, same language as tcpdump). `||` is display-filter syntax and is not a capture filter.

    ```text
    tcp port 27017 or port 53 or port 88
    ```

* **Socket stats**

  ```bash
  lsof
  netstat -a
  ```
