# Enabling LDAP Anonymous bindings

To configure anon LDAP binding, the bind credentials attrbibutes must be defined with _`null`_ values.

## _mongod.conf_ config snippet

```yaml
security:
    ldap:
        bind:
            queryUser: ""
            queryPassword: ""
```
