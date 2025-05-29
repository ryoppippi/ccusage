# claude-code-tools

A CLI tool for analyzing Claude Code usage and costs from local JSONL files.

Inspired by [this article](https://note.com/milliondev/n/n1d018da2d769) about tracking Claude Code usage costs.

## Features

- 📊 **Daily Report**: View token usage and costs aggregated by date
- 💬 **Session Report**: View usage grouped by conversation sessions
- 📅 **Date Filtering**: Filter reports by date range using `--since` and `--until`
- 📁 **Custom Path**: Support for custom Claude data directory locations
- 🎨 **Beautiful Output**: Colorful table-formatted display
- 💰 **Cost Tracking**: Shows costs in USD for each day/session

## Installation

```bash
# Clone the repository
git clone https://github.com/ryoppippi/claude-code-tools.git
cd claude-code-tools

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
bun run report daily

# Filter by date range
bun run report daily --since 20250525 --until 20250530

# Use custom Claude data directory
bun run report daily --path /custom/path/to/.claude
```

### Session Report

Shows usage grouped by conversation sessions, sorted by cost:

```bash
# Show all sessions
bun run report session

# Filter sessions by last activity date
bun run report session --since 20250525

# Combine filters
bun run report session --since 20250525 --until 20250530 --path /custom/path
```

### Options

All commands support the following options:

- `-s, --since <date>`: Filter from date (YYYYMMDD format)
- `-u, --until <date>`: Filter until date (YYYYMMDD format)  
- `-p, --path <path>`: Custom path to Claude data directory (default: `~/.claude`)
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
claude-code-tools/
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

## Acknowledgments

This tool was inspired by [this article](https://note.com/milliondev/n/n1d018da2d769) about tracking Claude Code usage with DuckDB.