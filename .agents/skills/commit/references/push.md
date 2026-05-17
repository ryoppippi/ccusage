# Push Reference

Check the current branch before any push:

```bash
current_branch="$(git branch --show-current)"
test "$current_branch" != "main" && test "$current_branch" != "master"
```

If the current branch is `main` or `master`, stop and create a feature branch before pushing.

Check if the branch has an upstream:

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u}
```

If upstream exists, push directly:

```bash
git push
```

If no upstream exists, ask the user whether to set upstream and push:

- If yes: `git push -u origin HEAD`
- If no: skip pushing.
