# Codex Session Report (Beta)

The `session` command groups Codex CLI usage by individual sessions so you can spot long-running conversations, confirm last activity times, and audit model switches inside a single log.

Sessions are listed oldest-to-newest by their last activity timestamp so the output lines up with the daily and monthly views. Each row shows the activity date, the Codex session directory, and a short session identifier (last 8 characters of the log filename) alongside token and cost columns. When your terminal narrows (or `--compact` is passed) the table automatically collapses to just Date, Directory, Session, Input, Output, and Cost to stay readable.

```bash
# Recommended (fastest)
bunx @better-ccusage/codex@latest session

# Using npx
npx @better-ccusage/codex@latest session
```

## Options

| Flag                         | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| `--since` / `--until`        | Filter sessions by their activity date (YYYYMMDD or YYYY-MM-DD)          |
| `--timezone`                 | Override the timezone used for date grouping and last-activity display   |
| `--locale`                   | Adjust locale for table and timestamp formatting                         |
| `--json`                     | Emit structured JSON (`{ sessions: [], totals: {} }`) instead of a table |
| `--offline` / `--no-offline` | Force cached pricing or enable live fetching                             |
| `--compact`                  | Force compact table layout (same columns as a narrow terminal)           |

JSON output includes a `sessions` array with per-model breakdowns, cached token counts, `lastActivity`, and `isFallback` flags for any events that required the legacy `gpt-5` pricing fallback.

Need time-based rollups instead? Check out the [daily](./daily.md) and [monthly](./monthly.md) reports for broader aggregates that reuse the same data source.
