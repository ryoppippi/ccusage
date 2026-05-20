# GitHub Review Thread Commands

Use this when thread resolution state matters. This quick query only returns the
first 100 review threads; add pagination with `pageInfo` and `after` for large
PRs.

```sh
gh api graphql \
  -F owner='OWNER' \
  -F repo='REPO' \
  -F number=<pr-number> \
  -f query='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 20) {
            nodes {
              id
              databaseId
              author { login }
              path
              body
            }
          }
        }
      }
    }
  }
}'
```
