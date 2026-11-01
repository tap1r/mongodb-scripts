# DNS over HTTPS (DoH) on macOS

`cloudflared proxy-dns` was removed in cloudflared 2026.2.0 (2 February 2026). A current `brew install cloudflared` will not serve a local resolver. The old `cloudflare/cloudflare` tap, `/usr/local/etc/cloudflared/config.yml`, and `proxy-dns: true` are not a working setup. Builds from before that date can still run the old command until Cloudflare's one-year support window for that release ends. Do not install one for a new machine.

Cloudflare's replacement notes: [changelog](https://developers.cloudflare.com/changelog/2025-11-11-cloudflared-proxy-dns/) and [DoH clients](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/dns-over-https-client/).

## This Mac

Use the [Cloudflare WARP client](https://developers.cloudflare.com/warp-client/get-started/). It sends the machine's DNS to 1.1.1.1 over HTTPS. There is no local port-53 config and no system DNS override to `127.0.0.1`.

## Local resolver on port 53

Use [DNSCrypt-Proxy](https://dnscrypt.info/doc) 2 when something else on the machine must query `127.0.0.1:53`. It speaks DoH.

```bash
brew install dnscrypt-proxy
```

In `$(brew --prefix)/etc/dnscrypt-proxy.toml`, set the server list. On Apple Silicon that directory is `/opt/homebrew/etc`. On Intel Homebrew it is `/usr/local/etc`.

```toml
server_names = ['cloudflare', 'cloudflare-ipv6']
```

Nothing else should listen on port 53. Register the service from the [DNSCrypt-Proxy install notes](https://github.com/DNSCrypt/dnscrypt-proxy/wiki/installation), then check it:

```bash
dnscrypt-proxy -resolve cloudflare-dns.com
```

Point the Mac's resolver at `127.0.0.1`: System Settings → Network → the active service → Details → DNS.

```bash
dig +short @127.0.0.1 cloudflare.com A
```
