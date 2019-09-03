# Enabling LDAP Anonymous bindings

To configure anon LDAP binding, the bind credentials must be defined as _`null`_.

## _mongod.conf_ config snippet

```yaml
security:
  ldap:
    bind:
      queryUser: ""
      queryPassword: ""
```
