# GitHub Review Reply Commands

Reply to an inline review comment:

```sh
gh api -X POST repos/:owner/:repo/pulls/<pr-number>/comments/<comment-id>/replies \
  -f body='@coderabbitai Fixed in <commit-sha>. Validation: pnpm typecheck, pnpm run test.'
```

Add a top-level PR comment:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai Addressed the review feedback in <commit-sha>.'
```

Update your own top-level issue comment:

```sh
gh api -X PATCH repos/:owner/:repo/issues/comments/<comment-id> \
  -f body='Updated comment body'
```
