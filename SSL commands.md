# Uber list of useful OpenSSL commands

## **Crypto health check**

* **Update OpenSSL (OSX)**

  ```bash
  brew update && brew upgrade openssl
  ```

* **Update OpenSSL (Linux)**

  ```bash
  sudo yum upgrade openssl
  ```

* **CA trust store update (Linux)**

  ```bash
  sudo update-ca-certificates --fresh
  sudo rm -f /etc/ssl/certs/ca-certificates.crt
  sudo update-ca-trust
  sudo /usr/local/opt/openssl/bin/c_rehash
  ```

## **Using certificates with MongoDB**

* **_mlaunch_ tips for _clusterauth_**

  ```bash
  mlaunch init --replicaset --hostname localhost --sslMode preferSSL --sslCAFile /tmp/server.pk8 --sslPEMKeyFile /tmp/server.pk8 --sslClusterFile /tmp/server.pk8 --sslClientCertificate /tmp/server.pk8 --auth
  ```

* **FIPS compliance**

  Restart the _`mongod`_ and check the _`mongod.log`_ for adherence to the new FIPS parameters. The error "_`digital envelope routines:EVP_DigestInit_ex:disabled for fips`_" may be found in the _`mongod.log`_ startup messages when a non-FIPS certificate is used with FIPS mode enabled.

## **Generating common use certificates**

