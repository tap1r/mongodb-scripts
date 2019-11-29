# BI Connector reproductions (valid for v2.13.1)

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
   - _`--addr 0.0.0.0:3307`_ (bind IP)

## Usecase permutation (-SSL -auth)

### _mongosqld_ startup parameters

   ```bash
   mongosqld --addr 0.0.0.0:3307 --mongo-uri {uri} -vv
   ```

### _mysql_ connection string

   ```bash
   mysql --host {bi_host} --port 3307 --protocol tcp --ssl-mode=DISABLED
   ```

## Usecase permutation (+SSL -auth)

### _mongosqld_ startup parameters

   ```bash
   mongosqld --addr 0.0.0.0:3307 --mongo-uri {uri} --mongo-ssl --mongo-sslCAFile=mongodb.pk8 --sslCAFile=mongodb.pk8 --sslPEMKeyFile=mongodb.pk8 --sslMode=allowSSL -vv
   ```

### _mysql_ connection string

   ```bash
   mysql --host {bi_host} --port 3307 --protocol tcp --ssl-mode=REQUIRED --ssl-ca mongodb.pk8
   ```

## Usecase permutation (-SSL +auth)

### _mongosqld_ startup parameters

   ```bash
   mongosqld --addr 0.0.0.0:3307 --mongo-uri {uri} --auth --mongo-authenticationSource admin -vv -u {user} -p {passwd}
   ```

### _mysql_ connection string

   ```bash
   mysql --host {bi_host} --port 3307 --protocol tcp --ssl-mode=DISABLED --default-auth=mongosql_auth --plugin_dir=/usr/local/lib/mysql/plugin/ -u {bi_user} -p
   ```

## Usecase permutation (+SSL +auth)

### _mongosqld_ startup parameters

   ```bash
   mongosqld --addr 0.0.0.0:3307 --mongo-uri {uri} --auth --mongo-ssl --mongo-sslCAFile=mongodb.pk8 --sslCAFile=mongodb.pk8 --sslPEMKeyFile=mongodb.pk8 --sslMode=allowSSL --mongo-authenticationSource admin -vv -u {user} -p {passwd}
   ```

### _mysql_ connection string

   ```bash
   mysql --host {bi_host} --port 3307 --protocol tcp --ssl-mode=REQUIRED --ssl-ca mongodb.pk8 --default-auth=mongosql_auth --plugin_dir=/usr/local/lib/mysql/plugin/ -u {bi_user} -p
   ```

   -or-

   ```bash
   mysql --host {bi_host} --port 3307 --protocol tcp --ssl-mode=DISABLED --default-auth=mongosql_auth --plugin_dir=/usr/local/lib/mysql/plugin/ -u {bi_user} -p
   ```

   -or-

   ```bash
   mysql --host {bi_host} --port 3307 --protocol tcp --ssl-mode=REQUIRED --ssl-ca mongodb.pk8 --enable-cleartext-plugin -u {bi_user} -p
   ```

## BIC read preferences

To change from the default _Primary_ preference, add either of the following to the _`mongosqld`_ startup parameters:

```text
--mongo-uri {uri|srv}&readPreference=secondaryPreferred
--mongo-uri {host}/?connect=direct&readPreference=secondaryPreferred
```

## Sampling modes

To change from the default _standalone schema mode_, add either of the following to the _`mongosqld`_ startup parameters:

### DRDL schema file

```bash
--schema schema.drdl
```

### Auto schema mode

```text
--schemaMode auto --schemaSource schemaDb --schemaRefreshIntervalSecs 3600
```

### Custom Schema mode

```text
--schemaMode custom --schemaSource schemaDb
```
