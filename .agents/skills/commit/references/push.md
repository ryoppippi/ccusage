# Push Reference

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
