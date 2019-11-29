# BI Connector reproductions

This guide aims to provide startup string combinatations for BIC reproduction testing.  Each grouping provides consistent parameters to each of the BIC applications and tools for more common use cases.

## Procedures

Generate a matching command syntax set for _`mysql`_, _`mongosqld`_ and _`mongodrdl`_ based on known use case permutations.

1. Determine the usecase permutation from the parameter combinations:

   - Authentication & SSL
     - No SSL + no _auth_ (_`sslMode=disabled`_)
     - SSL + no _auth_ (_`sslMode=allowSSL`_)
     - No SSL + _auth_ (_`sslMode=disabled`_ + _`mongosql_auth`_)
     - SSL + _auth_ (_`sslMode=requireSSL`_ + _`CLEARTEXT`_ / _`sslMode=allowSSL`_ + _`mongosql_auth`_)

   - Connection options and Read Preferences
     - Replica set with Primary (default)
     - Secondary Preferred
     - Direct Connect

   - Sampling options
     - No sampling / DRDL schema
     - Sampling
     - Shared schema

2. Select one sub-template from the three template types (_auth/ssl_ + _options_ + _sampling_) to create the desired permutations

   - _auth/ssl_
     - No SSL + no _auth_ (_`sslMode=disabled`_)
     - SSL + no _auth_ (_`sslMode=allowSSL`_)
     - No SSL + _auth_ (_`sslMode=disabled`_ + _`mongosql_auth`_)
     - SSL + _auth_ (_`sslMode=requireSSL`_ + _`CLEARTEXT`_ / _`sslMode=allowSSL`_ + _`mongosql_auth`_)

   - _options_
     - Replica set with Primary (default)
     - Secondary Preferred
     - Direct Connect

   - _sampling_
     - No sampling / DRDL schema
     - Sampling
     - Shared schema

3. Substitute for the given parameters in the use case template where required:

   - _`{host}`_ (_`db1.example.net:27017`_ format)
   - _`{uri}`_ (_`mongodb://db1.example.net,db2.example.net:27017/?replicaSet=rs0`_ format)
   - _`{srv}`_ (_`mongodb+srv://srv.example.net/`_ format)
   - _`{bi_host}`_ (_`bic.example.net`_ format)
   - _`{bi_user}`_ (end user)
   - _`{bi_passwd}`_
   - _`{admin_user}`_ (sampling user)
   - _`{admin_passwd}`_

   Assumed defaults include:

   - _`--schema schema.drdl`_ (DRDL filename)
   - _`--sslCAFile=mongodb.pk8`_ (SSL CA file)
   - _`--sslPEMKeyFile=mongodb.pk8`_ (SSL Server PEM)
   - _`--mongo-authenticationSource admin`_ (_authdb_)
   - _`--plugin_dir=/usr/local/lib/mysql/plugin/`_ (C-auth-plugin installation directory)
   - _`-vv`_ (verbosity)
   - _`--addr 0.0.0.0:3307`_
   - _`--sslAllowInvalidCertificates`_ ([self-signed certificates](SSL%20commands.md#generating-common-use-certificates) are assumed, remove for PKI/Atlas use if desired)

## Connection strings (-SSL -auth)

### _mongosqld_

```bash
mongosqld ...
```

### _mongodrdl_

```bash
mongodrdl ...
```

### _mysql_

```bash
mysql --host {bi_host} --protocol tcp --port 3307
```

## Connection strings (+SSL -auth)

```bash
mysql --host {bi_host} --protocol tcp --port 3307 --ssl-mode=REQUIRED --ssl-ca mongodb.pk8 --enable-cleartext-plugin -u {bi_user} -p
```

### _mongosqld_

```bash
mongosqld ...
```

### _mongodrdl_

```bash
mongodrdl ...
```

### _mysql_

```bash
mysql ...
```

## Connection strings (-SSL +auth)

```bash
mysql --host {bi_host} --protocol tcp --port 3307 --ssl-mode=DISABLED --default-auth=mongosql_auth --plugin_dir=/usr/local/lib/mysql/plugin/ -u {bi_user} -p
```

```bash
mysql --host {bi_host} --protocol tcp --port 3307 --ssl-mode=DISABLED --default-auth=mongosql_auth -u {bi_user} -p
```

### _mongosqld_

```bash
mongosqld ...
```

### _mongodrdl_

```bash
mongodrdl ...
```

### _mysql_

```bash
mysql ...
```

## Connection strings (+SSL +auth)

```bash
mysql --host {bi_host} --protocol tcp --port 3307 --ssl-mode=DISABLED --default-auth=mongosql_auth --plugin_dir=/usr/local/lib/mysql/plugin/ -u {bi_user} -p
```

```bash
mysql --host {bi_host} --protocol tcp --port 3307 --ssl-mode=DISABLED --default-auth=mongosql_auth -u {bi_user} -p
```

### _mongosqld_

```bash
mongosqld ...
```

### _mongodrdl_

```bash
mongodrdl ...
```

### _mysql_

```bash
mysql ...
```

## BIC read preferences

```text
--mongo-uri {uri|srv}&readPreference=secondaryPreferred
--mongo-uri {host}/?connect=direct&readPreference=secondaryPreferred
```

## Baseline startup commands

### Atlas with on-prem `mongosqld`

```bash
mongosqld --addr 0.0.0.0:3307 --mongo-uri={srv} --auth --mongo-ssl --sslAllowInvalidCertificates --sslCAFile=mongodb.pk8 --sslPEMKeyFile=mongodb.pk8 --sslMode=allowSSL --mongo-authenticationSource admin -u {user} -p {passwd} -vv
```

## Legacy sampling modes

### Persistent sampler (shared schema)

```bash
mongosqld --addr 0.0.0.0:3307 --sampleMode=write --sampleSource=drdl --mongo-uri {uri} --auth --mongo-ssl --sslAllowInvalidCertificates --sslCAFile=mongodb.pk8 --sslPEMKeyFile=mongodb.pk8 --sslMode=allowSSL --mongo-authenticationSource admin -u {user} -p {passwd} -vv
```

### Read sampler

```bash
mongosqld --addr 0.0.0.0:3307 --mongo-uri {uri} --auth --mongo-ssl --sslAllowInvalidCertificates --sslCAFile=mongodb.pk8 --sslPEMKeyFile=mongodb.pk8 --sslMode=allowSSL --mongo-authenticationSource admin -u {user} -p {passwd} -vv
```

### DRDL

```bash
mongosqld --schema schema.drdl --addr 0.0.0.0:3307 --mongo-uri {uri} --auth --mongo-ssl --sslAllowInvalidCertificates --sslCAFile=mongodb.pk8 --sslPEMKeyFile=mongodb.pk8 --sslMode=allowSSL -u={user} -u={passwd} -vv
```
