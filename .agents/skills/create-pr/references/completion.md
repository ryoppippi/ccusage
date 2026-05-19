# Completion

Finish the PR workflow only when all completion conditions are satisfied:

- The branch is pushed and the PR exists.
- The PR body accurately describes the change and validation.
- CodeRabbit has reviewed the latest pushed commit.
- Cubic has reviewed the latest pushed commit when it is available on the PR.
- Reviewer bots have no unresolved actionable feedback.
- Every required CI check is passing.
- Any review-thread reply that asks a bot to act mentions that bot, such as `@coderabbitai` or `@cubic-dev-ai`.
- The user has been told the PR URL and any residual risk or pending external state.

If a bot or CI system does not respond after a reasonable polling window, do not claim completion. State exactly what is pending and leave the visible PR comment or CI state for follow-up.
