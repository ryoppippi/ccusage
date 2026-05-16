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

After creating a PR or pushing a meaningful follow-up commit, check whether reviewers are already running. If not, add a PR conversation comment that mentions the configured reviewers.

Prefer repository-local conventions when they exist. If the repo has changed reviewers, use the current reviewer mentions from recent PRs or project docs instead of the examples above.

## Wait and Inspect

Poll for reviews and comments before declaring the PR ready. Use flat REST comment lists for ordinary replies, and GraphQL review threads only when thread resolution state matters.

If CI checks fail while working the PR, switch to the `fix-ci` skill before asking for another review pass.

## Respond to Review

Classify each review item as actionable, a question, a false positive, or informational. Do not silently ignore actionable comments.

For actionable feedback:

1. Apply the smallest fix that preserves repo conventions.
2. Run the relevant checks.
3. Create a small follow-up commit using the `commit` skill.
4. Push normally with `git push`.
5. Reply to the specific comment with what changed and which validation passed.

Read `references/gh-review-commands.md` for concrete `gh` commands to request review, list comments, reply to inline review comments, add top-level PR comments, update your own comments, and query review threads.

When disagreeing with a review, reply with concrete repository context, not a vague dismissal. If discussion changes the implementation, commit the change and reply again with the result.

## Re-Request Review

After pushing fixes, request another pass if the reviewer does not automatically re-run.

Do not wait forever. If reviewers do not respond after a reasonable polling window, leave the PR with the latest commit pushed and note which reviews are still pending.
