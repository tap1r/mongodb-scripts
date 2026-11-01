# Enabling LDAP anonymous binds

Leave `security.ldap.bind.queryUser` and `security.ldap.bind.queryPassword` unset when the directory allows an anonymous bind. An empty string is a set value. `mongod` then attempts a bind with that value instead of connecting without a bind.

`queryUser` is required when LDAP authorization is on, when `userToDNMapping` runs an LDAP query, or when the directory disallows anonymous binds. Set it together with `queryPassword`.

LDAP authentication and authorization are deprecated in MongoDB 8.0 and 9.0. See [LDAP authentication alternatives](https://www.mongodb.com/docs/manual/core/ldap-deprecation/).

## `mongod.conf`

Omit the `bind` block:

```yaml
security:
    ldap:
        servers: "ldap.example.net"
```
