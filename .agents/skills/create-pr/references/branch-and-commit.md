# Branch And Commit

## Branch

Create a new branch before editing or publishing changes. In this repository, prefer the `codex/<description>` prefix unless the user asks for a different branch name.

Use non-interactive git commands:

```sh
git checkout -b codex/<description>
```

If already on a suitable feature branch, continue there after checking `git status --short --branch`.

## Commit

Use the `commit` skill to create atomic, revertable Conventional Commits.

Before committing:

```sh
git status --short
git diff HEAD
git log --oneline -10
```

Check that the staged content contains only intended changes. Do not stage unrelated formatter churn, generated files, or user changes outside the task.

Use small follow-up commits for PR review fixes. Do not amend or force-push after reviewers have consumed the PR unless the user explicitly asks.
