# Pi-Agent Daily Report

The `daily` command shows combined daily usage from both Claude Code and pi-agent.

```bash
# Recommended (fastest)
bunx @ccusage/pi@latest daily

# Using npx
npx @ccusage/pi@latest daily
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

## JSON Output

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

## Date Filtering

Filter to a specific date range:

```bash
# Last week
ccusage-pi daily --since 2025-01-02 --until 2025-01-09

# Single day
ccusage-pi daily --since 2025-01-09 --until 2025-01-09
```

## Related

- [Monthly report](./monthly.md) - Aggregate by month
- [Session report](./session.md) - View by individual session
