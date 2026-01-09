# Pi-Agent Session Report

The `session` command shows combined usage grouped by individual sessions from both Claude Code and pi-agent.

```bash
# Recommended (fastest)
bunx @ccusage/pi@latest session

# Using npx
npx @ccusage/pi@latest session
```

## Options

| Flag          | Short | Description                                   |
| ------------- | ----- | --------------------------------------------- |
| `--since`     |       | Start date filter (YYYY-MM-DD or YYYYMMDD)    |
| `--until`     |       | End date filter (YYYY-MM-DD or YYYYMMDD)      |
| `--timezone`  | `-z`  | Override timezone for date grouping           |
| `--json`      |       | Emit structured JSON instead of a table       |
| `--breakdown` | `-b`  | Show per-model token breakdown                |
| `--pi-path`   |       | Custom path to pi-agent sessions directory    |
| `--order`     |       | Sort order: `asc` or `desc` (default: `desc`) |

## Example Output

Sessions are sorted by last activity and labelled by source:

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

## Session Identification

Sessions are identified differently for each source:

| Source      | Session Name                                               |
| ----------- | ---------------------------------------------------------- |
| Claude Code | Project directory name                                     |
| Pi-agent    | Project folder name from `~/.pi/agent/sessions/{project}/` |

Long project names are truncated to 25 characters with `...` suffix for readability.

## JSON Output

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

## Filtering Sessions

Filter sessions by their last activity date:

```bash
# Sessions active today
ccusage-pi session --since 2025-01-09 --until 2025-01-09

# Sessions from the past week
ccusage-pi session --since 2025-01-02
```

## Related

- [Daily report](./daily.md) - Aggregate by day
- [Monthly report](./monthly.md) - Aggregate by month
