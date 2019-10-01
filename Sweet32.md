# Sweet32

## Java-format cipher list to prevent Sweet32

```text
TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA
SSL_RSA_WITH_DES_CBC_SHA
SSL_RSA_WITH_3DES_CBC_SHA
SSL_RSA_WITH_DES_EDE_CBC_SHA
SSL_RSA_WITH_3DES_EDE_CBC_SHA
SSL_DSS_WITH_DES_CBC_SHA
SSL_DSS_WITH_3DES_CBC_SHA
SSL_DH_DSS_WITH_DES_EDE_CBC_SHA
SSL_DH_DSS_WITH_3DES_EDE_CBC_SHA
SSL_DH_RSA_WITH_DES_EDE_CBC_SHA
SSL_DH_RSA_WITH_3DES_EDE_CBC_SHA
SSL_DHE_DSS_WITH_DES_EDE_CBC_SHA
SSL_DHE_DSS_WITH_3DES_EDE_CBC_SHA
SSL_DHE_RSA_WITH_DES_EDE_CBC_SHA
SSL_DHE_RSA_WITH_3DES_EDE_CBC_SHA
SSL_CK_DES_64_CBC_WITH_SHA
SSL_CK_DES_192_EDE3_CBC_WITH_SHA
```

## Single line format suitable for the Ops Manager cipher list

```text
TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA,SSL_RSA_WITH_DES_CBC_SHA,SSL_RSA_WITH_3DES_CBC_SHA,SSL_RSA_WITH_DES_EDE_CBC_SHA,SSL_RSA_WITH_3DES_EDE_CBC_SHA,SSL_DSS_WITH_DES_CBC_SHA,SSL_DSS_WITH_3DES_CBC_SHA,SSL_DH_DSS_WITH_DES_EDE_CBC_SHA,SSL_DH_DSS_WITH_3DES_EDE_CBC_SHA,SSL_DH_RSA_WITH_DES_EDE_CBC_SHA,SSL_DH_RSA_WITH_3DES_EDE_CBC_SHA,SSL_DHE_DSS_WITH_DES_EDE_CBC_SHA,SSL_DHE_DSS_WITH_3DES_EDE_CBC_SHA,SSL_DHE_RSA_WITH_DES_EDE_CBC_SHA,SSL_DHE_RSA_WITH_3DES_EDE_CBC_SHA,SSL_CK_DES_64_CBC_WITH_SHA,SSL_CK_DES_192_EDE3_CBC_WITH_SHA
```

## Validate cipher handshaking with the OpenSSL _`s_client`_ test

Command:

```bash
openssl s_client -connect host.mongodb.net:8443 -cipher 3DES < /dev/null | grep Cipher\ is
```

Test fail (sweet32 is detected):

```text
depth=0 C = US, ST = test, L = test, O = test Security, OU = IT Department, CN = ec2-52-65-116-16.ap-southeast-2.compute.amazonaws.com
verify error:num=18:self signed certificate
verify return:1
depth=0 C = US, ST = test, L = test, O = test Security, OU = IT Department, CN = ec2-52-65-116-16.ap-southeast-2.compute.amazonaws.com
verify return:1
DONE
New, TLSv1/SSLv3, Cipher is ECDHE-RSA-DES-CBC3-SHA
```

Test pass (sweet32 is detected):

```text
140736192898056:error:14077410:SSL routines:SSL23_GET_SERVER_HELLO:sslv3 alert handshake failure:s23_clnt.c:802:
New, (NONE), Cipher is (NONE)
```
