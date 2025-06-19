<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>ccusage</h1>
</div>

<p align="center">
    <a href="https://npmjs.com/package/ccusage"><img src="https://img.shields.io/npm/v/ccusage?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22ccusage%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dy/ccusage" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=ccusage"><img src="https://packagephobia.com/badge?p=ccusage" alt="install size" /></a>
    <a href="https://deepwiki.com/ryoppippi/ccusage"><img src="https://img.shields.io/badge/DeepWiki-ryoppippi%2Fccusage-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki" /></a>
    <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code" /></a>
</p>

<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/screenshot.png">
</div>

> **ccusage(claude-code-usage)**

A CLI tool for analyzing Claude Code usage from local JSONL files.

Inspired by [this article](https://note.com/milliondev/n/n1d018da2d769) about tracking Claude Code usage costs.

## What is `ccusage` (by NotebookLM)

<details>
    <summary>Podcast</summary>

# English

<https://github.com/user-attachments/assets/7a00f2f3-82a7-41b6-a8da-e04b76b5e35a>

# 日本語

<https://github.com/user-attachments/assets/db09fc06-bf57-4d37-9b06-514851bcc1d0>

</details>

## Motivation

Claude Code's Max plan offers unlimited usage - but wouldn't it be interesting to know how much you'd be paying if you were on a pay-per-use plan?

This tool helps you understand the value you're getting from your subscription by calculating the equivalent costs of your actual usage. See how much you're saving and enjoy that satisfying feeling of getting great value! 😊

## Features

- 📊 **Daily Report**: View token usage and costs aggregated by date
- 📅 **Monthly Report**: View token usage and costs aggregated by month
- 💬 **Session Report**: View usage grouped by conversation sessions
- ⏰ **5-Hour Blocks Report**: Track usage within Claude's billing windows with active block monitoring
- 🤖 **Model Tracking**: See which Claude models you're using (Opus, Sonnet, etc.)
- 📊 **Model Breakdown**: View per-model cost breakdown with `--breakdown` flag
- 📅 **Date Filtering**: Filter reports by date range using `--since` and `--until`
- 📁 **Custom Path**: Support for custom Claude data directory locations
- 🎨 **Beautiful Output**: Colorful table-formatted display with responsive width adjustment
- 📄 **JSON Output**: Export data in structured JSON format with `--json`
- 💰 **Cost Tracking**: Shows costs in USD for each day/month/session
- 🔄 **Cache Token Support**: Tracks and displays cache creation and cache read tokens separately
- 🌐 **Offline Mode**: Use pre-cached pricing data without network connectivity with `--offline` (Claude models only)
- 📏 **Responsive Tables**: Automatic table width adjustment for narrow terminals with intelligent word wrapping
- 🔌 **MCP Integration**: Built-in Model Context Protocol server for integration with other tools

## Important Disclaimer

⚠️ **This is NOT an official Claude tool** - it's an independent community project that analyzes locally stored usage data.

**Cost calculations are estimates only** and may not reflect actual billing:

- Costs shown are virtual/estimated based on token counts and model pricing data
- Actual costs may vary due to pricing changes, special rates, or billing adjustments
- We do not guarantee the accuracy of calculated costs
- For official billing information, always refer to your Claude account dashboard

## Limitations

- This tool only reads local JSONL files generated by Claude Code. If you use Claude Code with multiple devices, you need to ensure the JSONL files are synchronized across devices.
- API usage for tools like Web Search, Code Execution, and Image Analysis are not included in the token usage reports. The tool only tracks language model token usage.

## Installation

### Quick Start (Recommended)

Run directly without installation:

```bash
# Using npx
npx ccusage@latest

# Using bunx
bunx ccusage

# Using pnpm
pnpm dlx ccusage

# Using Deno with security flags
deno run -E -R=$HOME/.claude/projects/ -S=homedir -N='raw.githubusercontent.com:443' npm:ccusage@latest
```

### Local Installation

```bash
# Install globally with npm
npm install -g ccusage

# Install globally with bun
bun install -g ccusage

# Then run
ccusage daily
```

### Development Setup

```bash
# Clone the repository
git clone https://github.com/ryoppippi/ccusage.git
cd ccusage

# Install dependencies
bun install

# Run the tool
bun run start [subcommand] [options]
```

## Usage

### Daily Report (Default)

Shows token usage and costs aggregated by date:

```bash
# Show all daily usage
ccusage daily
# or: ccusage
# or: npx ccusage@latest daily
# or: bunx ccusage daily

# Filter by date range
ccusage daily --since 20250525 --until 20250530

# Set CLAUDE_CONFIG_DIR environment variable for custom data directory
export CLAUDE_CONFIG_DIR="/custom/path/to/.claude"
ccusage daily

# Output in JSON format
ccusage daily --json

# Control cost calculation mode
ccusage daily --mode auto       # Use costUSD when available, calculate otherwise (default)
ccusage daily --mode calculate  # Always calculate costs from tokens
ccusage daily --mode display    # Always show pre-calculated costUSD values

# Control sort order
ccusage daily --order asc       # Show oldest dates first
ccusage daily --order desc      # Show newest dates first (default)

# Show per-model cost breakdown
ccusage daily --breakdown       # Show cost breakdown by model (opus-4, sonnet-4, etc.)

# Use offline mode (no network required)
ccusage daily --offline         # Use pre-cached pricing data
ccusage daily -O                # Short alias for --offline
```

`ccusage` is an alias for `ccusage daily`, so you can run it without specifying the subcommand.

### Monthly Report

Shows token usage and costs aggregated by month:

```bash
# Show all monthly usage
ccusage monthly

# Filter by date range
ccusage monthly --since 20250101 --until 20250531

# Use custom Claude data directory
ccusage monthly --path /custom/path/to/.claude

# Or set CLAUDE_CONFIG_DIR environment variable
export CLAUDE_CONFIG_DIR="/custom/path/to/.claude"
ccusage monthly

# Output in JSON format
ccusage monthly --json

# Control cost calculation mode
ccusage monthly --mode auto       # Use costUSD when available, calculate otherwise (default)
ccusage monthly --mode calculate  # Always calculate costs from tokens
ccusage monthly --mode display    # Always show pre-calculated costUSD values

# Control sort order
ccusage monthly --order asc       # Show oldest months first
ccusage monthly --order desc      # Show newest months first (default)

# Show per-model cost breakdown
ccusage monthly --breakdown       # Show cost breakdown by model

# Use offline mode (no network required)
ccusage monthly --offline         # Use pre-cached pricing data
ccusage monthly -O                # Short alias for --offline
```

### Session Report

Shows usage grouped by conversation sessions, sorted by cost:

```bash
# Show all sessions
ccusage session

# Filter sessions by last activity date
ccusage session --since 20250525

# Combine filters with environment variable
export CLAUDE_CONFIG_DIR="/custom/path"
ccusage session --since 20250525 --until 20250530

# Output in JSON format
ccusage session --json

# Control cost calculation mode
ccusage session --mode auto       # Use costUSD when available, calculate otherwise (default)
ccusage session --mode calculate  # Always calculate costs from tokens
ccusage session --mode display    # Always show pre-calculated costUSD values

# Control sort order
ccusage session --order asc       # Show oldest sessions first
ccusage session --order desc      # Show newest sessions first (default)

# Show per-model cost breakdown
ccusage session --breakdown       # Show cost breakdown by model

# Use offline mode (no network required)
ccusage session --offline         # Use pre-cached pricing data
ccusage session -O                # Short alias for --offline
```

### 5-Hour Blocks Report

Shows usage grouped by Claude's 5-hour billing windows:

```bash
# Show all 5-hour blocks
ccusage blocks

# Show only the active block with detailed projections
ccusage blocks --active

# Show blocks from the last 3 days (including active)
ccusage blocks --recent

# Set a token limit to see if you'll exceed it
ccusage blocks -t 500000

# Use the highest previous block as the token limit
ccusage blocks -t max

# Combine options
ccusage blocks --recent -t max

# Output in JSON format
ccusage blocks --json

# Control cost calculation mode
ccusage blocks --mode auto       # Use costUSD when available, calculate otherwise (default)
ccusage blocks --mode calculate  # Always calculate costs from tokens
ccusage blocks --mode display    # Always show pre-calculated costUSD values

# Control sort order
ccusage blocks --order asc       # Show oldest blocks first
ccusage blocks --order desc      # Show newest blocks first (default)
```

The blocks report helps you understand Claude Code's 5-hour rolling session windows:

- Sessions start with your first message and last for 5 hours
- Shows active blocks with time remaining and burn rate projections
- Helps track if you're approaching token limits within a session
- The `-t max` option automatically uses your highest previous block as the limit

#### Blocks-specific options

- `-t, --token-limit <number|max>`: Set token limit for quota warnings (use "max" for highest previous block)
- `-a, --active`: Show only active block with detailed projections
- `-r, --recent`: Show blocks from last 3 days (including active)

### Options

All commands support the following options:

- `-s, --since <date>`: Filter from date (YYYYMMDD format)
- `-u, --until <date>`: Filter until date (YYYYMMDD format)
- `-j, --json`: Output results in JSON format instead of table
- `-m, --mode <mode>`: Cost calculation mode: `auto` (default), `calculate`, or `display`
- `-o, --order <order>`: Sort order: `desc` (newest first, default) or `asc` (oldest first).
- `-b, --breakdown`: Show per-model cost breakdown (splits usage by Opus, Sonnet, etc.)
- `-O, --offline`: Use pre-cached pricing data for Claude models (no network connection required)
- `-d, --debug`: Show pricing mismatch information for debugging
- `--debug-samples <number>`: Number of sample discrepancies to show in debug output (default: 5)
- `-h, --help`: Display help message
- `-v, --version`: Display version

#### Cost Calculation Modes

- **`auto`** (default): Uses pre-calculated `costUSD` values when available, falls back to calculating costs from token counts using model pricing
- **`calculate`**: Always calculates costs from token counts using model pricing, ignores any pre-calculated `costUSD` values
- **`display`**: Always uses pre-calculated `costUSD` values only, shows $0.00 for entries without pre-calculated costs

#### Environment Variable Support

The tool supports the `CLAUDE_CONFIG_DIR` environment variable to specify the Claude data directory:

```bash
# Set the environment variable to use a custom Claude directory
export CLAUDE_CONFIG_DIR="/path/to/custom/claude/directory"
ccusage daily

# The environment variable determines the Claude data directory
ccusage daily
```

The tool will use the path specified in the `CLAUDE_CONFIG_DIR` environment variable, or fall back to the default `~/.claude` directory if not set.

### MCP (Model Context Protocol) Support

Exposes usage data through Model Context Protocol for integration with other tools:

```bash
# Start MCP server with stdio transport (for local integration)
ccusage mcp

# Start MCP server with HTTP stream transport (for remote access)
ccusage mcp --type http --port 8080

# Control cost calculation mode
ccusage mcp --mode calculate
```

The MCP server supports both **stdio** and **HTTP stream** transports:

- **stdio** (default): Best for local integration where the client directly spawns the process
- **HTTP stream**: Best for remote access when you need to call the server from another machine or network location

Available MCP tools:

- `daily`: Returns daily usage reports (accepts `since`, `until`, `mode` parameters)
- `session`: Returns session usage reports (accepts `since`, `until`, `mode` parameters)
- `monthly`: Returns monthly usage reports (accepts `since`, `until`, `mode` parameters)
- `blocks`: Returns 5-hour billing blocks usage reports (accepts `since`, `until`, `mode` parameters)

#### Claude Desktop Configuration Example

<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/mcp-claude-desktop.avif">
</div>

To use ccusage MCP with Claude Desktop, add this to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
	"mcpServers": {
		"ccusage": {
			"command": "npx",
			"args": ["ccusage@latest", "mcp"],
			"env": {}
		}
	}
}
```

Or if you have ccusage installed globally:

```json
{
	"mcpServers": {
		"ccusage": {
			"command": "ccusage",
			"args": ["mcp"],
			"env": {}
		}
	}
}
```

After adding this configuration, restart Claude Desktop. You'll then be able to use the ccusage tools within Claude to analyze your usage data.

#### Testing MCP Server

You can test the MCP server interactively using the MCP Inspector:

```bash
# Test the MCP server with interactive web UI
bun run mcp
# or: npm run mcp

