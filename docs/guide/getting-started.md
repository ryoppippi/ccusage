# Getting Started

Welcome to ccusage! This guide will help you get up and running with analyzing your Claude Code usage data.

## Prerequisites

- Claude Code installed and used (generates JSONL files)
- Node.js 20+ or Bun runtime

## Quick Start

The fastest way to try ccusage is to run it directly without installation:

::: code-group

```bash [npx]
npx ccusage@latest
```

```bash [bunx]
bunx ccusage
```

```bash [pnpm]
pnpm dlx ccusage
```

:::

This will show your daily usage report by default.

## Your First Report

When you run ccusage for the first time, you'll see a table showing your Claude Code usage by date:

```
╭──────────────────────────────────────────╮
│                                          │
│  Claude Code Token Usage Report - Daily  │
│                                          │
╰──────────────────────────────────────────╯

┌──────────────┬──────────────────┬────────┬─────────┬────────────┐
│ Date         │ Models           │  Input │  Output │ Cost (USD) │
├──────────────┼──────────────────┼────────┼─────────┼────────────┤
│ 2025-06-21   │ • sonnet-4       │  1,234 │  15,678 │    $12.34  │
│ 2025-06-20   │ • opus-4         │    890 │  12,345 │    $18.92  │
└──────────────┴──────────────────┴────────┴─────────┴────────────┘
```

## Understanding the Output

### Columns Explained

- **Date**: The date when Claude Code was used
- **Models**: Which Claude models were used (Sonnet, Opus, etc.)
- **Input**: Number of input tokens sent to Claude
- **Output**: Number of output tokens received from Claude
- **Cost (USD)**: Estimated cost based on model pricing

### Cache Tokens

If you have a wide terminal, you'll also see cache token columns:

- **Cache Create**: Tokens used to create cache entries
- **Cache Read**: Tokens read from cache (typically cheaper)

## Next Steps

Now that you have your first report, explore these features:

1. **[Weekly Reports](/guide/weekly-reports)** - Track usage patterns by week
2. **[Monthly Reports](/guide/monthly-reports)** - See usage aggregated by month
3. **[Session Reports](/guide/session-reports)** - Analyze individual conversations
4. **[Live Monitoring](/guide/live-monitoring)** - Real-time usage tracking
5. **[Configuration](/guide/configuration)** - Customize ccusage behavior

## Common Use Cases

### Monitor Daily Usage

```bash
ccusage daily --since 20241201 --until 20241231
```

### Analyze Sessions

```bash
ccusage session
```

### Export for Analysis

```bash
ccusage monthly --json > usage-data.json
```

### Live Session Monitoring

```bash
ccusage blocks --live
```

## Colors

ccusage automatically colors the output based on the terminal's capabilities. If you want to disable colors, you can use the `--no-color` flag. Or you can use the `--color` flag to force colors on.

## Automatic Table Adjustment

ccusage automatically adjusts its table layout based on terminal width:

- **Wide terminals (≥100 characters)**: Full table with all columns including cache metrics, model names, and detailed breakdowns
- **Narrow terminals (<100 characters)**: Compact view with essential columns only (Date, Models, Input, Output, Cost)

The layout adjusts automatically based on your terminal width - no configuration needed. If you're in compact mode and want to see the full data, simply expand your terminal window.

## Troubleshooting

### No Data Found

If ccusage shows no data, check:

1. **Claude Code is installed and used** - ccusage reads from Claude Code's data files
2. **Data directory exists** - Default locations:
   - `~/.config/claude/projects/` (new default)
   - `~/.claude/projects/` (legacy)

### Custom Data Directory

If your Claude data is in a custom location:

```bash
export CLAUDE_CONFIG_DIR="/path/to/your/claude/data"
ccusage daily
```

## Getting Help

- Use `ccusage --help` for command options
- Visit our [GitHub repository](https://github.com/ryoppippi/ccusage) for issues
- Check the [API Reference](/api/) for programmatic usage
