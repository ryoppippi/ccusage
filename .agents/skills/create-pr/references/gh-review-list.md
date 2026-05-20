# GitHub Review List Commands

List top-level PR comments:

```sh
gh api repos/:owner/:repo/issues/<pr-number>/comments --paginate \
  --jq '.[] | {id, user: .user.login, created_at, body}'
```

List inline review comments:

```sh
gh api repos/:owner/:repo/pulls/<pr-number>/comments --paginate \
  --jq '.[] | {id, user: .user.login, path, line, original_line, body}'
```
