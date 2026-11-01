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
  mlaunch init --replicaset --hostname localhost --tlsMode preferTLS --tlsCAFile server.pk8 --tlsClusterFile server.pk8 --tlsCertificateKeyFile server.pk8 --auth
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
   -days 397 \
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
    -days 397 \
    -nodes \
    -x509 \
    -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com" \
    -extensions my_ext \
    -config <(printf "\
      [req]\n\
      distinguished_name=req_dn\n\
      [req_dn]\n\
      [my_ext]\n\
      subjectAltName=DNS.1:*.mongodb.com,DNS.2:*.mongodb.net,IP.1:127.0.0.1,IP.2:::1,IP.3:192.0.2.1\n\
      extendedKeyUsage=serverAuth,clientAuth") \
    -keyout private.key \
    -out server.crt

  cat server.crt private.key > server.pk8

  openssl x509 -in server.pk8 -noout -text | grep "Subject:\|X509v3\ Subject\ Alternative\ Name:\|DNS:\|IP\ Address:\|X509v3\ Extended\ Key\ Usage:\|TLS\ Web\ Server\ Authentication\|TLS\ Web\ Client\ Authentication"
  ```

* **Elliptic curve ciphers (ECC) with FIPS compliance (PKCS#8 format)**

  ```bash
  openssl req \
   -x509 \
   -newkey ec:<(openssl ecparam -name secp521r1) \
   -nodes \
   -days 397 \
   -keyout private.key \
   -out server.crt \
   -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com"

  cat server.crt private.key > server.pk8
  openssl x509 -in server.pk8 -noout -subject
  ```

* **Elliptic curve ciphers (ECC) with FIPS compliance (PKCS#8 format) with SAN and EKU attributes**

  ```bash
  openssl req \
   -x509 \
   -newkey ec:<(openssl ecparam -name secp521r1) \
   -nodes \
   -days 397 \
   -keyout private.key \
   -out server.crt \
   -subj "/C=US/ST=New York/L=New York/O=MongoDB, Inc./OU=Technical Services/CN=*.mongodb.com" \
    -extensions my_ext \
    -config <(printf "\
      [req]\n\
      distinguished_name=req_dn\n\
      [req_dn]\n\
      [my_ext]\n\
      subjectAltName=DNS.1:*.mongodb.com,DNS.2:*.mongodb.net,IP.1:127.0.0.1,IP.2:::1,IP.3:192.0.2.1\n\
      extendedKeyUsage=serverAuth,clientAuth") \
    -keyout private.key \
    -out server.crt

  cat server.crt private.key > server.pk8

  openssl x509 -in server.pk8 -noout -text | grep "Subject:\|X509v3\ Subject\ Alternative\ Name:\|DNS:\|IP\ Address:\|X509v3\ Extended\ Key\ Usage:\|TLS\ Web\ Server\ Authentication\|TLS\ Web\ Client\ Authentication"
  ```

## **Certificate format conversion**

* **PEM (_`PKCS#1`_) to PFX/P12 (_`PKCS#12`_) format** (suitable for Microsoft Windows)

  ```bash
  openssl pkcs12 -export -in cert.pem -out cert.p12 -name "My Certificate"
  ```

  -or-

  ```bash
  openssl pkcs12 -export -in cert.pem -out cert.p12 -name "My Certificate bundle" -certfile ca.pem
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

## Atlas CA (Let's Encrypt and Google Trust Services)

Atlas signs cluster certificates with Let's Encrypt and Google Trust Services at the same time. Trust the roots, not an intermediate. The DST Root CA X3 / Let's Encrypt X3 chain expired in 2021.

A current JRE trust store already has these roots (Java 7u391 / 8u381 and later, and builds after 18 July 2023). Import them only into a custom trust store that does not use the JRE `cacerts`. GTS Root R3 and R4 are what Atlas uses for TLS 1.3. R1, R2, and ISRG Root X1 are still required. See the [Atlas security FAQ](https://www.mongodb.com/docs/atlas/reference/faq/security/).

```bash
curl -fsSL -o isrgrootx1.pem https://letsencrypt.org/certs/isrgrootx1.pem
curl -fsSL -o gtsr1.pem https://pki.goog/repo/certs/gtsr1.pem
curl -fsSL -o gtsr2.pem https://pki.goog/repo/certs/gtsr2.pem
curl -fsSL -o gtsr3.pem https://pki.goog/repo/certs/gtsr3.pem
curl -fsSL -o gtsr4.pem https://pki.goog/repo/certs/gtsr4.pem

