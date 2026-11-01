# Procedure for (re)generating FIPS compliant SSL certificates

## NOTE

These steps are designed to augment the existing TLS certificate generation steps
(<https://www.mongodb.com/docs/manual/tutorial/configure-ssl/>)
and the FIPS configuration guide (<https://www.mongodb.com/docs/manual/tutorial/configure-fips/>).

## OVERVIEW

FIPS 140-2 and 140-3 are the Federal Information Processing Standards for cryptographic modules. A certificate is not a cipher suite. What matters here is the module that signs it, the key algorithm, and the signature digest:

- Sign a new certificate with SHA-256 or stronger. SHA-1 is not an approved signature hash for a new certificate. The OpenSSL 3 FIPS provider still implements SHA-1 for some legacy checks. A successful `openssl sha1` does not mean the module is in FIPS mode, and it is not the digest to put on a new certificate.
- Prefer RSA 2048 or an approved ECDSA curve (P-256 or P-384), and a PKCS#8 or PKCS#12 key. Encrypt the PKCS#8 key with AES-256 if the PEM must not sit in the clear.

OpenSSL 3 does not use the OpenSSL 1.0 switch `OPENSSL_FIPS=1`. FIPS is a provider, installed with `openssl fipsinstall` and selected by `openssl.cnf`. Confirm it before generating a certificate:

```bash
openssl version
openssl list -providers
```

A FIPS-enforced configuration lists the `fips` provider as active (usually next to `base`) and does not leave `default` as the source of algorithms. Then:

```bash
openssl md5 somefile
openssl sha256 somefile
```

MD5 must be refused. SHA-256 must succeed. Installing the provider is distro-specific. On RHEL and Fedora that is the system FIPS policy, not an environment variable.

### Generating a new self-signed certificate

`-sha256` is explicit so a default change cannot fall back to a weaker digest. OpenSSL 3 `req` already defaults to SHA-256.

```bash
openssl req -newkey rsa:2048 -new -x509 -sha256 -days 3650 -nodes -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com" -out mongodb-cert.crt -keyout mongodb-cert.key

cat mongodb-cert.key mongodb-cert.crt > mongodb.pk8
```

### Re-generating from an existing non-FIPS compliant certificate

If using an older PKCS#1 key, wrap it as an encrypted PKCS#8 key. Do not pass `-nocrypt` together with `-v2`. `-nocrypt` wins, and the output key is not encrypted.

1. Convert the private key _`mongodb-cert.key`_ to _`mongodb-pk8.key`_. `openssl pkcs8` reads a key, not a certificate bundle.

   ```bash
   openssl pkcs8 -topk8 -v2 aes-256-cbc -in mongodb-cert.key -out mongodb-pk8.key
   ```

1. Recombine that key with the certificate only (not the old PKCS#1 key) to create the bundle:

   ```bash
   cat mongodb-pk8.key mongodb-cert.crt > mongodb.pk8
   ```

### Generating a new CA signed FIPS compliant certificate

These options are subject to the CA provider.  If the CA does not offer FIPS compliant certificates, you can simply rehash them:

1. Request the CSR and generate the certificate as per normal with your CA provider
1. Taking the signed CA bundle from the CA, use the steps above "Re-generating from existing a non-FIPS compliant certificate" to rehash the private key

The names, key and certificate location will vary according to how the CA provider presents the bundle, adjust the syntax as required.

### Update any CA path changes

1. Update _`mongod.conf`_ to the new bundle. `net.tls.certificateKeyFile` is the TLS key name. `PEMKeyFile` belongs under the old `net.ssl` block. If the PKCS#8 key is encrypted, set `certificateKeyFilePassword` as well.

   ```yaml
   net:
       tls:
           mode: requireTLS
           certificateKeyFile: /path/to/certificate/mongodb.pk8
           certificateKeyFilePassword: <passphrase>
           FIPSMode: true
   ```

1. Restart the _`mongod`_ and check the _`mongod.log`_ for adherence to the new FIPS parameters. The error "_`digital envelope routines:EVP_DigestInit_ex:disabled for fips`_" may be found in the _`mongod.log`_ startup messages when a non-FIPS certificate is used with FIPS mode enabled.
