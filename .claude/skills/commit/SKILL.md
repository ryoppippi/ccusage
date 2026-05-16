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

**Current status:** `!`git status --short``

**Changes:**

```diff
!`git diff HEAD`
```

**Recent commits:** `!`git log --oneline -10``

## Core Philosophy

**Revertability First**: Each commit must be revertable independently without breaking other functionality. Prefer smaller, granular commits over large groupings. Split by hunks within files, not just entire files.

## Workflow

1. **Analyse the changes above**: Review the git state already provided
2. **Review history**: Match existing commit patterns (structure, scope naming, message style) from the log above
3. **Identify revertable units**: Examine each hunk separately - can it be reverted independently?
4. **For each unit**:
   - Extract specific hunks using `git diff <file>`
   - Create patch with only desired hunks
   - Reset file: `git checkout -- <file>`
   - Apply patch (see detailed guidance below)
   - Stage: `git add <file>`
   - Craft message following format below
   - Commit and verify with `git show HEAD`

**NEVER use `git add -p` or `git add --interactive`** - Claude Code cannot handle interactive commands.

## Git Apply Best Practices

When applying patches, follow these guidelines to avoid common failures:

### Basic Usage

```bash
# Always verify first before applying
git apply --check patch_file.patch

# Apply with verbose output for debugging
git apply -v patch_file.patch

# Or pipe directly from git diff
git diff <file> | git apply -v
```

### Essential Flags

- **`-v, --verbose`**: Always use this for detailed feedback during application
- **`--check`**: Verify whether patch can be applied cleanly without making changes
- **`--stat`**: Display affected files before applying
- **`--whitespace=fix`**: Automatically correct trailing whitespace issues (common failure cause)
- **`--reject`**: Create .rej files for failed sections instead of aborting entirely
- **`--reverse/-R`**: Revert previously applied patches

### Troubleshooting Failed Applies

**Common Issues**:

1. **Trailing Whitespace**: Patches may fail due to whitespace differences

   ```bash
   git apply --whitespace=fix -v patch_file.patch
   ```

2. **Partial Failures**: When some hunks fail, use `--reject` to apply what works

   ```bash
   git apply --reject -v patch_file.patch
   # Manually resolve conflicts in generated .rej files
   ```

3. **Context Mismatch**: If patch was created from different base, try with more context

   ```bash
   git apply --ignore-whitespace -v patch_file.patch
   ```

4. **Line Ending Issues**: Different platforms may have CRLF vs LF issues
   ```bash
   git apply --ignore-space-change -v patch_file.patch
   ```

### Workflow Recommendation

```bash
# 1. Always check first
git apply --check patch_file.patch

# 2. If check passes, apply with verbose output
git apply -v patch_file.patch

# 3. If check fails, try with whitespace fix
git apply --check --whitespace=fix patch_file.patch
git apply -v --whitespace=fix patch_file.patch

# 4. If still fails, use reject for partial application
git apply --reject -v patch_file.patch
# Then manually fix .rej files
```

### Git Apply vs Git Am

- **`git apply`**: Applies changes without creating commits (used in this workflow)
- **`git am`**: Applies patches with commit messages and author info preserved

**ALWAYS use `git apply -v`** for this workflow to maintain control over commit creation.

## Commit Message Format

```
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

## Example

Instead of one large commit:

```
feat(auth): add RefreshTokenService class

Added new RefreshTokenService to handle token lifecycle management.
This service will be responsible for generating and invalidating
refresh tokens with configurable expiry periods.
```

```
feat(auth): integrate token rotation in middleware

Updated auth middleware to call RefreshTokenService when validating
tokens. This change can be reverted independently if needed without
affecting the service itself.
```

## Key Principles

- Always use **English** for commit messages with **UK English spelling** (e.g. "colour", "organise", "initialise")
- **Never push to main branch directly** - create a PR instead
- When in doubt, prefer smaller commits (can squash later, can't easily split)
- Match project's established scope naming and conventions
- Include issue/PR references when applicable
- Each commit must pass: "If I revert this, will it break other features?"
- If the commit is just for applying formatter use `chore(xxx): format` or just `chore: format`

## Push (if push=true)

After all commits are complete, push to remote:

1. Check if the branch has an upstream:

   ```bash
   git rev-parse --abbrev-ref --symbolic-full-name @{u}
   ```

2. If upstream exists, push directly:

   ```bash
   git push
   ```

3. If no upstream (command fails), **ask the user** whether to set upstream and push:
   - If yes: `git push -u origin HEAD`
   - If no: skip pushing
