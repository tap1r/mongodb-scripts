# Kerberos AES interop requirements

Internal research that has illustrated a known interoperability issue between MIT Kerberos and MS Active Directory.  That in particular is the choice of salt used by the _keytab_ generation tools, which happen to differ.  The following is an internally developed procedure that we use to workaround this limitation during the _keytab_ generation.

## Ensure the AES ciphers are enabled

In the _`krb5.conf`_ file, add the following snippet:

```yaml
[libdefaults]
    default_tkt_enctypes = aes256-cts-hmac-sha1-96
    default_tgs_enctypes = aes256-cts-hmac-sha1-96
```

Next, fire up _`ktutil`_. We're going to perform a trick to force _`ktutil`_ to use the right salt. When _`ktutil`_ generates a _keytab_ entry, it uses the principal as the salt. But if we generate an entry using a hex encoded key, _`ktutil`_ doesn't need to salt it. Substitute the example values as appropriate for your environment.  The steps are:

1. Generate a key using the UPN, with the Active Directory domain (REALM) following the '@' capitalised
1. Dump the resulting key into hex
1. Re-import the key as a new entry using the _servicePrincipalName_ as the principal

```bash
ktutil:  add_entry -password -p mongodb/host.mongodb.com@MONGODB.COM -e aes256-cts-hmac-sha1-96 -k <KVNO>
Password for mongodb/host.mongodb.com@MONGODB.COM:
ktutil:  list -k
slot KVNO Principal
---- ---- ---------------------------------------------------------------------
   1    2 mongodb/host.mongodb.com@MONGODB.COM (0x0c4f65678310e3ab14bfd9dc6a1f65a25f13ed6fa72062c4713409b5b2c7dca0)
ktutil:  add_entry -key -p mongodb/host.mongodb.com@MONGODB.COM -e aes256-cts-hmac-sha1-96 -k <KVNO>
Key for mongodb/host.mongodb.com@MONGODB.COM (hex): 0x0c4f65678310e3ab14bfd9dc6a1f65a25f13ed6fa72062c4713409b5b2c7dca0
ktutil:  write_kt mongodb_ad.keytab
```

The resulting _keytab_ file (_`mongodb_ad.keytab`_) will be salted with the AES-256 _enctype_ cipher.
