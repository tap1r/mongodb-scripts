# Procedure for (re)generating FIPS compliant certificates

## NOTE

These steps are designed to augment the existing SSL certificate generation steps
(<https://docs.mongodb.com/manual/tutorial/configure-ssl/#certificate-authorities)>
and the FIPS configuration guide found (<https://docs.mongodb.com/manual/tutorial/configure-fips/).>

## OVERVIEW

FIPS 140-2 is crypto enhancement designed to meet the Federal Information Processing Standard (FIPS).  A FIPS compliant certificate is
similar to a regular X.509 certificate, but with hardened crypto options.  Specifically these include:

- A certificate with a minimum cipher suite (ie no old compromised ciphers)
- A private key (or cert bundle) with an "up armoured" PEM format, such as PKCS8/12 that supports private key encryption and hashing for a FIPS compliant cipher (not the default MD5)

Knowing these key requirements, should guide both the FIPS certificate generation and troubleshooting processes.

Please ensure you have a FIPS compliant version of _`openssl`_ when running these commands.  A couple of possible ways to test for FIPS capability could include:

1. Run _`openssl version`_, the system returns: _`OpenSSL 1.0.1e-fips 11 Feb 2013`_ or similar denoting FIPS capability
1. Check if _`openssl`_ is operating under FIPS mode, issue the following:

```bash
env OPENSSL_FIPS=1 openssl md5 somefile
```

The above should fail as MD5 is not a FIPS approved hash standard.

```bash
env OPENSSL_FIPS=1 openssl sha1 somefile
```

The above would work as SHA1 is the FIPS approved hash standard.

### Example

```bash
$ env OPENSSL_FIPS=1 openssl md5 message.txt
Error setting digest md5
140062425388872:error:060800A3:digital envelope routines:EVP_DigestInit_ex:disabled for fips:digest.c:251:

$ env OPENSSL_FIPS=1 openssl sha1 message.txt 
SHA1(message.txt)= 9f5080758dbf71537cc44a4d8cb67564f2ad938a
```

### Generating a new self-signed FIPS cert

Here is the generation of a standard (non-FIPS) MD5 hashed key and SHA-1 (FIPS) re-signing operation performed
in a single step:

```bash
openssl req -newkey rsa:2048 -new -x509 -days 3650 -nodes -subj "/C=US/ST=test/L=test/O=test Security/OU=IT Department/CN=test.com" -out mongodb-cert.crt -keyout mongodb-cert.key

cat mongodb-cert.key mongodb-cert.crt > mongodb.pk8
```

### Re-generating from an existing non-FIPS compliant cert

If using an older (PKCS#1) non-FIPS certificate, re-hash the private key with:

1. Re-hash the existing CA bundle _`mongodb-cert.pem`_ to create a new key file _`mongodb-pk8.key`_

   ```bash
   openssl pkcs8 -nocrypt -topk8 -v2 aes-256-cbc -in mongodb-cert.pem -out mongodb-pk8.key
   ```

1. Recombine the existing certificate _`mongodb-cert.pem`_ with the new key _`mongodb-pk8.key`_ to create a new _`pkcs8`_ bundle

   ```bash
   cat mongodb-pk8.key mongodb-cert.pem > mongodb.pk8
   ```

### Generating a new CA signed FIPS compliant cert

These options are subject to the CA provider.  If the CA does not offer FIPS compliant certs, you can simply rehash them:

1. Request the CSR and generate the cert as per normal with your CA provider
1. Taking the signed CA bundle from the CA, use the steps above "Re-generating from existing a non-FIPS compliant cert" to rehash the private key

The names, key and certificate location will vary accroding to how the CA provider presents the bundle, adjust the syntax as required.

### Update any CA path changes

1. Update the _`mongod.conf`_ parameter to reflect the new certificate bundle name (if changed):

   ```yaml
   PEMKeyFile: /path/to/cert/mongodb.pk8
   ```

1. Restart the _`mongod`_ and check the _`mongod.log`_ for adherence to the new FIPS parameters. The error "_`digital envelope routines:EVP_DigestInit_ex:disabled for fips`_" may be found in the _`mongod.log`_ startup messages when a non-FIPS certificate is used with FIPS mode enabled.
