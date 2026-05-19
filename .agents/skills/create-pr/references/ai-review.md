# AI Review

## Reviewers

Always request CodeRabbit review. If Cubic is usable on the repository, request Cubic too.

Current handles:

- CodeRabbit: `@coderabbitai`
- Cubic: `@cubic-dev-ai`

`@cubic-dev-ai` was verified as the GitHub user `cubic.dev`. If a current PR or recent repository comments show a different Cubic handle, use the handle shown there.

## Request Review

After opening the PR, add a top-level PR comment that explicitly mentions the reviewer bots:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review
@cubic-dev-ai review'
```

If Cubic is unavailable on that PR, keep the CodeRabbit request:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review'
```

Mention the relevant bot after every meaningful push so it treats the request as directed at it instead of ordinary human discussion.

## Inspect Review

Poll PR comments, reviews, and inline threads before declaring the PR ready:

```sh
gh pr view <pr-number-or-url> --json url,state,headRefName,comments,reviews,statusCheckRollup
gh api repos/:owner/:repo/issues/<pr-number>/comments --paginate
gh api repos/:owner/:repo/pulls/<pr-number>/comments --paginate
```

Use GraphQL review threads when resolution state or inline context matters:

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

## Respond

Classify each bot review item as actionable, a question, a false positive, or informational. Do not silently ignore actionable feedback.

For actionable feedback:

1. Apply the smallest fix that preserves repo conventions.
2. Run the relevant checks.
3. Create a small follow-up commit using the `commit` skill.
4. Push normally with `git push`.
5. Reply in the specific thread with the relevant bot mentioned at the start, what changed, and which validation passed.

Reply to inline review comments through the pull request review comment reply endpoint:

```sh
gh api -X POST repos/:owner/:repo/pulls/<pr-number>/comments/<comment-id>/replies \
  -f body='@coderabbitai Fixed in <commit-sha>. Validation: pnpm typecheck, pnpm run test.'
```

For Cubic comments, use `@cubic-dev-ai` in the reply body instead.

If reviewer bots do not rerun automatically after a push, add another top-level PR comment:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review
@cubic-dev-ai review'
```

Do not wait forever. If a reviewer bot does not respond after a reasonable polling window, leave the latest request visible on the PR and report that review is still pending.
