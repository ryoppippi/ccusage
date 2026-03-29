# Codex Daily Report (Beta)

The `daily` command mirrors ccusage's daily report but operates on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx @ccusage/codex@latest daily

# Using npx
npx @ccusage/codex@latest daily


# Last 10 days (excluding today)
npx @ccusage/codex@latest last --day 10
```

## Options

| Flag                         | Description                                                    |
| ---------------------------- | -------------------------------------------------------------- |
| `--since` / `--until`        | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD)       |
| `--timezone`                 | Override timezone used for grouping (defaults to system)       |
| `--locale`                   | Adjust date formatting locale                                  |
| `--json`                     | Emit structured JSON instead of a table                        |
| `--offline` / `--no-offline` | Force cached LiteLLM pricing or enable live fetching           |
| `--compact`                  | Force compact table layout (same columns as a narrow terminal) |
| `last --day <n>`             | Last n days (excluding today), and prints start/end date range |

The output uses the same responsive table component as ccusage, including compact mode support and per-model token summaries.

Need higher-level trends? Switch to the [monthly report](./monthly.md) for month-by-month rollups with the same flag set.
