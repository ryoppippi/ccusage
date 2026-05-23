---
name: commit
description: Creates atomic Conventional Commits. Use when committing code changes, splitting hunks into revertable units, or writing detailed commit messages.
---

<!--
Example prompts:
  /commit
  /commit push=true
-->

Arguments:

- push: whether to push after committing (default: false). Set to true to push to remote.

You are an expert git commit architect creating fine-grained, independently revertable commits following Conventional Commits specification.

Before committing, inspect the current state:

```sh
git status --short
git diff HEAD
git log --oneline -10
```

## Core Philosophy

Read `references/commit-guidance.md` for commit-splitting and message rules.

For concrete good and bad examples, read `references/revertable-commits.md`.

## Workflow

1. **Analyze the changes above**: Review the git state already provided
2. **Review history**: Match existing commit patterns and inspect relevant file history before deciding commit boundaries
3. **Identify revertable units**: Examine each hunk separately - can it be reverted independently?
4. **For each unit**:
   - Extract specific hunks using `git diff <file>`
   - Create patch with only desired hunks
   - Stage only that patch with `git apply --cached -v <patch>`
   - Craft message following format below
   - Commit and verify with `git show HEAD`

**NEVER use `git add -p` or `git add --interactive`** - Claude Code cannot handle interactive commands.

## Patch Staging

Use `git apply --cached -v` to stage precise non-interactive patches. Read `references/git-apply.md` when a patch fails, needs whitespace handling, or must be staged without touching unrelated hunks.

## History Inspection

Use standard git history commands to understand intent before committing. Prefer targeted commands such as `git log --follow -- <file>`, `git show <commit> -- <file>`, and `git blame <file>`. Match the repository's existing commit granularity, scopes, and explanation style.

## Commit Message Format

Read `references/commit-guidance.md` for Conventional Commit message rules.

## Quality Checks

- Can this be reverted without breaking other functionality?
- Is this the smallest logical unit?
- Does message clearly explain the change?
- Does it match project's commit patterns?
- No debugging statements or commented code without explanation

## Key Principles

- **Never push to main branch directly** - create a PR instead
- Match project's established scope naming and conventions
- Include issue/PR references when applicable
- If the commit is just for applying formatter use `chore(xxx): format` or just `chore: format`

## Push (if push=true)

After all commits are complete, push to remote. Let repository git hooks run; if pre-commit or pre-push runs format, sync, lint, typecheck, or tests, treat those hooks as part of the normal validation path and fix any failures in a new small commit.

Read `references/push.md` for the exact upstream check and push commands.
