# CI

## Poll Checks

Check CI after opening the PR and after every push:

```sh
gh pr checks <pr-number-or-url>
gh pr view <pr-number-or-url> --json statusCheckRollup
```

Inspect the discussion and failed logs before deciding what to fix. Do not rely only on the final summary if a workflow has failed steps or annotations.

## Fix Failures

If CI fails, use the `fix-ci` skill to diagnose logs, implement the fix, validate locally when practical, commit, and push.

After pushing a CI fix:

1. Poll checks again.
2. Request another AI review pass with a top-level bot mention comment if reviewers do not rerun automatically.
3. Keep working until all required checks pass.

Do not mark the PR ready while required checks are queued, cancelled, failing, or missing.
