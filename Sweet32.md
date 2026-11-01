# Sweet32

**Historical reference.** DES and 3DES are obsolete TLS ciphers. TLS 1.3 has no 64-bit block suites. NIST disallowed three-key TDEA encryption after 31 December 2023. Current JDKs disable `3DES_EDE_CBC`, and a current Ops Manager already refuses the legacy 3DES and DES suites in the default `mms.disableCiphers`. The deny list and the `s_client` samples record what to set, and what a pass or fail looked like, when the Ops Manager Java process could still complete a 3DES handshake. The captured transcript is OpenSSL 1.0 (`TLSv1/SSLv3`). On a current Ops Manager, do not add this list. A probe that finishes with `Cipher is (NONE)` is the expected result.

Sweet32 (CVE-2016-2183) is the birthday attack on those 64-bit block ciphers. The names below are the suites that deny list refused.

They were values for the Ops Manager custom setting `mms.disableCiphers`, a comma-separated **deny** list (RFC 5246 names, not OpenSSL names such as `DES-CBC3-SHA`). Do not paste this string into an enabled-cipher setting. That would leave only these suites.

SSLv2 `SSL_CK_*` names are omitted, as are the non-suite spellings `SSL_RSA_WITH_3DES_CBC_SHA` and `SSL_RSA_WITH_DES_EDE_CBC_SHA`. Ops Manager logs those as unrecognized and does not disable them.

## Java / RFC 5246 names to disable

```text
TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA
TLS_ECDHE_ECDSA_WITH_3DES_EDE_CBC_SHA
TLS_ECDH_RSA_WITH_3DES_EDE_CBC_SHA
TLS_ECDH_ECDSA_WITH_3DES_EDE_CBC_SHA
TLS_RSA_WITH_3DES_EDE_CBC_SHA
TLS_RSA_WITH_DES_CBC_SHA
TLS_DH_DSS_WITH_3DES_EDE_CBC_SHA
TLS_DH_DSS_WITH_DES_CBC_SHA
TLS_DH_RSA_WITH_3DES_EDE_CBC_SHA
TLS_DH_RSA_WITH_DES_CBC_SHA
TLS_DHE_DSS_WITH_3DES_EDE_CBC_SHA
TLS_DHE_DSS_WITH_DES_CBC_SHA
TLS_DHE_RSA_WITH_3DES_EDE_CBC_SHA
TLS_DHE_RSA_WITH_DES_CBC_SHA
```

## Single line for `mms.disableCiphers`

```text
TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA,TLS_ECDHE_ECDSA_WITH_3DES_EDE_CBC_SHA,TLS_ECDH_RSA_WITH_3DES_EDE_CBC_SHA,TLS_ECDH_ECDSA_WITH_3DES_EDE_CBC_SHA,TLS_RSA_WITH_3DES_EDE_CBC_SHA,TLS_RSA_WITH_DES_CBC_SHA,TLS_DH_DSS_WITH_3DES_EDE_CBC_SHA,TLS_DH_DSS_WITH_DES_CBC_SHA,TLS_DH_RSA_WITH_3DES_EDE_CBC_SHA,TLS_DH_RSA_WITH_DES_CBC_SHA,TLS_DHE_DSS_WITH_3DES_EDE_CBC_SHA,TLS_DHE_DSS_WITH_DES_CBC_SHA,TLS_DHE_RSA_WITH_3DES_EDE_CBC_SHA,TLS_DHE_RSA_WITH_DES_CBC_SHA
```

## Validate with OpenSSL `s_client`

Port 8443 is the Ops Manager application. `-cipher 3DES` forces the client to offer only 64-bit block suites. OpenSSL 1.0 printed `TLSv1/SSLv3` in the samples below. OpenSSL 3 prints `TLSv1.2` and the same `Cipher is` line.

```bash
openssl s_client -connect host.mongodb.net:8443 -cipher 3DES < /dev/null | grep "Cipher is"
```

Fail. The handshake completed and 3DES is still accepted:

```text
depth=0 C = US, ST = test, L = test, O = test Security, OU = IT Department, CN = ec2-52-65-116-16.ap-southeast-2.compute.amazonaws.com
verify error:num=18:self signed certificate
verify return:1
depth=0 C = US, ST = test, L = test, O = test Security, OU = IT Department, CN = ec2-52-65-116-16.ap-southeast-2.compute.amazonaws.com
verify return:1
DONE
New, TLSv1/SSLv3, Cipher is ECDHE-RSA-DES-CBC3-SHA
```

Pass. The server refused 3DES (`Cipher is (NONE)`):

```text
140736192898056:error:14077410:SSL routines:SSL23_GET_SERVER_HELLO:sslv3 alert handshake failure:s23_clnt.c:802:
New, (NONE), Cipher is (NONE)
```
