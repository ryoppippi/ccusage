# Pi-Agent Monthly Report

The `monthly` command shows combined monthly usage from both Claude Code and pi-agent.

```bash
# Recommended (fastest)
bunx @ccusage/pi@latest monthly

# Using npx
npx @ccusage/pi@latest monthly
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

## JSON Output

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

## Filtering by Date Range

You can filter the data to specific months:

```bash
# Current year only
ccusage-pi monthly --since 2025-01-01

# Specific quarter
ccusage-pi monthly --since 2024-10-01 --until 2024-12-31
```

## Related

- [Daily report](./daily.md) - Granular day-by-day breakdown
- [Session report](./session.md) - View by individual session
