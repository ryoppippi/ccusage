# Codex Last N Days Report (Beta)

Use the `last` command to view usage for the most recent **N days**, automatically **excluding today**.

```bash
# Last 10 days, excluding today
npx @ccusage/codex@latest last --day 10

# JSON output (includes computed range)
npx @ccusage/codex@latest last --day 10 --json
```

## How the date range works

`--day <n>` is converted to a closed date range:

- **End date (`until`)**: yesterday
- **Start date (`since`)**: `n - 1` days before yesterday

For example, if today is `2026-03-29` and `--day 10`:

- since = `2026-03-19`
- until = `2026-03-28`

The CLI prints the computed start/end dates in terminal output, and `--json` output includes:

```json
{
	"range": {
		"since": "2026-03-19",
		"until": "2026-03-28"
	}
}
```

## Validation rules for `--day`

`--day` must be a positive integer:

- ✅ valid: `1`, `7`, `30`
- ❌ invalid: `abc`, `0`, `-3`

Invalid input exits with an explicit error message.

## Related commands

- [Daily report command](./daily.md)
- [Monthly report command](./monthly.md)
- [Session report command](./session.md)
