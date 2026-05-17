# GitHub Review Commands

## Request AI or code review

Use current repository reviewer mentions. These are examples only:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review
@cubic-dev-ai review'
```

## Poll PR state

```sh
gh pr view <pr-number-or-url> --json url,state,headRefName,comments,reviews,statusCheckRollup
```

## List top-level PR comments

```sh
gh api repos/:owner/:repo/issues/<pr-number>/comments --paginate \
  --jq '.[] | {id, user: .user.login, created_at, body}'
```

## List inline review comments

```sh
gh api repos/:owner/:repo/pulls/<pr-number>/comments --paginate \
  --jq '.[] | {id, user: .user.login, path, line, original_line, body}'
```

## Reply to an inline review comment

```sh
gh api -X POST repos/:owner/:repo/pulls/<pr-number>/comments/<comment-id>/replies \
  -f body='Fixed in <commit-sha>. Validation: pnpm typecheck, pnpm run test.'
```

## Add a top-level PR comment

```sh
gh pr comment <pr-number-or-url> --body 'Addressed the review feedback in <commit-sha>.'
```

## Update your own top-level issue comment

```sh
gh api -X PATCH repos/:owner/:repo/issues/comments/<comment-id> \
  -f body='Updated comment body'
```

## Query review thread state

Use this when thread resolution state matters. This quick query only returns the first 100 review threads; add pagination with `pageInfo` and `after` for large PRs.

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
