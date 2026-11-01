# Kerberos AES interop requirements

MIT Kerberos and Active Directory derive an AES keytab entry with different salts. `ktutil` salts with the principal you name. Active Directory salts a user account with the user principal name (UPN), then the service uses the service principal name (SPN). Generating the entry directly as the SPN produces a key Active Directory will not accept.

This is MIT `ktutil` (`addent`, `list`, `delent`, `wkt`). The Heimdal `ktutil` on macOS does not take these commands.

## Ensure the AES ciphers are enabled

In `krb5.conf`:

```ini
[libdefaults]
    default_tkt_enctypes = aes256-cts-hmac-sha1-96
    default_tgs_enctypes = aes256-cts-hmac-sha1-96
```

## Build the keytab

`ktutil` does not salt a key supplied as hex. Create the key as the UPN, copy those bytes, and store them under the SPN.

1. Add an entry for the UPN. The realm after `@` is uppercase. `<KVNO>` is the account's `msDS-KeyVersionNumber`.
2. List the entry and copy the hex key.
3. Add a second entry with `-key`, using the SPN as the principal and the same kvno and enctype. Paste the hex key. This entry is not salted again.
4. Delete the UPN slot so the keytab contains only the SPN.
5. Write the keytab.

```text
$ ktutil
ktutil:  addent -password -p mongodb_svc@MONGODB.COM -k 2 -e aes256-cts-hmac-sha1-96
Password for mongodb_svc@MONGODB.COM:
ktutil:  list -k
slot KVNO Principal
---- ---- ---------------------------------------------------------------------
   1    2 mongodb_svc@MONGODB.COM (0x0c4f65678310e3ab14bfd9dc6a1f65a25f13ed6fa72062c4713409b5b2c7dca0)
ktutil:  addent -key -p mongodb/host.mongodb.com@MONGODB.COM -k 2 -e aes256-cts-hmac-sha1-96
Key for mongodb/host.mongodb.com@MONGODB.COM (hex): 0x0c4f65678310e3ab14bfd9dc6a1f65a25f13ed6fa72062c4713409b5b2c7dca0
ktutil:  delent 1
ktutil:  wkt mongodb_ad.keytab
```

`mongodb_ad.keytab` holds the SPN. The key bytes are the ones derived from the UPN salt.