* **Self-signed certificate with FIPS compliance (PKCS#8 format)**

  ```bash
  openssl req \
   -x509 \
   -newkey rsa:2048 \
   -nodes \
   -days 3650 \
   -keyout private.key \
   -out server.crt \
   -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com"

  cat server.crt private.key > server.pk8
  openssl x509 -in server.pk8 -noout -subject
  ```

* **Self-signed certificate with FIPS compliance (PKCS#8 format) with SAN and EKU attributes**

  ```bash
  openssl req \
    -newkey rsa:2048 \
    -days 3650 \
    -nodes \
    -x509 \
    -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com" \
    -extensions my_ext \
    -config <(printf "\
      [req]\n\
      distinguished_name=req_dn\n\
      [req_dn]\n\
      [my_ext]\n\
      subjectAltName=DNS.1:*.mongodb.com,DNS.2:*.mongodb.net,IP.1:127.0.0.1,IP.2:192.0.2.1\n\
      extendedKeyUsage=serverAuth,clientAuth") \
    -keyout private.key \
    -out server.crt

  cat server.crt private.key > server.pk8

  openssl x509 -in server.pk8 -noout -subject -purpose -text | grep "subject=\|X509v3\ Subject\ Alternative\ Name:\|DNS:\|IP\ Address:\|X509v3\ Extended\ Key\ Usage:\|TLS\ Web\ Server\ Authentication\|TLS\ Web\ Client\ Authentication"
  ```

* **Elliptic curve (EC) ciphers**

  <https://www.guyrutenberg.com/2013/12/28/creating-self-signed-ecdsa-ssl-certificate-using-openssl/>

## **Certificate format conversion**

* **PEM (_`PKCS#1`_) to PFX/P12 (_`PKCS#12`_) format** (suitable for Microsoft Windows)

  ```bash
  openssl pkcs12 -export -in cert.pem -out cert.p12 -name "My Certificate"
  ```

  -or-

  ```bash
  openssl pkcs12 -export -in cert.pem -out cert.p12 -name "My Certificate bundle" -certfile CA.pem
  ```

* **DER (_`PKCS#1`_) to PEM (_`PKCS#1`_) format**

  ```bash
  openssl x509 -inform der -in cert.der -out cert.pem
  ```

* **PEM (_`PKCS#1`_) to DER (_`PKCS#1`_) format**

  ```bash
  openssl x509 -in cert.pem -outform der -out cert.der
  ```

* **PEM (_`PKCS#1`_) to PK8 (_`PKCS#8`_) format**

  1. Re-hash the existing CA bundle _`cert.pem`_ to create a new key file _`cert.key`_

     ```bash
     openssl pkcs8 -nocrypt -topk8 -v2 aes-256-cbc -in cert.pem -out cert.key
      ```

  2. Recombine the existing certificate _`cert.crt`_ with the new key _`cert.key`_ to create a new _`pk8`_ bundle

     ```bash
     cat cert.key cert.crt > cert.pk8
     ```

* **PFX/P12 (_`PKCS#12`_) to PEM (_`PKCS#1`_)**

  ```bash
  openssl pkcs12 -in cert.p12 -nocerts -nodes -out cert.pem
  ```

## **Reading certificate attributes and validation testing**

### PEM file tests

* **Get full certificate dump from PEM file**

  ```bash
  openssl x509 -in cert.pem -text -noout
  ```

* **Get certificate attribute vitals from PEM file**

  ```bash
  openssl x509 -in cert.pem -noout -subject -issuer -serial -dates -fingerprint -purpose
  ```

* **Get certificate SAN attributes from PEM file**

  ```bash
  openssl s_client -connect host.mongodb.net:27017 < /dev/null | openssl x509 -noout -text | grep DNS:
  ```

### TLS server tests

* **Get full certificate dump from TLS server**

  ```bash
  openssl s_client -connect host.mongodb.net:27017 < /dev/null | openssl x509 -text
  ```

* **Get certificate attribute vitals from TLS server**

  ```bash
  openssl s_client -connect host.mongodb.net:27017 < /dev/null | openssl x509 -noout -subject -issuer -serial -dates -fingerprint -purpose
  ```

* **Get certificate SAN attributes from TLS server**

  ```bash
  openssl s_client -connect host.mongodb.net:27017 < /dev/null | openssl x509 -noout -text | grep DNS:
  ```

### Certificate validation tests

* **Verify the certificate against the CA**

  ```bash
  openssl verify -CAfile ca.pem cert.pem
  ```

* **Verify CA root chain from PEM files**

  ```bash
  openssl verify -CAfile RootCA.pem -untrusted IntermediateCA.pem cert.pem
  ```

## **Cipher handshaking tests against TLS server**

* **_NMAP_ script**

  ```bash
  nmap --script +ssl-enum-ciphers -Pn host.mongodb.net -p 27017
  ```

* **s_client _bash_ script**

  ```bash
  #!/bin/bash
  for v in ssl2 ssl3 tls1 tls1_1 tls1_2 tls1_3; do
    for c in $(openssl ciphers 'ALL:eNULL' | tr ':' ' '); do
      openssl s_client -connect host.mongodb.net:27017 \
        -cipher $c -$v < /dev/null > /dev/null 2>&1 && echo -e "$v:\t$c"
    done
  done
  ```

## **x509 _clusterauth_ and client authentication**

* **Validate client certificate purpose from PEM file**

  ```bash
  openssl verify -verbose -CAfile CA.pem -purpose sslclient ClientCert.pem
  ```

* **Validate server certificate purpose from PEM file**

  ```bash
  openssl verify -verbose -CAfile CA.pem -purpose sslserver ServerCert.pem
  ```

* **Validate _clusterauth_ certificate purpose from PEM file**

  ```bash
  openssl verify -verbose -CAfile CA.pem -purpose sslclient ClientCert.pem
  openssl verify -verbose -CAfile CA.pem -purpose sslserver ServerCert.pem
  ```

## **_SChannel_ (Windows) tests**

* **Enabling TLS cipher suites via registry**

  ```re
  Windows Registry Editor Version 5.00
  
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\Schannel\Protocols\TLS 1.0]
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\Schannel\Protocols\TLS 1.0\Client]
  "DisabledByDefault"=dword:00000001
  "Enabled"=dword:00000000
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\Schannel\Protocols\TLS 1.0\Server]
  "DisabledByDefault"=dword:00000001
  "Enabled"=dword:00000000
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\Schannel\Protocols\TLS 1.1]
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\Schannel\Protocols\TLS 1.1\Client]
  "DisabledByDefault"=dword:00000000
  "Enabled"=dword:00000001
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\Schannel\Protocols\TLS 1.1\Server]
  "DisabledByDefault"=dword:00000000
  "Enabled"=dword:00000001
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2]
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client]
  "DisabledByDefault"=dword:00000000
  "Enabled"=dword:00000001
  [HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Server]
  "DisabledByDefault"=dword:00000000
  "Enabled"=dword:00000001
  ```

* **Test cipher suites**

  PowerShell 5.1

  ```powershell
  PS> [Net.ServicePointManager]::SecurityProtocol Ssl3, Tls
  PS> Invoke-WebRequest -UseBasicParsing -Method Head https://microsoft.github.io | fl Status*
  Invoke-WebRequest : The request was aborted: Could not create SSL/TLS secure channel.
  
  PS> [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls `
                                                    -bor [Net.SecurityProtocolType]::Tls11 `
                                                    -bor [Net.SecurityProtocolType]::Tls12
  PS> [Net.ServicePointManager]::SecurityProtocol Tls, Tls11, Tls12
  
  PS> Invoke-WebRequest -UseBasicParsing -Method Head https://microsoft.github.io | fl Status*
  
  StatusCode        : 200
  StatusDescription : OK
  ```

  PowerShell 6 (beta)

  ```powershell
  PS C:\Program Files\PowerShell\6-preview> Invoke-WebRequest https://microsoft.github.io -SslProtocol Tls12 | ft Status*

  StatusCode StatusDescription
  ---------- -----------------
         200 OK


  PS C:\Program Files\PowerShell\6-preview> Invoke-WebRequest https://microsoft.github.io | ft Status*

  StatusCode StatusDescription
  ---------- -----------------
         200 OK
  ```

## **_SecureTransport_ (OSX) tests**

<https://developer.apple.com/library/archive/samplecode/sc1236/Introduction/Intro.html>

* TLSTool
* nscurl -h
