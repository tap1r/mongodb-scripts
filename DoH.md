# DNS over HTTPS (DoH) proxy setup

A cheat sheet to install DoH support on OSX.

## Installation

Add `cloudflared` via `brew`

```bash
brew install cloudflared
```

Create the default config YAML

```bash
$ mkdir -p /usr/local/etc/cloudflared
cat << EOF > /usr/local/etc/cloudflared/config.yml
proxy-dns: true
proxy-dns-upstream:
 - https://1.1.1.1/dns-query
 - https://1.0.0.1/dns-query
EOF
```

Create the service with `sudo` in order to bind to port 53

```bash
sudo cloudflared service install
```

## Starting the service

If installed with `sudo`, start manually with `sudo` (else with start automatically at bootup)

```bash
$ sudo launchctl start com.cloudflare.cloudflared
INFO[0000] Installing Argo Tunnel client as a system launch daemon. Argo Tunnel client will run at boot
INFO[0000] Outputs are logged to /Library/Logs/com.cloudflare.cloudflared.err.log and /Library/Logs/com.cloudflare.cloudflared.out.log
```

## Update your resolver preferences

System Preferences -> Network -> Advanced -> DNS

Add: _`127.0.0.1`_ as the primary (and preferably only) resolver

## Testing

```bash
dig +short @127.0.0.1 cloudflare.com AAAA
2400:cb00:2048:1::c629:d6a2
2400:cb00:2048:1::c629:d7a2
```
