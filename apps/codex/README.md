<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/codex-cli.jpeg" alt="Codex CLI usage screenshot" width="640">
  <h1>@ccusage/codex</h1>
  <p>Analyze <a href="https://github.com/openai/codex">OpenAI Codex CLI</a> usage logs with the same reporting experience as <code>ccusage</code>.</p>
</div>

> ⚠️ <strong>Beta:</strong> The Codex CLI support is experimental. Expect breaking changes until the upstream Codex tooling stabilizes.

## Quick Start

```bash
# Recommended (fastest)
bunx @ccusage/codex --help

# Using npx
npx @ccusage/codex@latest --help
```

> 💡 The CLI looks for Codex session JSONL files under `CODEX_HOME` (defaults to `~/.codex`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
bunx @ccusage/codex daily

# Date range filtering
bunx @ccusage/codex daily --since 20250911 --until 20250917

# JSON output for scripting
bunx @ccusage/codex daily --json

# Monthly usage grouped by month
bunx @ccusage/codex monthly

# Monthly JSON report for integrations
bunx @ccusage/codex monthly --json
```

Useful environment variables:

- `CODEX_HOME` – override the root directory that contains Codex session folders
- `CODEX_USAGE_MODEL` – default model name when a log entry is missing metadata
- `LOG_LEVEL` – controla consola log verbosity (0 silent … 5 trace)

## Features

- 📊 Responsive terminal tables shared with the `ccusage` CLI
- 💵 Offline-first pricing cache with automatic LiteLLM refresh when needed
- 🤖 Per-model token and cost aggregation, including cached token accounting
- 📅 Daily and monthly rollups with identical CLI options
- 📄 JSON output for further processing or scripting

## Documentation

For detailed guides and examples, visit **[ccusage.com/guide/codex](https://ccusage.com/guide/codex/)**.

## License

[MIT](../../LICENSE)
