---
name: create-pr
description: Runs the full PR lifecycle. Use when creating a branch, committing, pushing, opening a PR, requesting AI review, and driving CI and review to completion.
---

# Create PR

Use this skill when the user asks to create or open a PR, push changes for review, or handle the full PR workflow. This is the single rule for PR work in this repository: it owns setup, AI review requests, reviewer thread replies, follow-up pushes, CI inspection, and final readiness checks.

## Workflow

1. Prepare the branch and commits.
   Read `references/branch-and-commit.md`.

2. Create the PR.
   Read `references/open-pr.md`.

3. Request and handle AI review.
   Read `references/ai-review.md`.
   Read `references/gh-review.md` when you need concrete `gh` commands.

4. Monitor and fix CI.
   Read `references/ci.md`.

5. Finish only when the PR is actually ready.
   Read `references/completion.md`.

6. Merge the PR only when explicitly requested.
   Read `references/merge.md`.

## Always Apply

- Never push directly to `main` without explicit permission.
- Use English for commit messages, PR titles, PR bodies, review replies, and bot-directed comments.
- Use shell syntax that matches the active environment; this may be zsh, bash, fish, or a non-interactive command runner.
- Use high-performance local tools such as `git`, `gh`, `rg`, and `fd`.
- Keep commits atomic and independently revertible; use the `commit` skill.
- Do not omit reviewer bot mentions when asking bots to review or replying to bot threads.
- Do not claim the PR is ready until reviewer bots have no unresolved actionable feedback and CI is passing.
