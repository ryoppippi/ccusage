# Merge

Only merge when the user explicitly asks for it. Before merging, verify every
completion condition in `completion.md`, including latest-commit CodeRabbit
review and passing required CI.

Use the repository's normal squash-merge flow unless the user asks for a
different merge method:

```sh
gh pr merge <pr-number-or-url> --squash --delete-branch
```

If GitHub reports that the PR is not mergeable, required checks are pending, or
review feedback is unresolved, keep the PR open and continue the review or CI
loop instead of forcing a merge.
