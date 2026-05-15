# Getting Started

Welcome to ccusage! This guide will help you get up and running with analyzing your coding agent usage data.

## Prerequisites

- At least one supported coding agent installed and used
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

```bash [claude x]
BUN_BE_BUN=1 claude x ccusage
```

:::

This will show your daily usage report for all detected supported agents by default.

## Your First Report

When you run ccusage for the first time, you'll see a table showing detected coding agent usage by date:

```text
╭──────────────────────────────────────────╮
│                                          │
│  Coding Agent Usage Report - Daily       │
│                                          │
╰──────────────────────────────────────────╯

┌──────────────┬──────────────────┬────────┬─────────┬────────────┐
│ Date         │ Agent  │ Models           │  Input │  Output │ Cost (USD) │
├──────────────┼──────────────────┼────────┼─────────┼────────────┤
│ 2025-06-21   │ Claude │ • sonnet-4       │  1,234 │  15,678 │    $12.34  │
│ 2025-06-20   │ Codex  │ • gpt-5-codex    │    890 │  12,345 │    $18.92  │
└──────────────┴──────────────────┴────────┴─────────┴────────────┘
```

## Understanding the Output

### Columns Explained

- **Date**: The date when an agent was used
- **Agent**: The coding agent that generated the usage
- **Models**: Which models were used
- **Input**: Number of input tokens sent to the agent/model
- **Output**: Number of output tokens received from the agent/model
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
4. **[Statusline](/guide/statusline)** - Real-time usage display for Claude Code status bar
5. **[Configuration](/guide/configuration)** - Customize ccusage behavior

## Common Use Cases

### Monitor Daily Usage

```bash
ccusage daily --since 2024-12-01 --until 2024-12-31
```

### Show One Agent

```bash
ccusage codex daily
ccusage claude monthly
```

### Use Agent-Specific Options

```bash
ccusage claude daily --mode display
ccusage codex daily --speed fast
ccusage opencode weekly
```

### Analyze Sessions

```bash
ccusage session
```

### Export for Analysis

```bash
ccusage monthly --json > usage-data.json
```

### Real-time Status Display

Add statusline to your Claude Code settings:

```bash
# Using jq to add statusline configuration
jq '.statusLine = {"type": "command", "command": "bun x ccusage statusline", "padding": 0}' \
  ~/.config/claude/settings.json > tmp.json && mv tmp.json ~/.config/claude/settings.json
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

1. **A supported coding agent is installed and used** - ccusage reads from local usage files
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
- Use [JSON Output](/guide/json-output) for programmatic usage
