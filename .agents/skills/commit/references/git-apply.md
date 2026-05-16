# Git Apply Reference

## Basic Usage

```bash
# Always verify first before applying
git apply --check patch_file.patch

# Apply with verbose output for debugging
git apply -v patch_file.patch

# Stage without touching the worktree
git apply --cached -v patch_file.patch

# Apply a diff generated between refs
git diff main...HEAD -- <file> | git apply -v
```

## Essential Flags

- `-v, --verbose`: always use this for detailed feedback during application.
- `--check`: verify whether a patch can be applied cleanly without making changes.
- `--cached`: stage the patch without applying it to the worktree.
- `--stat`: display affected files before applying.
- `--whitespace=fix`: automatically correct trailing whitespace issues.
- `--reject`: create `.rej` files for failed sections instead of aborting entirely.
- `--reverse` / `-R`: revert a previously applied patch.

## Troubleshooting Failed Applies

Trailing whitespace:

```bash
git apply --check --whitespace=fix patch_file.patch
git apply --whitespace=fix -v patch_file.patch
```

Partial failures:

```bash
git apply --reject -v patch_file.patch
```

Context mismatch:

```bash
git apply --ignore-whitespace -v patch_file.patch
```

Line ending issues:

```bash
git apply --ignore-space-change -v patch_file.patch
```

## Git Apply vs Git Am

- `git apply`: applies or stages changes without creating commits.
- `git am`: applies patches with commit messages and author info preserved.

Use `git apply -v` for this workflow to keep commit creation explicit and controlled.
