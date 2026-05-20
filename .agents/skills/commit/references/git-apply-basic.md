# Git Apply Basic Usage

```bash
# Always verify first before applying.
git apply --check patch_file.patch

# Apply with verbose output for debugging.
git apply -v patch_file.patch

# Stage without touching the worktree.
git apply --cached -v patch_file.patch

# Apply a diff generated between refs.
git diff main...HEAD -- <file> | git apply -v
```

`git apply` applies or stages changes without creating commits. `git am` applies
patches with commit messages and author info preserved. Use `git apply -v` for
this workflow to keep commit creation explicit and controlled.
