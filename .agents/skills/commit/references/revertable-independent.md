# Revertable Independent Commits

Good: split independent implementation steps.

```text
feat(auth): add RefreshTokenService class

Added RefreshTokenService to handle token lifecycle management.
This service generates and invalidates refresh tokens with
configurable expiry periods.
```

```text
feat(auth): integrate token rotation in middleware

Updated auth middleware to call RefreshTokenService when validating
tokens. This can be reverted independently without removing the
service itself.
```
