# Codex Session Report (Beta)

The `session` command groups Codex CLI usage by individual sessions so you can spot long-running conversations, confirm last activity times, and audit model switches inside a single log.

Sessions are listed oldest-to-newest by their last activity timestamp so the output lines up with the daily and monthly views. Each row shows the activity date, the Codex session directory, and a short session identifier (last 8 characters of the log filename) alongside token and cost columns. When your terminal narrows (or `--compact` is passed) the table automatically collapses to just Date, Directory, Session, Input, Output, and Cost to stay readable.

```bash
# Recommended (fastest)
bunx @ccusage/codex@latest session

# Using npx
npx @ccusage/codex@latest session
```

## Options

| Flag                           | Description                                                              |
| ------------------------------ | ------------------------------------------------------------------------ |
| `--since` / `--until`          | Filter sessions by their activity date (YYYYMMDD or YYYY-MM-DD)          |
| `--timezone`                   | Override the timezone used for date grouping and last-activity display   |
| `--json`                       | Emit structured JSON (`{ sessions: [], totals: {} }`) instead of a table |
| `--offline` / `--no-offline`   | Force cached LiteLLM pricing or enable live fetching                     |
| `--speed auto\|standard\|fast` | Cost speed tier; default `auto` reads Codex `config.toml`                |
| `--compact`                    | Force compact table layout (same columns as a narrow terminal)           |

With `--speed auto`, the command reads `${CODEX_HOME:-~/.codex}/config.toml` and applies fast pricing when `service_tier = "priority"` or legacy `service_tier = "fast"` is configured. Fast mode uses the model-specific LiteLLM multiplier when available and otherwise falls back to 2x pricing. Use `--speed fast` or `--speed standard` to override that config-based default.

JSON output includes a `sessions` array with per-model breakdowns, cached token counts, `lastActivity`, and `isFallback` flags for any events that required the legacy `gpt-5` pricing fallback.

Need time-based rollups instead? Check out the [daily](./daily.md) and [monthly](./monthly.md) reports for broader aggregates that reuse the same data source.
