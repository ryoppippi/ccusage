# Pi-Agent Integration

The `@ccusage/pi` package provides usage tracking for [pi-agent](https://github.com/badlogic/pi-mono), an alternative Claude coding agent from [shittycodingagent.ai](https://shittycodingagent.ai).

## What is Pi-Agent?

Pi-agent is a third-party Claude coding agent that stores usage data in JSONL format. The `@ccusage/pi` package analyses this data to give you a view of your pi-agent usage.

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

## Data Source

The CLI reads usage data from pi-agent:

| Source   | Default Path            |
| -------- | ----------------------- |
| Pi-agent | `~/.pi/agent/sessions/` |

## Available Commands

```bash
# Show daily pi-agent usage
ccusage-pi daily

# Show monthly pi-agent usage
ccusage-pi monthly

# Show session-based pi-agent usage
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

| Variable       | Description                                   |
| -------------- | --------------------------------------------- |
| `PI_AGENT_DIR` | Custom path to pi-agent sessions directory    |
| `LOG_LEVEL`    | Adjust logging verbosity (0 silent … 5 trace) |

## Daily Report

The `daily` command shows daily usage from pi-agent.

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

```
┌────────────┬────────────┬─────────────┬───────────┬───────────┬────────┬─────────┐
│ Date       │ Input      │ Output      │ Cache Cr. │ Cache Rd. │ Cost   │ Models  │
├────────────┼────────────┼─────────────┼───────────┼───────────┼────────┼─────────┤
│ 2025-01-09 │ 567,890    │ 123,456     │ 5,678     │ 45,678    │ $0.89  │ opus-4  │
├────────────┼────────────┼─────────────┼───────────┼───────────┼────────┼─────────┤
│ Total      │ 567,890    │ 123,456     │ 5,678     │ 45,678    │ $0.89  │         │
└────────────┴────────────┴─────────────┴───────────┴───────────┴────────┴─────────┘
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
      "source": "pi-agent",
      "inputTokens": 567890,
      "outputTokens": 123456,
      "cacheCreationTokens": 5678,
      "cacheReadTokens": 45678,
      "totalCost": 0.89,
      "modelsUsed": ["claude-opus-4-5-20251101"],
      "modelBreakdowns": [...]
    }
  ],
  "totals": {
    "inputTokens": 567890,
    "outputTokens": 123456,
    "cacheCreationTokens": 5678,
    "cacheReadTokens": 45678,
    "totalCost": 0.89
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

The `monthly` command shows monthly usage from pi-agent.

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

```
┌─────────┬────────────┬─────────────┬───────────┬───────────┬─────────┬─────────┐
│ Month   │ Input      │ Output      │ Cache Cr. │ Cache Rd. │ Cost    │ Models  │
├─────────┼────────────┼─────────────┼───────────┼───────────┼─────────┼─────────┤
│ 2025-01 │ 12,345,678 │ 2,345,678   │ 123,456   │ 987,654   │ $12.34  │ opus-4  │
├─────────┼────────────┼─────────────┼───────────┼───────────┼─────────┼─────────┤
│ Total   │ 12,345,678 │ 2,345,678   │ 123,456   │ 987,654   │ $12.34  │         │
└─────────┴────────────┴─────────────┴───────────┴───────────┴─────────┴─────────┘
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
      "source": "pi-agent",
      "inputTokens": 12345678,
      "outputTokens": 2345678,
      "cacheCreationTokens": 123456,
      "cacheReadTokens": 987654,
      "totalCost": 12.34,
      "modelsUsed": ["claude-opus-4-5-20251101"],
      "modelBreakdowns": [...]
    }
  ],
  "totals": {
    "inputTokens": 12345678,
    "outputTokens": 2345678,
    "cacheCreationTokens": 123456,
    "cacheReadTokens": 987654,
    "totalCost": 12.34
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

The `session` command shows usage grouped by individual pi-agent sessions.

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

Sessions are sorted by last activity:

```
┌──────────────────────────────┬────────────┬───────────┬───────────┬───────────┬────────┬─────────┐
│ Session                      │ Input      │ Output    │ Cache Cr. │ Cache Rd. │ Cost   │ Models  │
├──────────────────────────────┼────────────┼───────────┼───────────┼───────────┼────────┼─────────┤
│ my-project                   │ 123,456    │ 23,456    │ 1,234     │ 9,876     │ $0.12  │ opus-4  │
│ another-repo                 │ 345,678    │ 67,890    │ 3,456     │ 29,876    │ $0.34  │ sonnet-4│
├──────────────────────────────┼────────────┼───────────┼───────────┼───────────┼────────┼─────────┤
│ Total                        │ 469,134    │ 91,346    │ 4,690     │ 39,752    │ $0.46  │         │
└──────────────────────────────┴────────────┴───────────┴───────────┴───────────┴────────┴─────────┘
```

### Session Identification

Sessions are identified by the project folder name from `~/.pi/agent/sessions/{project}/`.

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
      "projectPath": "my-project",
      "source": "pi-agent",
      "inputTokens": 123456,
      "outputTokens": 23456,
      "cacheCreationTokens": 1234,
      "cacheReadTokens": 9876,
      "totalCost": 0.12,
      "lastActivity": "2025-01-09",
      "modelsUsed": ["claude-opus-4-5-20251101"],
      "modelBreakdowns": [...]
    }
  ],
  "totals": {
    "inputTokens": 123456,
    "outputTokens": 23456,
    "cacheCreationTokens": 1234,
    "cacheReadTokens": 9876,
    "totalCost": 0.12
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
