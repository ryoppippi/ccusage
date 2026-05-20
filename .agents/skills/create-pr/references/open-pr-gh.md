# Open PR gh Usage

Create the PR with `gh pr create`.

Pass multi-line PR bodies through stdin with `--body-file -`. Do not embed `\n`
escape sequences inside a quoted `--body` argument because shell quoting can
preserve them literally.

Good:

```sh
gh pr create --title "docs(skills): add create-pr workflow" --body-file - <<'EOF'
Adds a repo-local create-pr skill and documents the PR review loop.

Testing:
- pnpm run format
EOF
```

For fish, prefer piping `printf` into `--body-file -` instead of using a
heredoc:

```fish
printf "%s\n" \
	"Adds a repo-local create-pr skill and documents the PR review loop." \
	"" \
	"Testing:" \
	"- pnpm run format" \
	| gh pr create --title "docs(skills): add create-pr workflow" --body-file -
```

Bad:

```sh
gh pr create --title "docs(skills): add create-pr workflow" --body "Adds skill.\n\nTesting:\n- pnpm run format"
```

Open the PR in the browser with `gh pr view --web` when that helps the user or
local workflow.
