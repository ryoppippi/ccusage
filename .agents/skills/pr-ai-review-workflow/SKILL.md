---
name: pr-ai-review-workflow
description: 'Manage pull request AI review loops with GitHub CLI: request generic AI/code reviewers, wait for bot or human review, inspect comments, reply to inline review comments, apply fixes, push follow-up commits, and request re-review.'
---

# PR AI Review Workflow

Use this after opening a PR or pushing commits to an open PR. Reviewer tools and bot names can change; treat names such as `@coderabbitai` and `@cubic-dev-ai` as current examples, not permanent assumptions.

## Commit Policy

PRs are normally squash-merged. Do not default to `git commit --amend` or force-push just to keep a PR to one commit. Prefer small, independently revertable follow-up commits for review fixes, generated skill updates, and discussion outcomes. Use the `commit` skill for atomic commit structure and messages.

Use amend only when the user explicitly asks, when fixing the immediately previous unpublished commit, or when correcting a local mistake before any reviewer has consumed it.

## Request Review

After creating a PR or pushing a meaningful follow-up commit, check whether reviewers are already running. If not, add a PR conversation comment that mentions the configured reviewers:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review
@cubic-dev-ai review'
```

Prefer repository-local conventions when they exist. If the repo has changed reviewers, use the current reviewer mentions from recent PRs or project docs instead of the examples above.

## Wait and Inspect

Poll for reviews and comments before declaring the PR ready:

```sh
gh pr view <pr-number-or-url> --json url,state,headRefName,comments,reviews,statusCheckRollup
```

List top-level PR conversation comments:

```sh
gh api repos/:owner/:repo/issues/<pr-number>/comments --paginate \
  --jq '.[] | {id, user: .user.login, created_at, body}'
```

List inline review comments:

```sh
gh api repos/:owner/:repo/pulls/<pr-number>/comments --paginate \
  --jq '.[] | {id, user: .user.login, path, line, original_line, body}'
```

If thread resolution state matters, use GraphQL review threads rather than the flat REST comment list:

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

## Respond to Review

Classify each review item as actionable, a question, a false positive, or informational. Do not silently ignore actionable comments.

For actionable feedback:

1. Apply the smallest fix that preserves repo conventions.
2. Run the relevant checks.
3. Create a small follow-up commit using the `commit` skill.
4. Push normally with `git push`.
5. Reply to the specific comment with what changed and which validation passed.

Reply to an inline review comment:

```sh
gh api -X POST repos/:owner/:repo/pulls/comments/<comment-id>/replies \
  -f body='Fixed in <commit-sha>. Validation: pnpm typecheck, pnpm run test.'
```

Add a top-level PR comment:

```sh
gh pr comment <pr-number-or-url> --body 'Addressed the review feedback in <commit-sha>.'
```

Update an existing top-level issue comment only when correcting your own comment:

```sh
gh api -X PATCH repos/:owner/:repo/issues/comments/<comment-id> \
  -f body='Updated comment body'
```

When disagreeing with a review, reply with concrete repository context, not a vague dismissal. If discussion changes the implementation, commit the change and reply again with the result.

## Re-Request Review

After pushing fixes, request another pass if the reviewer does not automatically re-run:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review
@cubic-dev-ai review'
```

Do not wait forever. If reviewers do not respond after a reasonable polling window, leave the PR with the latest commit pushed and note which reviews are still pending.
