# Pi-Agent Integration

The `@ccusage/pi` package provides unified usage tracking across Claude Code and [pi-agent](https://github.com/badlogic/pi-mono), an alternative Claude coding agent from [shittycodingagent.ai](https://shittycodingagent.ai).

## What is Pi-Agent?

Pi-agent is a third-party Claude coding agent that stores usage data in a similar JSONL format to Claude Code but in a different directory structure. The `@ccusage/pi` package combines data from both sources to give you a complete view of your Claude Max usage.

## Installation & Launch

```bash
# Recommended - always include @latest
npx @ccusage/pi@latest --help
bunx @ccusage/pi@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/pi --help
pnpx @ccusage/pi --help
```

::: warning ⚠️ Critical for bunx users
Bun's bunx prioritizes binaries matching the package name suffix when given a scoped package. **Always use `bunx @ccusage/pi@latest` with the version tag** to force bunx to fetch and run the correct package.
:::

### Recommended: Shell Alias

Since `npx @ccusage/pi@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias for convenience:

```bash
# bash/zsh: alias ccusage-pi='bunx @ccusage/pi@latest'
# fish:     alias ccusage-pi 'bunx @ccusage/pi@latest'

# Then simply run:
ccusage-pi daily
ccusage-pi monthly --json
```

::: tip
After adding the alias to your shell config file (`.bashrc`, `.zshrc`, or `config.fish`), restart your shell or run `source` on the config file to apply the changes.
:::

## Data Sources

The CLI combines usage data from two sources:

| Source      | Label  | Default Path                                          |
| ----------- | ------ | ----------------------------------------------------- |
| Claude Code | `[cc]` | `~/.claude/projects/` or `~/.config/claude/projects/` |
| Pi-agent    | `[pi]` | `~/.pi/agent/sessions/`                               |

Reports display data from both sources with clear labels so you can identify where each entry originated.

## Available Commands

```bash
# Show daily combined usage (Claude Code + pi-agent)
ccusage-pi daily

# Show monthly combined usage
ccusage-pi monthly

# Show session-based usage
ccusage-pi session

# JSON output for automation
ccusage-pi daily --json

# Custom pi-agent path
ccusage-pi daily --pi-path /path/to/sessions

# Filter by date range
ccusage-pi daily --since 2025-12-01 --until 2025-12-19

# Show model breakdown
ccusage-pi daily --breakdown
```

## Environment Variables

| Variable            | Description                                    |
| ------------------- | ---------------------------------------------- |
| `PI_AGENT_DIR`      | Custom path to pi-agent sessions directory     |
| `CLAUDE_CONFIG_DIR` | Custom path(s) to Claude Code data directories |
| `LOG_LEVEL`         | Adjust logging verbosity (0 silent … 5 trace)  |

## Daily Report

The `daily` command shows combined daily usage from both Claude Code and pi-agent.

```bash
# Recommended (fastest)
bunx @ccusage/pi@latest daily

# Using npx
npx @ccusage/pi@latest daily
```

### Options

| Flag          | Short | Description                                   |
| ------------- | ----- | --------------------------------------------- |
| `--since`     |       | Start date filter (YYYY-MM-DD or YYYYMMDD)    |
| `--until`     |       | End date filter (YYYY-MM-DD or YYYYMMDD)      |
| `--timezone`  | `-z`  | Override timezone for date grouping           |
| `--json`      |       | Emit structured JSON instead of a table       |
| `--breakdown` | `-b`  | Show per-model token breakdown                |
| `--pi-path`   |       | Custom path to pi-agent sessions directory    |
| `--order`     |       | Sort order: `asc` or `desc` (default: `desc`) |

### Example Output

The output displays entries from both sources with clear labels:

- `[cc]` - Claude Code entries (green)
- `[pi]` - Pi-agent entries (cyan)

```
┌────────────────────┬────────────┬─────────────┬───────────┬───────────┬────────┬─────────┐
│ Date               │ Input      │ Output      │ Cache Cr. │ Cache Rd. │ Cost   │ Models  │
├────────────────────┼────────────┼─────────────┼───────────┼───────────┼────────┼─────────┤
│ 2025-01-09 [cc]    │ 1,234,567  │ 234,567     │ 12,345    │ 98,765    │ $1.23  │ opus-4  │
│            [pi]    │ 567,890    │ 123,456     │ 5,678     │ 45,678    │ $0.89  │ opus-4  │
├────────────────────┼────────────┼─────────────┼───────────┼───────────┼────────┼─────────┤
│ Total              │ 1,802,457  │ 358,023     │ 18,023    │ 144,443   │ $2.12  │         │
└────────────────────┴────────────┴─────────────┴───────────┴───────────┴────────┴─────────┘
```

### JSON Output

Use `--json` for automation and scripting:

```bash
ccusage-pi daily --json
```

Returns structured data:

<!-- eslint-skip -->

```json
{
  "daily": [
    {
      "date": "2025-01-09",
      "source": "claude-code",
      "inputTokens": 1234567,
      "outputTokens": 234567,
      "cacheCreationTokens": 12345,
      "cacheReadTokens": 98765,
      "totalCost": 1.23,
      "modelsUsed": ["claude-opus-4-5-20251101"],
      "modelBreakdowns": [...]
    },
    {
      "date": "2025-01-09",
      "source": "pi-agent",
      "inputTokens": 567890,
      ...
    }
  ],
  "totals": {
    "inputTokens": 1802457,
    "outputTokens": 358023,
    "cacheCreationTokens": 18023,
    "cacheReadTokens": 144443,
    "totalCost": 2.12
  }
}
```

### Date Filtering

Filter to a specific date range:

```bash
# Last week
ccusage-pi daily --since 2025-01-02 --until 2025-01-09

# Single day
ccusage-pi daily --since 2025-01-09 --until 2025-01-09
```

## Monthly Report

The `monthly` command shows combined monthly usage from both Claude Code and pi-agent.

```bash
# Recommended (fastest)
bunx @ccusage/pi@latest monthly

# Using npx
npx @ccusage/pi@latest monthly
```

### Options

| Flag          | Short | Description                                   |
| ------------- | ----- | --------------------------------------------- |
| `--since`     |       | Start date filter (YYYY-MM-DD or YYYYMMDD)    |
| `--until`     |       | End date filter (YYYY-MM-DD or YYYYMMDD)      |
| `--timezone`  | `-z`  | Override timezone for date grouping           |
| `--json`      |       | Emit structured JSON instead of a table       |
| `--breakdown` | `-b`  | Show per-model token breakdown                |
| `--pi-path`   |       | Custom path to pi-agent sessions directory    |
| `--order`     |       | Sort order: `asc` or `desc` (default: `desc`) |

### Example Output

The output groups usage by month with source labels:

- `[cc]` - Claude Code entries (green)
- `[pi]` - Pi-agent entries (cyan)

```
┌────────────────────┬────────────┬─────────────┬───────────┬───────────┬─────────┬─────────┐
│ Month              │ Input      │ Output      │ Cache Cr. │ Cache Rd. │ Cost    │ Models  │
├────────────────────┼────────────┼─────────────┼───────────┼───────────┼─────────┼─────────┤
│ 2025-01 [cc]       │ 45,678,901 │ 8,901,234   │ 456,789   │ 3,456,789 │ $45.67  │ opus-4  │
│         [pi]       │ 12,345,678 │ 2,345,678   │ 123,456   │ 987,654   │ $12.34  │ opus-4  │
├────────────────────┼────────────┼─────────────┼───────────┼───────────┼─────────┼─────────┤
│ 2024-12 [cc]       │ 34,567,890 │ 6,789,012   │ 345,678   │ 2,678,901 │ $34.56  │ sonnet-4│
├────────────────────┼────────────┼─────────────┼───────────┼───────────┼─────────┼─────────┤
│ Total              │ 92,592,469 │ 18,035,924  │ 925,923   │ 7,123,344 │ $92.57  │         │
└────────────────────┴────────────┴─────────────┴───────────┴───────────┴─────────┴─────────┘
```

### JSON Output

Use `--json` for automation and scripting:

```bash
ccusage-pi monthly --json
```

Returns structured data:

<!-- eslint-skip -->

```json
{
  "monthly": [
    {
      "month": "2025-01",
      "source": "claude-code",
      "inputTokens": 45678901,
      "outputTokens": 8901234,
      "cacheCreationTokens": 456789,
      "cacheReadTokens": 3456789,
      "totalCost": 45.67,
      "modelsUsed": ["claude-opus-4-5-20251101"],
      "modelBreakdowns": [...]
    },
    {
      "month": "2025-01",
      "source": "pi-agent",
      ...
    }
  ],
  "totals": {
    "inputTokens": 92592469,
    "outputTokens": 18035924,
    "cacheCreationTokens": 925923,
    "cacheReadTokens": 7123344,
    "totalCost": 92.57
  }
}
```

### Filtering by Date Range

You can filter the data to specific months:

```bash
# Current year only
ccusage-pi monthly --since 2025-01-01

# Specific quarter
ccusage-pi monthly --since 2024-10-01 --until 2024-12-31
```

## Session Report

The `session` command shows combined usage grouped by individual sessions from both Claude Code and pi-agent.

```bash
# Recommended (fastest)
bunx @ccusage/pi@latest session

# Using npx
npx @ccusage/pi@latest session
```

### Options

| Flag          | Short | Description                                   |
| ------------- | ----- | --------------------------------------------- |
| `--since`     |       | Start date filter (YYYY-MM-DD or YYYYMMDD)    |
| `--until`     |       | End date filter (YYYY-MM-DD or YYYYMMDD)      |
| `--timezone`  | `-z`  | Override timezone for date grouping           |
| `--json`      |       | Emit structured JSON instead of a table       |
| `--breakdown` | `-b`  | Show per-model token breakdown                |
| `--pi-path`   |       | Custom path to pi-agent sessions directory    |
| `--order`     |       | Sort order: `asc` or `desc` (default: `desc`) |

### Example Output

Sessions are sorted by last activity and labeled by source:

- `[cc]` - Claude Code sessions (green)
- `[pi]` - Pi-agent sessions (cyan)

```
┌──────────────────────────────┬────────────┬───────────┬───────────┬───────────┬────────┬─────────┐
│ Session                      │ Input      │ Output    │ Cache Cr. │ Cache Rd. │ Cost   │ Models  │
├──────────────────────────────┼────────────┼───────────┼───────────┼───────────┼────────┼─────────┤
│ ccusage [cc]                 │ 234,567    │ 45,678    │ 2,345     │ 19,876    │ $0.23  │ opus-4  │
│ my-project [pi]              │ 123,456    │ 23,456    │ 1,234     │ 9,876     │ $0.12  │ opus-4  │
│ another-repo [cc]            │ 345,678    │ 67,890    │ 3,456     │ 29,876    │ $0.34  │ sonnet-4│
├──────────────────────────────┼────────────┼───────────┼───────────┼───────────┼────────┼─────────┤
│ Total                        │ 703,701    │ 137,024   │ 7,035     │ 59,628    │ $0.69  │         │
└──────────────────────────────┴────────────┴───────────┴───────────┴───────────┴────────┴─────────┘
```

### Session Identification

Sessions are identified differently for each source:

| Source      | Session Name                                               |
| ----------- | ---------------------------------------------------------- |
| Claude Code | Project directory name                                     |
| Pi-agent    | Project folder name from `~/.pi/agent/sessions/{project}/` |

Long project names are truncated to 25 characters with `...` suffix for readability.

### JSON Output

Use `--json` for detailed session data:

```bash
ccusage-pi session --json
```

Returns structured data including full paths:

<!-- eslint-skip -->

```json
{
  "sessions": [
    {
      "sessionId": "abc123-def456",
      "projectPath": "/Users/you/projects/ccusage",
      "source": "claude-code",
      "inputTokens": 234567,
      "outputTokens": 45678,
      "cacheCreationTokens": 2345,
      "cacheReadTokens": 19876,
      "totalCost": 0.23,
      "lastActivity": "2025-01-09",
      "modelsUsed": ["claude-opus-4-5-20251101"],
      "modelBreakdowns": [...]
    },
    {
      "sessionId": "xyz789",
      "projectPath": "my-project",
      "source": "pi-agent",
      ...
    }
  ],
  "totals": {
    "inputTokens": 703701,
    "outputTokens": 137024,
    "cacheCreationTokens": 7035,
    "cacheReadTokens": 59628,
    "totalCost": 0.69
  }
}
```

### Filtering Sessions

Filter sessions by their last activity date:

```bash
# Sessions active today
ccusage-pi session --since 2025-01-09 --until 2025-01-09

# Sessions from the past week
ccusage-pi session --since 2025-01-02
```

## Related

- [ccusage](https://github.com/ryoppippi/ccusage) - Main usage analysis tool for Claude Code
- [pi-agent](https://github.com/badlogic/pi-mono) - Alternative Claude coding agent
