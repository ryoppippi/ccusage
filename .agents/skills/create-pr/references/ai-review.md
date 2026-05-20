# AI Review

## Reviewers

Always request CodeRabbit review. If Cubic is usable on the repository, request Cubic too.

Current handles:

- CodeRabbit: `@coderabbitai`
- Cubic: `@cubic-dev-ai`

`@cubic-dev-ai` was verified as the GitHub user `cubic.dev`. If a current PR or recent repository comments show a different Cubic handle, use the handle shown there.

## Request Review

After opening the PR, add a top-level PR comment that explicitly mentions the
reviewer bots. If Cubic is unavailable on that PR, keep the CodeRabbit request.

Mention the relevant bot after every meaningful push so it treats the request as directed at it instead of ordinary human discussion.

## Inspect Review

Poll PR comments, reviews, and inline threads before declaring the PR ready.

Use GraphQL review threads when resolution state or inline context matters.

Read `gh-review-commands.md` for concrete `gh` commands to request review, list comments, reply to inline review comments, add top-level PR comments, update your own comments, and query review threads.

## Respond

Classify each bot review item as actionable, a question, a false positive, or informational. Do not silently ignore actionable feedback.

For actionable feedback:

1. Apply the smallest fix that preserves repo conventions.
2. Run the relevant checks.
3. Create a small follow-up commit using the `commit` skill.
4. Push normally with `git push`.
5. Reply in the specific thread with the relevant bot mentioned at the start, what changed, and which validation passed.

Reply to inline review comments through the pull request review comment reply
endpoint shown in `gh-review-commands.md`.

For Cubic comments, use `@cubic-dev-ai` in the reply body instead.

If reviewer bots do not rerun automatically after a push, add another top-level
PR comment using the request-review command from `gh-review-commands.md`.

Do not wait forever. If a reviewer bot does not respond after a reasonable polling window, leave the latest request visible on the PR and report that review is still pending.
