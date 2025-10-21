# aiusage

> Unified usage tracker for all AI coding assistants

Track token usage and costs across multiple AI services in one place:
- ✅ **Claude Code** - Anthropic's AI coding assistant
- ✅ **OpenAI Codex CLI** - OpenAI's terminal-based coding agent
- 🚧 **Cursor AI** - Coming soon
- 🚧 **GitHub Copilot** - Coming soon

## Quick Start

```bash
# Recommended - always use @latest
npx aiusage@latest
bunx aiusage@latest

# Show unified dashboard
npx aiusage@latest dashboard

# Monthly breakdown across all services
npx aiusage@latest monthly

# Daily usage report
npx aiusage@latest daily

# JSON output for scripting
npx aiusage@latest dashboard --json
```

## Installation (Optional)

```bash
# Install globally
npm install -g aiusage
pnpm add -g aiusage
bun install -g aiusage

# Then run directly
aiusage dashboard
aiusage monthly
aiusage daily
```

## Features

### 📊 Unified Dashboard
See all your AI tool usage in one place:
```
Available Services:
  ✓ Claude Code (~/.config/claude)
  ✓ OpenAI Codex CLI (~/.codex)
  ✗ Cursor AI - Coming soon
  ✗ GitHub Copilot - Coming soon

Total Usage (All Time):
┌─────────────────┬──────────────┬──────────────┐
│ Service         │ Total Tokens │ Cost (USD)   │
├─────────────────┼──────────────┼──────────────┤
│ Claude Code     │  262,125,881 │     $924.48  │
│ OpenAI Codex    │            0 │       $0.00  │
├─────────────────┼──────────────┼──────────────┤
│ Total           │  262,125,881 │     $924.48  │
└─────────────────┴──────────────┴──────────────┘
```

### 📅 Monthly & Daily Reports
Aggregated views across all services with detailed token breakdowns

### 💵 Cost Tracking
Accurate cost calculation using LiteLLM pricing for all models

### 📄 JSON Output
Perfect for automation, monitoring, and custom reporting

## Supported Services

### ✅ Claude Code (Full Support)
- Data location: `~/.claude/` or `~/.config/claude/`
- Token types: Input, Output, Cache Creation, Cache Read
- Models: Claude Sonnet 4, Opus 4, etc.
- Cost calculation: Full LiteLLM pricing support

### ✅ OpenAI Codex CLI (Full Support)
- Data location: `~/.codex/sessions/`
- Token types: Input, Cached Input, Output, Reasoning
- Models: GPT-5, o1-preview, o1-mini, etc.
- Cost calculation: Full LiteLLM pricing support

### 🚧 Cursor AI (Coming Soon)
- Investigating data format and availability
- Will be added in a future release

### 🚧 GitHub Copilot (Coming Soon)
- Will integrate with GitHub API
- Requires organization/enterprise access

## Commands

```bash
# Dashboard (default) - Unified view of all services
aiusage
aiusage dashboard

# Monthly aggregated report
aiusage monthly
aiusage monthly --json

# Daily breakdown
aiusage daily
aiusage daily --json
```

## Environment Variables

```bash
# Claude Code data directory (if non-standard)
export CLAUDE_CONFIG_DIR="/custom/path/to/claude"

# Codex data directory (if non-standard)
export CODEX_HOME="/custom/path/to/codex"

# Logging verbosity (0=silent, 5=trace)
export LOG_LEVEL=3
```

## Architecture

`aiusage` is built on top of existing usage trackers:
- Reuses `ccusage` data loader for Claude Code
- Reuses `@ccusage/codex` data loader for Codex CLI
- Provides unified aggregation and reporting layer

## Comparison to Single-Service Tools

| Tool | Services | Use Case |
|------|----------|----------|
| `ccusage` | Claude Code only | Deep dive into Claude usage |
| `@ccusage/codex` | Codex CLI only | Deep dive into Codex usage |
| **`aiusage`** | **All services** | **Unified view across all AI tools** |

## Examples

### Dashboard
```bash
$ aiusage

AI Usage Dashboard - All Services

Available Services:
  ✓ Claude Code (~/.config/claude)
  ✓ OpenAI Codex CLI (~/.codex)

Total Usage (All Time):
┌─────────────────┬──────────────┬──────────────┐
│ Service         │ Total Tokens │ Cost (USD)   │
├─────────────────┼──────────────┼──────────────┤
│ Claude Code     │  262,125,881 │     $924.48  │
│ OpenAI Codex    │    1,234,567 │      $15.32  │
├─────────────────┼──────────────┼──────────────┤
│ Total           │  263,360,448 │     $939.80  │
└─────────────────┴──────────────┴──────────────┘

💡 Tip: Use `aiusage monthly` or `aiusage daily` for detailed breakdowns
```

### JSON Output
```bash
$ aiusage --json
{
  "services": [
    {
      "service": "claude",
      "available": true,
      "dataPath": "~/.config/claude"
    }
  ],
  "usage": {
    "claude": {
      "tokens": 262125881,
      "cost": 924.48
    }
  },
  "total": {
    "tokens": 262125881,
    "cost": 924.48
  }
}
```

## Related Projects

- [ccusage](https://github.com/ryoppippi/ccusage) - Usage tracker for Claude Code
- [@ccusage/codex](https://www.npmjs.com/package/@ccusage/codex) - Usage tracker for OpenAI Codex CLI

## Contributing

Contributions welcome! Areas of interest:
- Cursor AI data format investigation
- GitHub Copilot API integration
- Additional AI service support

## License

MIT © [@ryoppippi](https://github.com/ryoppippi)
