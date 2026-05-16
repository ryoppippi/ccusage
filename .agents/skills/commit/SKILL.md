---
name: commit
description: Creates atomic git commits following Conventional Commits specification with detailed, well-structured messages. Analyzes changes and splits them into logical units. Use when committing code changes that need proper structure and comprehensive documentation (e.g., "commit my authentication changes" or "finished implementing search, time to commit").
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

**Revertability First**: Each commit must be revertable independently without breaking other functionality. Prefer smaller, granular commits over large groupings. Split by hunks within files, not just entire files.

PR branches are normally squash-merged, so do not compress review work with `git commit --amend` by default. Keep review fixes as small follow-up commits that can be reverted independently. Amend only for unpublished local mistakes or when the user explicitly asks.

Tiny commits are expected. A single review comment, one wording correction, one reference-file extraction, one symlink sync, or one generated formatting pass can each be its own commit when independently revertable.

Tiny does not mean incomplete. For moves, renames, or extractions, one commit must include both sides of the operation: remove or update the old location, add the new location, update references, and sync generated links if required. Never commit only the destination of a move while leaving the source/reference cleanup for a later commit.

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

```text
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

**Body should explain**:

- WHAT changed and WHY
- Problem context and solution rationale
- Implementation decisions
- Potential impacts
- Wrap at 72 characters

## Quality Checks

- Can this be reverted without breaking other functionality?
- Is this the smallest logical unit?
- Does message clearly explain the change?
- Does it match project's commit patterns?
- No debugging statements or commented code without explanation

## Key Principles

- Always use clear English for commit messages and keep wording compatible with repository spell-check rules.
- **Never push to main branch directly** - create a PR instead
- When in doubt, prefer smaller commits (can squash later, can't easily split)
- On PR branches, stack small revertable commits instead of amending away review history unless explicitly asked
- Prefer many tiny commits over a tidy-looking but broad commit; squash merge will clean PR history later
- Match project's established scope naming and conventions
- Include issue/PR references when applicable
- Each commit must pass: "If I revert this, will it break other features?"
- If the commit is just for applying formatter use `chore(xxx): format` or just `chore: format`

## Push (if push=true)

After all commits are complete, push to remote. Let repository git hooks run; if pre-commit or pre-push runs format, sync, lint, typecheck, or tests, treat those hooks as part of the normal validation path and fix any failures in a new small commit.

Read `references/push.md` for the exact upstream check and push commands.
