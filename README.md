# claude-code-usage

[![npm version](https://badge.fury.io/js/claude-code-usage.svg)](https://www.npmjs.com/package/claude-code-usage)

<div align="center">
  <img src="./docs/screenshot.png">
</div>

A CLI tool for analyzing Claude Code usage from local JSONL files.

Inspired by [this article](https://note.com/milliondev/n/n1d018da2d769) about tracking Claude Code usage costs.

## Features

- 📊 **Daily Report**: View token usage and costs aggregated by date
- 💬 **Session Report**: View usage grouped by conversation sessions
- 📅 **Date Filtering**: Filter reports by date range using `--since` and `--until`
- 📁 **Custom Path**: Support for custom Claude data directory locations
- 🎨 **Beautiful Output**: Colorful table-formatted display
- 📄 **JSON Output**: Export data in structured JSON format with `--json`
- 💰 **Cost Tracking**: Shows costs in USD for each day/session

## Installation

### Quick Start (Recommended)

Run directly without installation:

```bash
# Using npx
npx claude-code-usage@latest report daily

# Using bunx
bunx claude-code-usage report daily
```

### Local Installation

```bash
# Install globally with npm
npm install -g claude-code-usage

# Install globally with bun
bun install -g claude-code-usage

# Then run
claude-code-usage report daily
```

### Development Setup

```bash
# Clone the repository
git clone https://github.com/ryoppippi/claude-code-usage.git
cd claude-code-usage

# Install dependencies
bun install

# Run the tool
bun run report [subcommand] [options]
```

## Usage

### Daily Report (Default)

Shows token usage and costs aggregated by date:

```bash
# Show all daily usage
claude-code-usage report daily
# or: npx claude-code-usage@latest report daily
# or: bunx claude-code-usage report daily

# Filter by date range
claude-code-usage report daily --since 20250525 --until 20250530

# Use custom Claude data directory
claude-code-usage report daily --path /custom/path/to/.claude

# Output in JSON format
claude-code-usage report daily --json
```

### Session Report

Shows usage grouped by conversation sessions, sorted by cost:

```bash
# Show all sessions
claude-code-usage report session

# Filter sessions by last activity date
claude-code-usage report session --since 20250525

# Combine filters
claude-code-usage report session --since 20250525 --until 20250530 --path /custom/path

# Output in JSON format
claude-code-usage report session --json
```

### Options

All commands support the following options:

- `-s, --since <date>`: Filter from date (YYYYMMDD format)
- `-u, --until <date>`: Filter until date (YYYYMMDD format)  
- `-p, --path <path>`: Custom path to Claude data directory (default: `~/.claude`)
- `-j, --json`: Output results in JSON format instead of table
- `-h, --help`: Display help message
- `-v, --version`: Display version

## Output Example

### Daily Report
```
╭──────────────────────────────────────────╮
│                                          │
│  Claude Code Token Usage Report - Daily  │
│                                          │
╰──────────────────────────────────────────╯

┌──────────────────┬──────────────┬───────────────┬──────────────┬────────────┐
│ Date             │ Input Tokens │ Output Tokens │ Total Tokens │ Cost (USD) │
├──────────────────┼──────────────┼───────────────┼──────────────┼────────────┤
│ 2025-05-30       │          277 │        31,456 │       31,733 │     $17.45 │
│ 2025-05-29       │          959 │        39,662 │       40,621 │     $16.37 │
│ 2025-05-28       │          155 │        21,693 │       21,848 │      $8.33 │
├──────────────────┼──────────────┼───────────────┼──────────────┼────────────┤
│ Total            │       11,174 │       720,366 │      731,540 │    $336.17 │
└──────────────────┴──────────────┴───────────────┴──────────────┴────────────┘
```

### Session Report
```
╭───────────────────────────────────────────────╮
│                                               │
│  Claude Code Token Usage Report - By Session  │
│                                               │
╰───────────────────────────────────────────────╯

┌──────────────────────────────┬──────────────┬───────────────┬──────────────┬────────────┬───────────────┐
│ Project / Session            │ Input Tokens │ Output Tokens │ Total Tokens │ Cost (USD) │ Last Activity │
├──────────────────────────────┼──────────────┼───────────────┼──────────────┼────────────┼───────────────┤
│ my-project                   │        2,775 │       186,645 │      189,420 │     $98.40 │ 2025-05-26    │
│   └─ session-abc123...       │              │               │              │            │               │
│ another-project              │        1,063 │        41,421 │       42,484 │     $20.08 │ 2025-05-29    │
│   └─ session-def456...       │              │               │              │            │               │
├──────────────────────────────┼──────────────┼───────────────┼──────────────┼────────────┼───────────────┤
│ Total                        │       11,174 │       720,445 │      731,619 │    $336.38 │               │
└──────────────────────────────┴──────────────┴───────────────┴──────────────┴────────────┴───────────────┘
```

## Requirements

- [Bun](https://bun.sh) runtime
- Claude Code usage history files (`~/.claude/projects/**/*.jsonl`)

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint

# Format code
bun run format
```

## Project Structure

```
claude-code-usage/
├── commands/
│   ├── daily.ts      # Daily report command
│   └── session.ts    # Session report command
├── data-loader.ts    # JSONL data loading logic
├── index.ts          # CLI entry point
├── logger.ts         # Logger configuration
├── utils.ts          # Shared utilities
└── package.json
```

## License

MIT

## Author

[@ryoppippi](https://github.com/ryoppippi)

## Inspiration

This tool was inspired by [this excellent article](https://note.com/milliondev/n/n1d018da2d769) by [@milliondev](https://note.com/milliondev) about tracking Claude Code usage costs. The article demonstrates how to analyze Claude Code's local JSONL files using DuckDB to understand token usage patterns and costs.

While the original approach uses DuckDB for analysis, this tool provides a more accessible CLI interface with the same core functionality - analyzing the same JSONL files that Claude Code stores locally to give you insights into your usage patterns and costs.

## Acknowledgments

Thanks to [@milliondev](https://note.com/milliondev) for the original concept and approach to Claude Code usage analysis.
