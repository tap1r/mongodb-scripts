# Kerberos command tips

## Environmental config params (suggested tests to add kerberos diagnostic_mdiag_ info)

* getenvvars: _`KRB5CCNAME_`, _`KRB5_KTNAME`_, _`KRB5_CONFIG`_, _`KRB5_TRACE`_ and _`KRB5_CLIENT_KTNAME`_
* Report the current active contexts with "_`klist -Al`_"
* If "_`KRB5_CONFIG`_" is defined, get the _`krb5.conf`_ contents
* If "_`KRB5_TRACE`_" is defined, get the _`ktrace.log`_ contents
* If "_`KRB5_KTNAME`_" is defined, get the keytab entries with "_`ktutil -k $KRB5_KTNAME list`_"
* If "_`KRB5_CLIENT_KTNAME`_" is defined, get the keytab entries with "_`ktutil -k $KRB5_CLIENT_KTNAME list`_"
* Get FQDN
* Get GSSAPI config options

## Admin commands

### Export _keytab_ from Windows

```bash
ktpass -princ mongodb/host.mongodb.org@MONGODB.ORG -mapuser mongodb_svc@MONGODB.ORG -pass ****** -out mongodb.keytab -crypto all -ptype KRB5_NT_PRINCIPAL
```

### Export _keytab_ from Linux

```bash
$ ktutil
addent -password -p username@EXAMPLE.COM -k 1 -e RC4-HMAC
- enter password for username -
wkt username.keytab
q
```

## Testing for account delegation

### Windows

```powershell
Get-ADUser BI.EXAMPLE.COM -Properties PrincipalsAllowedToDelegateToAccount
```

```powershell
# Remove unconstrained delegation, if enabled
Set-ADUser -Identity mongosql_service -TrustedForDelegation $false
# Get the AD User and replace with constrained delegation
Get-AdUser -Identity mongosql_service | Set-ADObject -Replace @{"msDS-AllowedToDelegateTo"="mongodb/mongod0.mongodb.local","mongodb/mongod1.mongodb.local","mongodb/mongod2.mongodb.local"}
# display the configured delegation
Get-ADUser -Identity mongosql_service -Properties msDS-AllowedToDelegateTo,
  TrustedForDelegation | select -Property msDS-AllowedToDelegateTo,TrustedForDelegation
```

### Linux

* Set:

  ```bash
  $ kadmin
  kadmin:  modprinc +ok_to_auth_as_delegate +ok_as_delegate +requires_preauth mongosql_service
  ```

* Get:

  ```bash
  $ kadmin
  kadmin: getprinc test/ipa.example.com
  Principal: test/ipa.example.com@EXAMPLE.COM
  Expiration date: [never]
  ...
  Attributes: REQUIRES_PRE_AUTH OK_AS_DELEGATE OK_TO_AUTH_AS_DELEGATE
  ```

* Export _keytab_

  ```bash
  kadmin: xst -k mongosql_service.keytab test/ipa.example.com
  ```

* Validate _keytab_ entry

  ```bash
  klist -e -k -t mongosql_service.keytab
  ```

### Unconstrained delegation

The _mongosqld_ [proxy] service: Principal set with _`+ok_as_delegate`_

### Constrained delegation

The _mongosqld_ [proxy] service: Principal set with _`+ok_to_auth_as_delegate`_
The _mongod_ service: Principal set with _`+ok_as_delegate`_

### Cross-realm issues

*ignore _`+requires_preauth`_ flags in cross-realm env

### Testing

#### Init credentials

```bash
kinit -kt mongosqld.keytab mongosql/bi-connector.example.com
kinit -kt mongodb.keytab mongodb/db-host.example.com
kinit user@EXAMPLE.COM
```

#### Perform S4U2Self

```bash
kvno -U user mongosql/bi-connector.example.com
```

#### Perform S4U2Proxy

```bash
kvno -k mongosqld.keytab -U user -P mongosql/bi-connector.example.com mongodb/db-host.example.com
```

##### tmp

TrustedToAuthForDelegation = ok_to_auth_as_delegate (_mongosqld_)
TrustedForDelegation = ok_as_delegate (_mongod_)

* Set

```powershell
Set-ADUser -Identity mongosql_service -TrustedForDelegation $false
Set-ADAccountControl mongosql_service -TrustedToAuthForDelegation $true
```

```bash
$ kadmin
kadmin:  modprinc +ok_to_auth_as_delegate -ok_as_delegate mongosql/bi-connector.example.com
# kadmin:  modprinc -ok_to_auth_as_delegate +ok_as_delegate mongodb/db-host.example.com
```

* Get

```powershell
Get-ADAccountControl mongod_service -Properties TrustedToAuthForDelegation
Get-ADUser -Identity mongosql_service -Properties msDS-AllowedToDelegateTo,
  TrustedForDelegation | select -Property msDS-AllowedToDelegateTo,TrustedForDelegation
```

```powershell
Set-ADAccountControl mongosql_service -TrustedToAuthForDelegation $true
Get-AdUser -Identity mongosql_service | Set-ADObject -Replace @{"msDS-AllowedToDelegateTo"="mongodb/mongod3.mongodb.local"}
get-aduser -Identity mongosql_service -Properties * | select -Property servicePrincipalNames,TrustedForDelegation,TrustedToAuthForDelegation,msDS-AllowedToDelegateTo  | Format-Table -Wrap
```

### Delegation

From: <https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-kile/3affa503-59b5-47b6-92aa-ec4b9cf04982>

If Delegate is set to TRUE, the client sets the FORWARDABLE option in the TGS request. When the client receives a forwardable ticket, it puts the ticket in a KRB_CRED structure ([RFC4120] section 3.6). The client does not forward the ticket unless the TGT is marked OK-AS-DELEGATE ([RFC4120] section 2.8).

<https://web.mit.edu/kerberos/krb5-devel/doc/appdev/gssapi.html#constrained-delegation-s4u>
