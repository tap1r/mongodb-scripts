# Tips and tricks

## Install some useful dependencies (match for your OS)

* OSX

  ```bash
  brew install proctools
  brew install openssl
  brew install nmap
  brew install tcpdump
  brew install lsof
  ```

* Fedora/Red Hat/CentOS
  
  ```bash
  yum install proctools
  yum install openssl
  yum install nmap
  yum install tcpdump
  yum install lsof
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
```

## Network behaviour

* **Packet captures**
Capture _interesting_ traffic related to the SDAM routines (the MongoDB _wireprotocol_ + DNS) and Kerberos:
  * Using _tcpdump_ for *nix

    ```bash
    sudo tcpdump -s 0 tcp port 27017 or port 53 or port 88 -w /tmp/mongodb.pcap
    ```

  * Using a _wireshark_ (for Windows) capture filter

    ```bash
    tcp port 27017 || port 53 || port 88
    ```

* **Socket stats**

  ```bash
  lsof
  netstat -a
  ```
