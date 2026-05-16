# Introduction

![ccusage daily report showing token usage and costs by date](/screenshot.png)

**ccusage** is a local CLI for understanding coding agent token usage and estimated costs across Claude Code, Codex, OpenCode, Amp, and pi-agent.

## The Problem

Modern coding agent usage is split across several CLIs and local data formats. That makes basic questions hard to answer:

- How much am I actually using each coding agent?
- Which conversations are the most expensive?
- What would I be paying on a pay-per-use plan?
- Which projects, sessions, or weeks are driving usage?

## The Solution

ccusage reads the local usage files that coding agents already generate and provides:

- **Detailed Usage Reports** - Daily, weekly, monthly, and session-based breakdowns
- **Unified Agent Reports** - Claude Code, Codex, OpenCode, Amp, and pi-agent in one CLI
- **Cost Analysis** - Estimated costs based on token usage and model pricing
- **Focused Data Source Views** - Start with all detected agents, then narrow the same reports to one source when needed
- **Claude Code Integrations** - Statusline and 5-hour block reports for Claude Code-specific workflows
- **Multiple Formats** - Beautiful tables or JSON for further analysis

## How It Works

1. **Coding agents generate local usage files** containing usage data
2. **ccusage reads these files** from your local machine
3. **Analyzes and aggregates** the data by date, session, or time blocks
4. **Calculates estimated costs** using model pricing information
5. **Presents results** in beautiful tables or JSON format

## Key Features

### 🚀 Ultra-Small Bundle Size

Unlike many CLI tools, ccusage pays close attention to bundle size. You can run it directly without a global install using `bunx ccusage`, `npx ccusage@latest`, or `BUN_BE_BUN=1 claude x ccusage`.

### 📊 Multiple Report Types

- **Daily Reports** - Usage aggregated by calendar date
- **Weekly Reports** - Usage aggregated by week with configurable start day
- **Monthly Reports** - Monthly summaries with trends
- **Session Reports** - Per-conversation analysis
- **Blocks Reports** - Claude Code 5-hour billing window tracking

### 💰 Cost Analysis

- Estimated costs based on token counts and model pricing
- Support for different cost calculation modes
- Model-specific pricing across supported providers
- Cache token cost calculation

### 📈 Statusline Integration

- Compact real-time usage display for Claude Code status bar hooks
- Session cost, daily cost, and block cost tracking
- Burn rate calculations with visual indicators
- Context usage percentage with color-coded alerts

### 🔧 Flexible Configuration

- **JSON Configuration Files** - Set defaults for all commands or customize per-command
- **IDE Support** - JSON Schema for autocomplete and validation
- **Priority-based Settings** - CLI args > local config > user config > defaults
- **Multiple Claude Data Directories** - Automatic detection and aggregation
- **Environment Variables** - Traditional configuration options
- **Custom Date Filtering** - Flexible time range selection and sorting
- **Offline Mode** - Cached pricing data for air-gapped environments

## Data Sources

ccusage reads from local coding agent data directories:

| Agent       | ID         | Default data location                           |
| ----------- | ---------- | ----------------------------------------------- |
| Claude Code | `claude`   | `~/.config/claude/projects/`, `~/.claude/`      |
| Codex       | `codex`    | `${CODEX_HOME:-~/.codex}`                       |
| OpenCode    | `opencode` | `${OPENCODE_DATA_DIR:-~/.local/share/opencode}` |
| Amp         | `amp`      | `${AMP_DATA_DIR:-~/.local/share/amp}`           |
| pi-agent    | `pi`       | `${PI_AGENT_DIR:-~/.pi/agent/sessions}`         |

The tool automatically detects available data and aggregates all supported agents by default.

## Report Shape

Run ccusage without an agent name to aggregate all detected agents:

```bash
ccusage daily
ccusage weekly
ccusage monthly
ccusage session
```

Add a data source namespace when you want the same report focused on one source:

```bash
ccusage claude daily
ccusage codex daily --speed fast
ccusage opencode weekly
ccusage amp session
ccusage pi monthly
```

Use `ccusage <source> <report>` only when you want to narrow a report to one source.

## Privacy & Security

- **100% Local** - All analysis happens on your machine
- **No Data Transmission** - Your usage data never leaves your computer
- **Read-Only** - ccusage only reads files, never modifies them
- **Open Source** - Full transparency in how your data is processed

## Limitations

::: warning Important Limitations

- **Local Files Only** - Only analyzes data from your current machine
- **Language Model Tokens** - API calls for tools like Web Search are not included
- **Estimate Accuracy** - Costs are estimates and may not reflect actual billing
  :::

## Acknowledgments

Thanks to [@milliondev](https://note.com/milliondev) for the [original concept and approach](https://note.com/milliondev/n/n1d018da2d769) to Claude Code usage analysis.

## Getting Started

Ready to analyze your coding agent usage? Start with the [Getting Started Guide](/guide/getting-started).
