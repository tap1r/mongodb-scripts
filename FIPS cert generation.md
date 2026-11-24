# Procedure for (re)generating FIPS compliant SSL certificates

## NOTE

These steps are designed to augment the existing [TLS certificate generation](<https://www.mongodb.com/docs/manual/tutorial/configure-ssl/>) steps
and the [FIPS configuration guide](<https://www.mongodb.com/docs/manual/tutorial/configure-fips/>).

## OVERVIEW

FIPS 140-2 and 140-3 are the Federal Information Processing Standards for cryptographic modules. A certificate is not a cipher suite. What matters here is the module that signs it, the key algorithm, and the signature digest:

- Sign a new certificate with SHA-256 or stronger. SHA-1 is not an approved signature hash for a new certificate. The OpenSSL 3 FIPS provider still implements SHA-1 for some legacy checks. A successful `openssl sha1` does not mean the module is in FIPS mode, and it is not the digest to put on a new certificate.
- Prefer RSA 2048 or an approved ECDSA curve (P-256 or P-384). P-521 is also approved. The command below stays with RSA 2048. A PKCS#8 key is the form `mongod` expects in the PEM, and PKCS#12 is the form for Windows. Encrypt the PKCS#8 key with AES-256 when the PEM must not sit in the clear.
- NIST IR 8547, final on 27 October 2026, deprecates RSA and ECDSA at every approved size after 2030 and disallows them after 2035. That is the replacement plan. RSA 2048 and P-256 or P-384 are still the algorithms to generate now.

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

MD5 must be refused. SHA-256 must succeed. Installing the provider is distro-specific. On RHEL and Fedora the switch is the system FIPS policy, `fips-mode-setup --check`, not an environment variable.

These OpenSSL checks are the Linux path. MongoDB Enterprise on Windows uses SChannel, and on macOS it uses Secure Transport. A Homebrew OpenSSL does not put `mongod` into FIPS mode.

### Generating a new self-signed certificate

OpenSSL 3 `req -newkey` already writes PKCS#8. `-aes256` encrypts that key with AES-256 and prompts for the passphrase that `certificateKeyFilePassword` stores. `-sha256` is explicit so a default change cannot fall back to a weaker digest. OpenSSL 3 `req` already defaults to SHA-256. `-noenc` is the current spelling of `-nodes` and leaves the key unencrypted. Use it only when something else protects the key file.

The subject alternative name has to list the names clients use. A common name alone fails that check. When the extended key usage extension is present, a server certificate needs `serverAuth`, and a membership certificate needs `clientAuth`. One certificate used for both roles needs both. A self-signed certificate is for a lab. A deployment uses a CA, below. This example uses the same placeholder names as the OpenSSL cheat sheet, for 397 days.

```bash
openssl req \
  -newkey rsa:2048 \
  -x509 \
  -sha256 \
  -days 397 \
  -aes256 \
  -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com" \
  -addext "subjectAltName=DNS:*.mongodb.com,DNS:*.mongodb.net,IP:127.0.0.1,IP:::1,IP:192.0.2.1" \
  -addext "extendedKeyUsage=serverAuth,clientAuth" \
  -keyout mongodb-cert.key \
  -out mongodb-cert.crt

cat mongodb-cert.key mongodb-cert.crt > mongodb.pk8
```

`.pk8` here is a PEM bundle, not a binary PKCS#8 file. The private key comes first, then the server certificate, then any intermediates. Confirm the signature, the key, the subject alternative name, and the extended key usage:

```bash
openssl x509 -in mongodb-cert.crt -noout -text
```

### Wrapping an existing PKCS#1 key

Read the certificate before wrapping the key:

```bash
openssl x509 -in mongodb-cert.crt -noout -text
```

A SHA-1 or MD5 signature means the certificate has to be reissued. Wrapping the key leaves that signature as it is.

A key that starts with `BEGIN RSA PRIVATE KEY` is PKCS#1. Wrap it as an encrypted PKCS#8 key. `openssl pkcs8` reads a key, not a certificate bundle. Do not pass `-nocrypt` together with `-v2`. `-nocrypt` wins, and the output key is not encrypted. `-v2 aes-256-cbc` selects AES-256-CBC under PKCS#5 v2. Leave the PRF at the OpenSSL 3 default, HMAC-SHA256, so a FIPS-mode `mongod` can decrypt the key.

```bash
openssl pkcs8 -topk8 -v2 aes-256-cbc -in mongodb-cert.key -out mongodb-pk8.key

cat mongodb-pk8.key mongodb-cert.crt > mongodb.pk8
```

The bundle contains the new key and the certificate, not the PKCS#1 key. Intermediates follow the server certificate.

### Generating a CA-signed certificate

A public CA does not sell a separate FIPS certificate. What you need from it is a SHA-256 signature and an approved key. Public CAs already sign with SHA-256.

Since April 2026, a new certificate from a public CA does not include `clientAuth`. MongoDB's advisory is [Public CA policy changes affecting mTLS](https://www.mongodb.com/resources/products/alerts/public-certificate-authority-policy-changes-affecting-mtls). A public certificate can be the server certificate for TLS. Membership authentication and x.509 clients need `clientAuth` from a private CA. A certificate issued before that cutoff stays valid until it expires. Atlas is outside the advisory.

If the CA returns a PKCS#1 key, wrap it with the steps above. The wrap does not change the CA signature. The file names follow the bundle the CA sent.

### Point mongod at the bundle

`net.tls.FIPSMode` is MongoDB Enterprise. A Community binary rejects the option. `net.tls.certificateKeyFile` is the TLS PEM. `PEMKeyFile` belongs under the old `net.ssl` block. If the PKCS#8 key is encrypted, set `certificateKeyFilePassword`. The same PKCS#8 rules apply to `net.tls.clusterFile` when membership uses a separate PEM.

```yaml
net:
    tls:
        mode: requireTLS
        certificateKeyFile: /path/to/certificate/mongodb.pk8
        certificateKeyFilePassword: <passphrase>
        FIPSMode: true
```

Restart `mongod` and look for `FIPS 140-2 mode activated` in `mongod.log`.

`digital envelope routines:EVP_DigestInit_ex:disabled for fips` means the module refused a digest. A SHA-1 or MD5 signature is one cause. It does not mean the key is in the wrong format.

From MongoDB 5.1, FIPS mode leaves SCRAM-SHA-1 disabled unless `authenticationMechanisms` turns it back on. From 8.3, including `SCRAM-SHA-1` while FIPS mode is on fails startup with `SCRAM-SHA-1 is not allowed in FIPS mode`. Use SCRAM-SHA-256, x.509, Kerberos, or LDAP. Kerberos and LDAP are FIPS-compliant only when those external systems are.
