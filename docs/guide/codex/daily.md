# Codex Daily Report (Beta)

The `daily` command mirrors ccusage's daily report but operates on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx ccusage codex daily

# Using npx
npx ccusage@latest codex daily
```

## Options

| Flag                           | Description                                                    |
| ------------------------------ | -------------------------------------------------------------- |
| `--since` / `--until`          | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD)       |
| `--timezone`                   | Override timezone used for grouping (defaults to system)       |
| `--json`                       | Emit structured JSON instead of a table                        |
| `--offline` / `--no-offline`   | Force cached LiteLLM pricing or enable live fetching           |
| `--speed auto\|standard\|fast` | Cost speed tier; default `auto` reads Codex `config.toml`      |
| `--compact`                    | Force compact table layout (same columns as a narrow terminal) |

With `--speed auto`, the command reads `${CODEX_HOME:-~/.codex}/config.toml` and applies fast pricing when `service_tier = "priority"` or legacy `service_tier = "fast"` is configured. Fast mode uses the model-specific LiteLLM multiplier when available and otherwise falls back to 2x pricing. Use `--speed fast` or `--speed standard` to override that config-based default.

The output uses the same responsive table component as ccusage, including compact mode support and per-model token summaries.

Need higher-level trends? Switch to the [monthly report](./monthly.md) for month-by-month rollups with the same flag set.
