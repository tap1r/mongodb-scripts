# Using gRPC

How to turn on the MongoDB gRPC listener and open one connection to it. Read from the server tree in November 2026. The listener and the shell flag exist only in a Linux build with SSL. A build without that configuration never binds the gRPC port, and its shell has no `--gRPC` flag.

There are two separate switches. Ingress is the listener a client dials. Egress is `mongod` dialing mongot. Enabling one does not enable the other. Replica-set members keep using the wire protocol either way.

## Ingress

The listener starts only when both of these are true:

- `featureFlagGRPC` is `true`. The default is `false`. It is not FCV-gated. Set it at startup with `--setParameter`.
- A TLS certificate is configured: `--tlsCertificateKeyFile`, or a certificate selector where the platform has one.

`tlsMode` has to be a mode that uses that certificate (`allowTLS`, `preferTLS`, or `requireTLS`). TLS enabled also requires `--tlsCAFile` or the system CA store. A certificate, a CA file, or a CRL file with `tlsMode` left `disabled` is rejected at startup. Without the certificate, the server logs id 8076800 and does not bind the port.

```
mongod \
  --setParameter featureFlagGRPC=true \
  --tlsMode preferTLS \
  --tlsCertificateKeyFile server.pem \
  --tlsCAFile ca.crt \
  --grpcPort 27021
```

`--grpcPort` is `net.grpc.port`. The default is 27021. It is a listener option, not a server parameter. The wire port is unchanged. `--grpcServerMaxThreads` (`net.grpc.serverMaxThreads`) caps session threads. The default is 1000.

The same options apply to `mongos`.

When the gRPC server starts, these TLS settings are rejected:

- `--tlsCRLFile`
- `--tlsCertificateKeyFilePassword`
- `--tlsFIPSMode`

`tlsDisabledProtocols` is ignored for gRPC connections. The server also binds the gRPC unix-domain socket unless `--nounixsocket` is set.

`serverStatus().gRPC.ingress` is present once the listener is up.

## A client

The legacy `mongo` shell from that same Linux SSL build is the client that speaks gRPC. mongosh and the database tools do not. Point the shell at the gRPC port, not the wire port, and give it the CA that signed the server certificate.

```
mongo --gRPC --tls --tlsCAFile ca.crt --host 127.0.0.1 --port 27021
```

With `--gRPC` and no host, the shell uses port 27021 on its own. The host has to match a name on the server certificate. A certificate issued for `localhost` and `127.0.0.1` rejects any other address.

`--gRPC` turns on an egress gRPC transport in the shell and sets `gRPC=true` on the connection it opens at startup. Authentication is the shell's normal authentication over that stream.

A later `new Mongo(uri)` uses gRPC only when that URI sets `gRPC=true`. `--nodb` skips the startup connection. The egress transport is still started when `--gRPC` was passed.

`--gRPC` conflicts with `--tlsCRLFile`, `--tlsDisabledProtocols`, `--tlsFIPSMode`, and `--tlsCertificateKeyFilePassword`. It accepts `--tlsCAFile`.

In the shell, `db.getMongo().isGRPC()` is true on a gRPC connection.

## Egress to mongot

This path does not accept the shell. It switches the search executors from the wire protocol to gRPC.

```
mongod \
  --setParameter featureFlagEgressGrpcForSearch=true \
  --setParameter useGrpcForSearch=true \
  --setParameter mongotHost=localhost:27028 \
  --setParameter searchIndexManagementHostAndPort=localhost:27028 \
  --setParameter searchTLSMode=disabled
```

`featureFlagEgressGrpcForSearch` defaults to `true`. `useGrpcForSearch` defaults to `false` and is startup-only. The live name is `useGrpcForSearch`. `mongotHost` and `searchIndexManagementHostAndPort` must be mongot's gRPC port. `searchTLSMode=disabled` matches a plaintext mongot listener. `preferTLS` and `requireTLS` turn TLS on and then require a certificate. `globalTLS` follows `mongod`'s TLS mode.

`mongotConnectionPoolMinSize` and `mongotConnectionPoolMaxSize` have no effect while `useGrpcForSearch` is true.
