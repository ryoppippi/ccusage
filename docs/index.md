---
layout: home

hero:
  name: ccusage
  text: Claude Code Usage Analysis
  tagline: A powerful CLI tool for analyzing Claude Code usage from local JSONL files
  image:
    src: /logo.svg
    alt: ccusage logo
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/ryoppippi/ccusage

features:
  - icon: 📊
    title: Daily Reports
    details: View token usage and costs aggregated by date with detailed breakdowns
  - icon: 📅
    title: Monthly Reports
    details: Analyze usage patterns over monthly periods with cost tracking
  - icon: 💬
    title: Session Reports
    details: Group usage by conversation sessions for detailed analysis
  - icon: ⏰
    title: 5-Hour Blocks
    details: Track usage within Claude's billing windows with active monitoring
  - icon: 📈
    title: Live Monitoring
    details: Real-time dashboard with progress bars and cost projections
  - icon: 🤖
    title: Model Tracking
    details: See which Claude models you're using (Opus, Sonnet, etc.)
  - icon: 📋
    title: Enhanced Display
    details: Beautiful tables with responsive layout and smart formatting
  - icon: 📄
    title: JSON Output
    details: Export data in structured JSON format for programmatic use
  - icon: 💰
    title: Cost Analysis
    details: Shows estimated costs in USD for each day/month/session
  - icon: 🔄
    title: Cache Support
    details: Tracks cache creation and cache read tokens separately
  - icon: 🌐
    title: Offline Mode
    details: Use pre-cached pricing data without network connectivity
  - icon: 🔌
    title: MCP Integration
    details: Built-in Model Context Protocol server for tool integration
---

## Quick Start

Get started with ccusage in seconds using your preferred package manager:

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

```bash [deno]
deno run -E -R=$HOME/.claude/projects/ -S=homedir -N='raw.githubusercontent.com:443' npm:ccusage@latest
```

:::

## What is ccusage?

**ccusage** (claude-code-usage) is a CLI tool that analyzes your Claude Code usage data to help you understand your token consumption and estimated costs.

Claude Code's Max plan offers unlimited usage - but wouldn't it be interesting to know how much you'd be paying if you were on a pay-per-use plan? This tool helps you understand the value you're getting from your subscription by calculating the equivalent costs of your actual usage.

### Key Benefits

- 📊 **Understand Usage Patterns** - See when and how you use Claude Code most
- 💰 **Cost Awareness** - Get estimated costs to appreciate your subscription value
- 🔍 **Session Analysis** - Track individual conversation costs and token usage
- 📈 **Real-time Monitoring** - Live dashboard for active sessions
- 🤖 **Model Breakdown** - See which Claude models you use most

## Important Disclaimer

::: warning Cost Estimates Only
**This is NOT an official Claude tool** - it's an independent community project that analyzes locally stored usage data.

**Cost calculations are estimates only** and may not reflect actual billing. For official billing information, always refer to your Claude account dashboard.
:::

## Installation

### Global Installation

::: code-group

```bash [npm]
npm install -g ccusage
```

```bash [bun]
bun install -g ccusage
```

:::

### Development Setup

```bash
git clone https://github.com/ryoppippi/ccusage.git
cd ccusage
bun install
bun run start [subcommand] [options]
```

## Example Usage

```bash
# Show daily usage report
ccusage daily

# Show monthly report with model breakdown
ccusage monthly --breakdown

# Live monitoring of current session
ccusage blocks --live

# Export data as JSON
ccusage session --json
```

## Related Projects

Projects that use ccusage internally:

- [claude-usage-tracker-for-mac](https://github.com/penicillin0/claude-usage-tracker-for-mac) - macOS menu bar app
- [ccusage Raycast Extension](https://www.raycast.com/nyatinte/ccusage) - Raycast integration
- [claude-code-usage-monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) - Real-time terminal monitor
- [ClaudeCode_Dashboard](https://github.com/m-sigepon/ClaudeCode_Dashboard) - Web dashboard with charts
