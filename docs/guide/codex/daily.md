# Codex Daily Report (Beta)

The `daily` command mirrors ccusage's daily report but operates on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx @ccusage/codex daily

# Using npx
npx @ccusage/codex@latest daily
```

## Options

| Flag                         | Description                                              |
| ---------------------------- | -------------------------------------------------------- |
| `--since` / `--until`        | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD) |
| `--timezone`                 | Override timezone used for grouping (defaults to system) |
| `--locale`                   | Adjust date formatting locale                            |
| `--json`                     | Emit structured JSON instead of a table                  |
| `--offline` / `--no-offline` | Force cached LiteLLM pricing or enable live fetching     |

The output uses the same responsive table component as ccusage, including compact mode support and per-model token summaries.

Need higher-level trends? Switch to the [monthly report](./monthly.md) for month-by-month rollups with the same flag set.
