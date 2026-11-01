# Kerberos command tips

`kadmin`, `kvno`, `kinit -kt`, `klist -k`, and interactive `ktutil` (`addent`, `wkt`, `q`) are MIT Kerberos. macOS ships Heimdal. Its `kinit` takes `-k -t keytab`, its `ktutil` takes `-k keytab list` and `add`, and it does not ship `kvno`. See also [Kerberos AES.md](Kerberos%20AES.md) for the Active Directory AES salt.

## Environmental config params (suggested tests to add to kerberos diagnostic _mdiag_ info)

* getenvvars: _`KRB5CCNAME`_, _`KRB5_KTNAME`_, _`KRB5_CONFIG`_, _`KRB5_TRACE`_ and _`KRB5_CLIENT_KTNAME`_
* Report the current active contexts with "_`klist -Al`_" (Heimdal and MIT)
* If "_`KRB5_CONFIG`_" is defined, get the _`krb5.conf`_ contents
* If "_`KRB5_TRACE`_" is defined, read the file it names
* If "_`KRB5_KTNAME`_" is defined, list the keytab. Heimdal: "_`ktutil -k $KRB5_KTNAME list`_". MIT: "_`klist -k $KRB5_KTNAME`_"
* If "_`KRB5_CLIENT_KTNAME`_" is defined, list that keytab the same way
* Get FQDN
* Get GSSAPI config options

## Admin commands

### Export _keytab_ from Windows

`/pass *` prompts. `-SetPass` keeps the account password. `AES256-SHA1` is `aes256-cts-hmac-sha1-96`. `All` also writes DES and RC4 keys, which current KDCs reject.

```text
ktpass /princ mongodb/db-host.example.com@EXAMPLE.COM /mapuser mongodb_svc@EXAMPLE.COM /pass * /out mongodb.keytab /crypto AES256-SHA1 /ptype KRB5_NT_PRINCIPAL -SetPass
```

### Export _keytab_ from Linux

MIT `ktutil`. This salts with the principal named here, which is right for a user principal. An Active Directory service account salts AES with the user principal name (UPN). Build that keytab with [Kerberos AES.md](Kerberos%20AES.md).

```text
$ ktutil
ktutil:  addent -password -p username@EXAMPLE.COM -k 1 -e aes256-cts-hmac-sha1-96
Password for username@EXAMPLE.COM:
ktutil:  wkt username.keytab
ktutil:  q
```

Heimdal:

```text
ktutil -k username.keytab add -p username@EXAMPLE.COM -e aes256-cts-hmac-sha1-96
```

## Testing for account delegation

Resource-based constrained delegation is `PrincipalsAllowedToDelegateToAccount` on the target account. The commands below are classic constrained delegation on the _mongosqld_ account.

### Windows

```powershell
Get-ADUser -Identity mongosql_service -Properties servicePrincipalNames,TrustedForDelegation,TrustedToAuthForDelegation,msDS-AllowedToDelegateTo |
  Format-List servicePrincipalNames,TrustedForDelegation,TrustedToAuthForDelegation,msDS-AllowedToDelegateTo
```

### Linux

MIT `kadmin`.

* Get:

  ```bash
  $ kadmin
  kadmin: getprinc mongosql/bi-connector.example.com
  Principal: mongosql/bi-connector.example.com@EXAMPLE.COM
  Expiration date: [never]
  ...
  Attributes: REQUIRES_PRE_AUTH OK_TO_AUTH_AS_DELEGATE
  ```

  Unconstrained delegation lists `OK_AS_DELEGATE` on that line instead.

* Export _keytab_

  ```bash
  kadmin: xst -k mongosqld.keytab mongosql/bi-connector.example.com
  ```

* Validate _keytab_ entry

  ```bash
  klist -e -k -t mongosqld.keytab
  ```

### Unconstrained delegation

The _mongosqld_ account may receive a forwarded TGT and use it with any service. Windows stores that as `TrustedForDelegation`. MIT stores the client hint as `+ok_as_delegate`, which sets OK-AS-DELEGATE on tickets for that service. Active Directory sets the same ticket flag when the account is trusted for unconstrained delegation.

Clear the allow-list before turning the flag on. Leave protocol transition off. Leave both flags off the _mongod_ principal.

```powershell
Set-ADUser -Identity mongosql_service -Clear msDS-AllowedToDelegateTo
Set-ADAccountControl -Identity mongosql_service -TrustedForDelegation $true -TrustedToAuthForDelegation $false
```

```bash
$ kadmin
kadmin: modprinc +ok_as_delegate -ok_to_auth_as_delegate mongosql/bi-connector.example.com
```

On an MIT LDAP KDB, delete `krbAllowedToDelegateTo` when it is set. A file KDB has no such attribute. The entry DN follows the KDB layout.

```text
dn: krbPrincipalName=mongosql/bi-connector.example.com@EXAMPLE.COM,cn=EXAMPLE.COM,cn=krbContainer,dc=example,dc=com
changetype: modify
delete: krbAllowedToDelegateTo
```

### Constrained delegation

