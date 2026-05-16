---
name: fix-ci
description: Diagnose and fix failing GitHub Actions CI checks for the current pull request using gh, including check inspection, failed log retrieval, focused fixes, validation, and small follow-up commits.
---

# Fix CI

Use this when a PR check fails or the user asks to fix CI. This skill is repo-local so contributors can follow the same workflow without relying on a personal global skill.

## Workflow

1. Inspect PR checks:

   ```sh
   gh pr checks
   gh pr view --json url,headRefName,statusCheckRollup
   ```

2. Identify failed GitHub Actions runs and jobs. Ignore pending checks until they finish unless the failure is already clear.

3. Fetch failed logs:

   ```sh
   gh run view <run-id> --log-failed
   gh run view <run-id> --json jobs
   ```

4. Fix the smallest cause that explains the failed check. Use the relevant repo skill for the area being changed, such as `ccusage-testing`, `ccusage-development`, or `ccusage-docs`.

5. Validate locally with the narrowest command that reproduces the failure, then run the relevant broader checks. Let git hooks run normally.

6. Commit the fix as a small independently revertable commit using the `commit` skill. If the fix requires a manifest or lockfile update, include both in the same commit.

7. Push normally and use `pr-ai-review-workflow` to comment or request another review pass when appropriate.

## Notes

- Prefer `gh` over browser-only inspection so logs and job IDs are reproducible.
- Do not mix unrelated review cleanups into a CI fix commit.
- If CI failed because of generated output or formatting, commit only the generated/formatting result that the failing check requires.
