<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/droid</h1>
</div>

> Analyze Factory Droid usage logs with the same reporting experience as `ccusage`.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/droid@latest --help
bunx @ccusage/droid@latest --help

# Alternative package runners
pnpm dlx @ccusage/droid
pnpx @ccusage/droid
```

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @ccusage/droid@latest daily

# Monthly usage grouped by month
npx @ccusage/droid@latest monthly

# Session-level usage grouped by Factory session
npx @ccusage/droid@latest session

# JSON output for scripting
npx @ccusage/droid@latest daily --json

# Filter by date range
npx @ccusage/droid@latest daily --since 2026-01-01 --until 2026-01-10

# Read from a custom Factory data dir
npx @ccusage/droid@latest daily --factoryDir /path/to/.factory
```

## Data Source

This CLI reads Factory Droid logs from:

- `~/.factory/logs/droid-log-*.log`

You can override the Factory data directory via:

- `--factoryDir /path/to/.factory`
- `FACTORY_DIR=/path/to/.factory`

## Pricing

Costs are calculated from token counts using LiteLLM's pricing dataset.

- Use `--offline` to avoid fetching updated pricing.
- If a model is missing pricing data, its cost is treated as `$0` and reported as a warning.

## Custom Models

Factory supports custom model IDs (often prefixed with `custom:`). This CLI resolves them using:

- `~/.factory/settings.json` → `customModels[]`

Example:

```json
{
  "customModels": [
    {
      "id": "custom:GPT-5.2-(High)-18",
      "model": "gpt-5.2(high)",
      "provider": "openai"
    }
  ]
}
```

In tables, custom models are displayed as `gpt-5.2(high) [custom]`.

When a log line is missing a model tag, the CLI resolves the model from the session settings file and marks it as `[...] [inferred]`.

## Environment Variables

- `FACTORY_DIR` - override the Factory data directory
- `LOG_LEVEL` - control log verbosity (0 silent … 5 trace)

## License

MIT © [@ryoppippi](https://github.com/ryoppippi)