The _mongosqld_ account may obtain a ticket only for the SPNs on its allow-list. The commands below are the protocol-transition path: the SQL client authenticated without Kerberos, so _mongosqld_ does S4U2Self before S4U2Proxy. A GSSAPI client that already presented a forwardable service ticket uses S4U2Proxy alone. For that path, leave `TrustedToAuthForDelegation` false and omit `+ok_to_auth_as_delegate`. The allow-list stays.

`TrustedToAuthForDelegation` is protocol transition. It matches MIT `+ok_to_auth_as_delegate`, and it belongs on _mongosqld_. `msDS-AllowedToDelegateTo` is the allow-list. A file KDB has nowhere to store that list, so `kvno -P` succeeds only against an LDAP KDB, which stores it as `krbAllowedToDelegateTo`, one backend SPN per value. Leave both flags off the _mongod_ principal.

Turn unconstrained delegation off before writing the allow-list.

```powershell
Set-ADAccountControl -Identity mongosql_service -TrustedForDelegation $false -TrustedToAuthForDelegation $true
Set-ADUser -Identity mongosql_service -Replace @{'msDS-AllowedToDelegateTo'='mongodb/db-host.example.com'}
```

A replica set is one SPN per member. This `-Replace` is instead of the single-host command. It writes the whole list:

```powershell
Set-ADUser -Identity mongosql_service -Replace @{
  'msDS-AllowedToDelegateTo' = @(
    'mongodb/mongod0.example.com',
    'mongodb/mongod1.example.com',
    'mongodb/mongod2.example.com'
  )
}
```

```bash
$ kadmin
kadmin: modprinc +ok_to_auth_as_delegate -ok_as_delegate mongosql/bi-connector.example.com
```

```text
dn: krbPrincipalName=mongosql/bi-connector.example.com@EXAMPLE.COM,cn=EXAMPLE.COM,cn=krbContainer,dc=example,dc=com
changetype: modify
replace: krbAllowedToDelegateTo
krbAllowedToDelegateTo: mongodb/db-host.example.com
```

For the replica set, repeat `krbAllowedToDelegateTo` once per member, under the same `replace`.

### Cross-realm issues

`+requires_preauth` on a service principal means the KDC issues a ticket only when the client TGT has PRE-AUTHENT. A cross-realm TGT often arrives without that flag, and the request fails. Leave `+requires_preauth` off `krbtgt/OTHER.REALM@EXAMPLE.COM` and off a service principal that clients reach through that trust.

A referral also needs OK-AS-DELEGATE on the cross-realm TGT, or the client will not honor the flag on the foreign service ticket. MIT `klist -f` shows `A` for pre-authenticated and `O` for okay-as-delegate.

### Testing

MIT `kinit` and `kvno`. The S4U steps use the default cache, so that cache stays the _mongosqld_ principal. The other two kinits use their own caches.

#### Acquire (_`kinit`_) credentials

```bash
kinit -kt mongosqld.keytab mongosql/bi-connector.example.com
kinit -c mongodb.ccache -kt mongodb.keytab mongodb/db-host.example.com
kinit -c user.ccache user@EXAMPLE.COM
```

#### Perform the _S4U2Self_ function

`-I` names a principal in this realm. Without `-P`, the service argument has to be the cache client. `-k` checks that _mongosqld_ can decrypt the ticket. `-U` is the enterprise-name form and needs canonicalization on the KDC.

```bash
kvno -k mongosqld.keytab -I user@EXAMPLE.COM mongosql/bi-connector.example.com
```

#### Perform the _S4U2Proxy_ function

`-P` marks every service argument as a constrained-delegation target, and it is valid only together with `-I` or `-U`. The intermediate service is the cache client. Decrypt the _mongod_ ticket with the _mongod_ keytab. This fails on a file KDB.

```bash
kvno -k mongodb.keytab -I user@EXAMPLE.COM -P mongodb/db-host.example.com
```

Read the flags back with the `Get-ADUser` and `getprinc` commands above. Constrained delegation shows `TrustedToAuthForDelegation` true, `TrustedForDelegation` false, and the _mongod_ SPN in `msDS-AllowedToDelegateTo`. `getprinc` shows `OK_TO_AUTH_AS_DELEGATE` and not `OK_AS_DELEGATE`. Unconstrained delegation shows `TrustedForDelegation` true, an empty allow-list, `TrustedToAuthForDelegation` false, and `OK_AS_DELEGATE` without `OK_TO_AUTH_AS_DELEGATE`.

### Delegation

From: <https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-kile/3affa503-59b5-47b6-92aa-ec4b9cf04982>

If Delegate is set to _`TRUE`_, the client sets the _`FORWARDABLE`_ option in the TGS request. When the client receives a forwardable ticket, it puts the ticket in a _`KRB_CRED`_ structure ([RFC4120] section 3.6). The client does not forward the ticket unless the TGT is marked _`OK-AS-DELEGATE`_ ([RFC4120] section 2.8).

RFC 4120 puts OK-AS-DELEGATE on the service ticket. [MS-KILE 3.3.5.1](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-kile/f5993d64-a280-4555-9fcc-922fb934fc27) sets that flag when `TrustedForDelegation` is true. The sentence above is the client check as written. On a cross-realm referral the cross-realm TGT has to carry the flag as well, or the client will not honor it on the foreign service ticket.

<https://web.mit.edu/kerberos/krb5-devel/doc/appdev/gssapi.html#constrained-delegation-s4u>
