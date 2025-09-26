# Codex Monthly Report (Beta)

![Codex CLI monthly report](/codex-cli.jpeg)

The `monthly` command mirrors ccusage's monthly report while operating on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx @better-ccusage/codex@latest monthly

# Using npx
npx @better-ccusage/codex@latest monthly
```

## Options

| Flag                         | Description                                                                 |
| ---------------------------- | --------------------------------------------------------------------------- |
| `--since` / `--until`        | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD) before aggregating |
| `--timezone`                 | Override the timezone used to bucket usage into months                      |
| `--locale`                   | Adjust month label formatting                                               |
| `--json`                     | Emit structured JSON instead of a table                                     |
| `--offline` / `--no-offline` | Force cached pricing or enable live fetching                                |
| `--compact`                  | Force compact table layout (same columns as a narrow terminal)              |

The output uses the same responsive table component as ccusage, including compact mode support, per-model token summaries, and a combined totals row.