# Test specific MCP server command directly
bunx @modelcontextprotocol/inspector bunx ccusage mcp
```

The MCP Inspector provides a web-based interface to:

- Test individual MCP tools (daily, monthly, session, blocks)
- Inspect tool schemas and parameters
- Debug server responses
- Export server configurations

## Output Example

### Daily Report

```
╭──────────────────────────────────────────╮
│                                          │
│  Claude Code Token Usage Report - Daily  │
│                                          │
╰──────────────────────────────────────────╯

┌──────────────┬──────────────────┬────────┬─────────┬──────────────┬────────────┬──────────────┬────────────┐
│ Date         │ Models           │ Input  │ Output  │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │
├──────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2025-05-30   │ opus-4, sonnet-4 │    277 │  31,456 │          512 │      1,024 │       33,269 │     $17.58 │
│ 2025-05-29   │ sonnet-4         │    959 │  39,662 │          256 │        768 │       41,645 │     $16.42 │
│ 2025-05-28   │ opus-4           │    155 │  21,693 │          128 │        512 │       22,488 │      $8.36 │
├──────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ Total        │                  │ 11,174 │ 720,366 │          896 │      2,304 │      734,740 │    $336.47 │
└──────────────┴──────────────────┴────────┴─────────┴──────────────┴────────────┴──────────────┴────────────┘
```

With `--breakdown` flag:

```
╭──────────────────────────────────────────╮
│                                          │
│  Claude Code Token Usage Report - Daily  │
│                                          │
╰──────────────────────────────────────────╯

