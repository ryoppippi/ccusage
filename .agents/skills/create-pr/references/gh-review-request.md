# GitHub Review Request Commands

Use current repository reviewer mentions. These are examples only:

```sh
gh pr comment <pr-number-or-url> --body '@coderabbitai review
@cubic-dev-ai review'
```

Poll PR state:

```sh
gh pr view <pr-number-or-url> --json url,state,headRefName,comments,reviews,statusCheckRollup
```