keytool -importcert -noprompt -trustcacerts -file isrgrootx1.pem -keystore /path/to/keystore.jks -alias "ISRG Root X1"
keytool -importcert -noprompt -trustcacerts -file gtsr1.pem -keystore /path/to/keystore.jks -alias "GTS Root R1"
keytool -importcert -noprompt -trustcacerts -file gtsr2.pem -keystore /path/to/keystore.jks -alias "GTS Root R2"
keytool -importcert -noprompt -trustcacerts -file gtsr3.pem -keystore /path/to/keystore.jks -alias "GTS Root R3"
keytool -importcert -noprompt -trustcacerts -file gtsr4.pem -keystore /path/to/keystore.jks -alias "GTS Root R4"
```

## Atlas CA (legacy DigiCert CA)

Historical. Atlas no longer serves this chain.

Acquire the Digicert Root ([DigiCert Global Root CA](https://dl.cacerts.digicert.com/DigiCertGlobalRootCA.crt)) and Intermediate CA ([DigiCert SHA2 Secure Server CA](https://dl.cacerts.digicert.com/DigiCertSHA2SecureServerCA.crt)) certificates employed by Atlas.

Convert Digicert DER to PEM for convenience:

```bash
openssl x509 -inform der -in DigiCertGlobalRootCA.crt -out DigiCertGlobalRootCA.pem
openssl x509 -inform der -in DigiCertSHA2SecureServerCA.crt -out DigiCertSHA2SecureServerCA.pem
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

* **Get certificate SAN and EKU attributes from PEM file**

  ```bash
  openssl x509 -in cert.pem -noout -text | grep "Subject:\|X509v3\ Subject\ Alternative\ Name:\|DNS:\|IP\ Address:\|X509v3\ Extended\ Key\ Usage:\|TLS\ Web\ Server\ Authentication\|TLS\ Web\ Client\ Authentication"
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

* **Get certificate SAN and EKU attributes from TLS server**

  ```bash
  openssl s_client -connect host.mongodb.net:27017 < /dev/null | openssl x509 -noout -text | grep "subject=\|Subject:\|X509v3\ Subject\ Alternative\ Name:\|DNS:\|IP\ Address:\|X509v3\ Extended\ Key\ Usage:\|TLS\ Web\ Server\ Authentication\|TLS\ Web\ Client\ Authentication"
  ```

### Certificate validation tests

* **Verify a certificate PEM against the CA**

  ```bash
  openssl verify -CAfile ca.pem cert.pem
  ```

* **Verify the server certificate against the CA via TLS**

  `openssl verify` needs a PEM. `openssl x509 -text` is a text dump, so do not pipe that into `verify`.

  ```bash
  openssl s_client -connect host.mongodb.net:27017 < /dev/null 2>/dev/null \
    | openssl x509 -outform PEM > /tmp/server.pem
  openssl verify -CAfile ca.pem /tmp/server.pem
  ```

* **Verify CA root chain from PEM files**

  ```bash
  openssl verify -CAfile RootCA.pem -untrusted IntermediateCA.pem cert.pem
  ```

## **Cipher handshaking tests against TLS server**

* **_nmap_ script**

  ```bash
  nmap --script +ssl-enum-ciphers -Pn host.mongodb.net -p 27017
  ```

* **_s_client_ bash script**

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
  openssl verify -verbose -CAfile ca.pem -purpose sslclient ClientCert.pem
  ```