┌──────────────┬──────────────────┬────────┬─────────┬──────────────┬────────────┬──────────────┬────────────┐
│ Date         │ Models           │ Input  │ Output  │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │
├──────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2025-05-30   │ opus-4, sonnet-4 │    277 │  31,456 │          512 │      1,024 │       33,269 │     $17.58 │
├──────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│   └─ opus-4  │                  │    100 │  15,000 │          256 │        512 │       15,868 │     $10.25 │
├──────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│   └─ sonnet-4│                  │    177 │  16,456 │          256 │        512 │       17,401 │      $7.33 │
├──────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┤
│ Total        │                  │ 11,174 │ 720,366 │          896 │      2,304 │      734,740 │    $336.47 │
└──────────────┴──────────────────┴────────┴─────────┴──────────────┴────────────┴──────────────┴────────────┘
```

### Session Report

```
╭───────────────────────────────────────────────╮
│                                               │
│  Claude Code Token Usage Report - By Session  │
│                                               │
╰───────────────────────────────────────────────╯

┌────────────┬──────────────────┬────────┬─────────┬──────────────┬────────────┬──────────────┬────────────┬───────────────┐
│ Session    │ Models           │ Input  │ Output  │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │ Last Activity │
├────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┼───────────────┤
│ session-1  │ opus-4, sonnet-4 │  4,512 │ 350,846 │          512 │      1,024 │      356,894 │    $156.40 │ 2025-05-24    │
├────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┼───────────────┤
│ session-2  │ sonnet-4         │  2,775 │ 186,645 │          256 │        768 │      190,444 │     $98.45 │ 2025-05-25    │
├────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┼───────────────┤
│ Total      │                  │ 11,174 │ 720,445 │          768 │      1,792 │      734,179 │    $336.68 │               │
└────────────┴──────────────────┴────────┴─────────┴──────────────┴────────────┴──────────────┴────────────┴───────────────┘
```

## Requirements

- Claude Code usage history files (`~/.claude/projects/**/*.jsonl`)

## License

MIT

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

The logo and brand assets are also licensed under the MIT License. Created by [@nyatinte](https://github.com/nyatinte).

## Author

[@ryoppippi](https://github.com/ryoppippi)

## Inspiration

This tool was inspired by [this excellent article](https://note.com/milliondev/n/n1d018da2d769) by [@milliondev](https://note.com/milliondev) about tracking Claude Code usage costs. The article demonstrates how to analyze Claude Code's local JSONL files using DuckDB to understand token usage patterns and costs.

While the original approach uses DuckDB for analysis, this tool provides a more accessible CLI interface with the same core functionality - analyzing the same JSONL files that Claude Code stores locally to give you insights into your usage patterns and costs.

## Related Projects

some projects use `ccusage` internally and provide additional features:

- [claude-usage-tracker-for-mac](https://github.com/penicillin0/claude-usage-tracker-for-mac) – macOS menu bar app to visualize Claude Code usage costs by [@penicillin0](https://github.com/penicillin0).
- [ccusage Raycast Extension](https://www.raycast.com/nyatinte/ccusage) – Raycast extension to view Claude Code usage reports in Raycast by [@nyatinte](https://github.com/nyatinte).
- [ClaudeCode_Dashboard](https://github.com/m-sigepon/ClaudeCode_Dashboard) – Web dashboard to visualize Claude Code usage with charts and USD/JPY conversion by [@m-sigepon](https://github.com/m-sigepon).

## Acknowledgments

Thanks to [@milliondev](https://note.com/milliondev) for the original concept and approach to Claude Code usage analysis.

## Sponsors

<p align="center">
    <a href="https://github.com/sponsors/ryoppippi">
        <img src="https://cdn.jsdelivr.net/gh/ryoppippi/sponsors/sponsors.svg">
    </a>
</p>

## Star History

<a href="https://www.star-history.com/#ryoppippi/ccusage&Date">
    <picture>
        <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=ryoppippi/ccusage&type=Date&theme=dark" />
        <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=ryoppippi/ccusage&type=Date" />
        <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=ryoppippi/ccusage&type=Date" />
    </picture>
</a>
