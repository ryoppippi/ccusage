# Codex Monthly Report (Beta)

![Codex CLI monthly report](/codex-cli.jpeg)

The `monthly` command mirrors ccusage's monthly report while operating on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx @ccusage/codex@latest monthly

# Using npx
npx @ccusage/codex@latest monthly
```

## Options

| Flag                         | Description                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `--since` / `--until`        | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD) before aggregating             |
| `--codex-home`               | Override Codex home(s). Accepts comma-separated paths and optional `label=path` entries |
| `--by-account`               | Split monthly rows by account when multiple Codex homes are configured                  |
| `--timezone`                 | Override the timezone used to bucket usage into months                                  |
| `--locale`                   | Adjust month label formatting                                                           |
| `--json`                     | Emit structured JSON instead of a table                                                 |
| `--offline` / `--no-offline` | Force cached LiteLLM pricing or enable live fetching                                    |
| `--compact`                  | Force compact table layout (same columns as a narrow terminal)                          |

The output uses the same responsive table component as ccusage, including compact mode support, per-model token summaries, and a combined totals row.