* **Validate server certificate purpose from PEM file**

  ```bash
  openssl verify -verbose -CAfile ca.pem -purpose sslserver ServerCert.pem
  ```

* **Validate _clusterauth_ certificate purpose from PEM file**

  ```bash
  openssl verify -verbose -CAfile ca.pem -purpose sslclient ClientCert.pem
  openssl verify -verbose -CAfile ca.pem -purpose sslserver ServerCert.pem
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

  PowerShell 6.0 (beta)

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

  ```powershell
  add-type @"
  using System.Net;
  using System.Security.Cryptography.X509Certificates;
  public class TrustAllCertsPolicy: ICertificatePolicy {
      public bool CheckValidationResult(
          ServicePoint srvPoint, X509Certificate certificate,
          WebRequest request, int certificateProblem) {
          return true;
      }
  }
  "@
  $AllProtocols = [System.Net.SecurityProtocolType] 'Ssl3,Tls,Tls11,Tls12'
  [System.Net.ServicePointManager]::SecurityProtocol = $AllProtocols
  [System.Net.ServicePointManager]::CertificatePolicy = New - Object TrustAllCertsPolicy
  ```

  ```powershell
  function Test-ServerSSLSupport {
      [CmdletBinding()]
          param(
          [Parameter(Mandatory = $true, ValueFromPipeline = $true)]
          [ValidateNotNullOrEmpty()]
          [string]$HostName,
          [UInt16]$Port = 27017
      )
      process {
          $RetValue = New-Object psobject -Property @{
              Host = $HostName
              Port = $Port
              SSLv2 = $false
              SSLv3 = $false
              TLSv1_0 = $false
              TLSv1_1 = $false
              TLSv1_2 = $false
              KeyExhange = $null
              HashAlgorithm = $null
          }
          “ssl2”, “ssl3”, “tls”, “tls11”, “tls12” | %{
              $TcpClient = New-Object Net.Sockets.TcpClient
              $TcpClient.Connect($RetValue.Host, $RetValue.Port)
              $SslStream = New-Object Net.Security.SslStream $TcpClient.GetStream()
              $SslStream.ReadTimeout = 15000
              $SslStream.WriteTimeout = 15000
              try {
                  $SslStream.AuthenticateAsClient($RetValue.Host,$null,$_,$false)
                  $RetValue.KeyExhange = $SslStream.KeyExchangeAlgorithm
                  $RetValue.HashAlgorithm = $SslStream.HashAlgorithm
                  $status = $true
              } catch {
                  $status = $false
              }
              switch ($_) {
                  “ssl2” {$RetValue.SSLv2 = $status}
                  “ssl3” {$RetValue.SSLv3 = $status}
                  “tls” {$RetValue.TLSv1_0 = $status}
                  “tls11” {$RetValue.TLSv1_1 = $status}
                  “tls12” {$RetValue.TLSv1_2 = $status}
              }
              # dispose objects to prevent memory leaks
              # $TcpClient.Dispose()
              # $SslStream.Dispose()
          }
          $RetValue
          “From “+ $TcpClient.client.LocalEndPoint.address.IPAddressToString +” to $hostname “+ $TcpClient.client.RemoteEndPoint.address.IPAddressToString +’:’+$TcpClient.client.RemoteEndPoint.port
          $SslStream |gm |?{$_.MemberType -match ‘Property’}|Select-Object Name |%{$_.Name +’: ‘+ $sslStream.($_.name)}
      }
  }

  Test-ServerSSLSupport localhost
  ```

## **_SecureTransport_ (OSX) tests**

<https://developer.apple.com/library/archive/samplecode/sc1236/Introduction/Intro.html>

* TLSTool
* nscurl -h
