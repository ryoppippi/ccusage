# @ccusage/pi

Pi-agent usage tracking for ccusage - unified Claude Max usage across Claude Code and pi-agent.

## Installation

```bash
# Using npm
npm install -g @ccusage/pi

# Using pnpm
pnpm add -g @ccusage/pi

# Or run directly with npx
npx @ccusage/pi daily
```

## Usage

```bash
# Show daily combined usage (Claude Code + pi-agent)
ccusage-pi daily

# Show monthly combined usage
ccusage-pi monthly

# Show session-based usage
ccusage-pi session

# JSON output
ccusage-pi daily --json

# Custom pi-agent path
ccusage-pi daily --pi-path /path/to/sessions

# Filter by date range
ccusage-pi daily --since 2025-12-01 --until 2025-12-19
```

## What is pi-agent?

[Pi-agent](https://github.com/badlogic/pi-mono) is an alternative Claude coding agent from [shittycodingagent.ai](https://shittycodingagent.ai). It stores usage data in a similar JSONL format to Claude Code but in a different directory structure.

## How it works

This package combines usage data from:

- **Claude Code**: `~/.claude/projects/` or `~/.config/claude/projects/`
- **Pi-agent**: `~/.pi/agent/sessions/`

Reports show data from both sources with labels:

- `[cc]` - Claude Code
- `[pi]` - Pi-agent

## Environment Variables

- `PI_AGENT_DIR` - Custom path to pi-agent sessions directory

## Related

- [ccusage](https://github.com/ryoppippi/ccusage) - Usage analysis tool for Claude Code
