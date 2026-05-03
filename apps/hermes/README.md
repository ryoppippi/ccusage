<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/hermes</h1>
</div>

> Analyze [Hermes Agent](https://hermes-agent.nousresearch.com/) usage from the local SQLite database with the same reporting experience as `ccusage`.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/hermes@latest --help
bunx @ccusage/hermes@latest --help

# Alternative package runners
pnpm dlx @ccusage/hermes
pnpx @ccusage/hermes
```

### Recommended: Shell Alias

```bash
# bash/zsh: alias ccusage-hermes='bunx @ccusage/hermes@latest'
# fish:     alias ccusage-hermes 'bunx @ccusage/hermes@latest'

# Then simply run:
ccusage-hermes daily
ccusage-hermes monthly --json
```

> 💡 The CLI looks for Hermes usage data under `HERMES_DATA_DIR` (defaults to `~/.hermes`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @ccusage/hermes@latest daily

# Weekly usage grouped by ISO week
npx @ccusage/hermes@latest weekly

# Monthly usage grouped by month
npx @ccusage/hermes@latest monthly

# Session-level detailed report
npx @ccusage/hermes@latest session

# JSON output for scripting
npx @ccusage/hermes@latest daily --json

# Compact mode for screenshots/sharing
npx @ccusage/hermes@latest daily --compact
```

Useful environment variables:

- `HERMES_DATA_DIR` – override the Hermes data directory (defaults to `~/.hermes`)
- `LOG_LEVEL` – control consola log verbosity (0 silent … 5 trace)

## Features

- 📊 **Daily Reports**: View token usage and costs aggregated by date
- 📅 **Weekly Reports**: View usage grouped by ISO week (YYYY-Www)
- 🗓️ **Monthly Reports**: View usage aggregated by month (YYYY-MM)
- 💬 **Session Reports**: View usage grouped by conversation sessions
- 📈 **Responsive Tables**: Automatic layout adjustment for terminal width
- 🤖 **Model Tracking**: See which models you're using across providers
- 💵 **Accurate Cost Calculation**: Uses LiteLLM pricing database to calculate costs from token data
- 🔄 **Cache Token Support**: Tracks and displays cache creation and cache read tokens separately
- 📄 **JSON Output**: Export data in structured JSON format with `--json`
- 📱 **Compact Mode**: Use `--compact` flag for narrow terminals, perfect for screenshots

## Cost Calculation

Hermes stores `estimated_cost_usd` and `actual_cost_usd` in the session table. When these are present and greater than zero, they are used directly. Otherwise, costs are calculated from token usage data using the LiteLLM pricing database.

## Data Location

Hermes stores usage data in:

- **Database**: `~/.hermes/state.db` (SQLite)
- **Table**: `sessions`
- **Key columns**: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `model`, `started_at`

## License

MIT © [@ryoppippi](https://github.com/ryoppippi)
