# Codex Monthly Report (Beta)

![Codex CLI monthly report](/codex-cli.jpeg)

The `monthly` command mirrors ccusage's monthly report while operating on Codex CLI session logs.

```bash
# Recommended (fastest)
bunx ccusage codex monthly

# Using npx
npx ccusage@latest codex monthly
```

## Options

| Flag                           | Description                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| `--since` / `--until`          | Filter to a specific date range (YYYYMMDD or YYYY-MM-DD) before aggregating |
| `--timezone`                   | Override the timezone used to bucket usage into months                      |
| `--json`                       | Emit structured JSON instead of a table                                     |
| `--offline` / `--no-offline`   | Force cached LiteLLM pricing or enable live fetching                        |
| `--speed auto\|standard\|fast` | Cost speed tier; default `auto` reads Codex `config.toml`                   |
| `--compact`                    | Force compact table layout (same columns as a narrow terminal)              |

With `--speed auto`, the command reads `${CODEX_HOME:-~/.codex}/config.toml` and applies fast pricing when `service_tier = "priority"` or legacy `service_tier = "fast"` is configured. Fast mode uses the model-specific LiteLLM multiplier when available and otherwise falls back to 2x pricing. Use `--speed fast` or `--speed standard` to override that config-based default.

The output uses the same responsive table component as ccusage, including compact mode support, per-model token summaries, and a combined totals row.
