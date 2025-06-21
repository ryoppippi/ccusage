# Monthly Reports

Monthly reports aggregate your Claude Code usage by calendar month, providing a high-level view of your usage patterns and costs over longer time periods.

## Basic Usage

```bash
ccusage monthly
```

## Example Output

```
╭─────────────────────────────────────────────╮
│                                             │
│  Claude Code Token Usage Report - Monthly  │
│                                             │
╰─────────────────────────────────────────────╯

┌─────────┬──────────────────┬─────────┬──────────┬──────────────┬────────────┬──────────────┬────────────┐
│ Month   │ Models           │ Input   │ Output   │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │
├─────────┼──────────────────┼─────────┼──────────┼──────────────┼────────────┼──────────────┼────────────┤
│ 2025-06 │ • opus-4         │  45,231 │  892,456 │        2,048 │      4,096 │      943,831 │   $1,247.92│
│         │ • sonnet-4       │         │          │              │            │              │            │
│ 2025-05 │ • sonnet-4       │  38,917 │  756,234 │        1,536 │      3,072 │      799,759 │     $892.15│
│ 2025-04 │ • opus-4         │  22,458 │  534,789 │        1,024 │      2,048 │      560,319 │     $678.43│
├─────────┼──────────────────┼─────────┼──────────┼──────────────┼────────────┼──────────────┼────────────┤
│ Total   │                  │ 106,606 │2,183,479 │        4,608 │      9,216 │    2,303,909 │   $2,818.50│
└─────────┴──────────────────┴─────────┴──────────┴──────────────┴────────────┴──────────────┴────────────┘
```

## Understanding Monthly Data

### Month Format

Months are displayed in YYYY-MM format:

- `2025-06` = June 2025
- `2025-05` = May 2025

### Aggregation Logic

All usage within a calendar month is aggregated:

- Input/output tokens summed across all days
- Costs calculated from total token usage
- Models listed if used at any point in the month

## Command Options

### Date Filtering

Filter by month range:

```bash
# Show specific months
ccusage monthly --since 20250101 --until 20250630

# Show usage from 2024
ccusage monthly --since 20240101 --until 20241231

# Show last 6 months
ccusage monthly --since $(date -d '6 months ago' +%Y%m%d)
```

::: tip Date Filtering
Even though you specify full dates (YYYYMMDD), monthly reports group by month. The filters determine which months to include.
:::

### Sort Order

```bash
# Newest months first (default)
ccusage monthly --order desc

# Oldest months first
ccusage monthly --order asc
```

### Cost Calculation Modes

```bash
# Use pre-calculated costs when available (default)
ccusage monthly --mode auto

# Always calculate costs from tokens
ccusage monthly --mode calculate

# Only show pre-calculated costs
ccusage monthly --mode display
```

### Model Breakdown

See costs broken down by model:

```bash
ccusage monthly --breakdown
```

Example with breakdown:

```
┌─────────┬──────────────────┬─────────┬──────────┬────────────┐
│ Month   │ Models           │ Input   │ Output   │ Cost (USD) │
├─────────┼──────────────────┼─────────┼──────────┼────────────┤
│ 2025-06 │ opus-4, sonnet-4 │  45,231 │  892,456 │  $1,247.92 │
├─────────┼──────────────────┼─────────┼──────────┼────────────┤
│  └─ opus-4                 │  20,000 │  400,000 │    $750.50 │
├─────────┼──────────────────┼─────────┼──────────┼────────────┤
│  └─ sonnet-4               │  25,231 │  492,456 │    $497.42 │
└─────────┴──────────────────┴─────────┴──────────┴────────────┘
```

### JSON Output

```bash
ccusage monthly --json
```

```json
[
	{
		"month": "2025-06",
		"models": ["opus-4", "sonnet-4"],
		"inputTokens": 45231,
		"outputTokens": 892456,
		"cacheCreationTokens": 2048,
		"cacheReadTokens": 4096,
		"totalTokens": 943831,
		"totalCost": 1247.92
	}
]
```

### Offline Mode

```bash
ccusage monthly --offline
```

## Analysis Use Cases

### Budget Planning

Monthly reports help with subscription planning:

```bash
# Check last year's usage
ccusage monthly --since 20240101 --until 20241231
```

Look at the total cost to understand what you'd pay on usage-based pricing.

### Usage Trends

Track how your usage changes over time:

```bash
# Compare year over year
ccusage monthly --since 20230101 --until 20231231  # 2023
ccusage monthly --since 20240101 --until 20241231  # 2024
```

### Model Migration Analysis

See how your model usage evolves:

```bash
ccusage monthly --breakdown
```

This helps track transitions between Opus, Sonnet, and other models.

### Seasonal Patterns

Identify busy/slow periods:

```bash
# Academic year analysis
ccusage monthly --since 20240901 --until 20250630
```

### Export for Business Analysis

```bash
# Create quarterly reports
ccusage monthly --since 20241001 --until 20241231 --json > q4-2024.json
```

## Tips for Monthly Analysis

### 1. Cost Context

Monthly totals show:

- **Subscription Value**: How much you'd pay with usage-based billing
- **Usage Intensity**: Months with heavy Claude usage
- **Model Preferences**: Which models you favor over time

### 2. Trend Analysis

Look for patterns:

- Increasing usage over time
- Seasonal variations
- Model adoption curves

### 3. Business Planning

Use monthly data for:

- Team budget planning
- Usage forecasting
- Subscription optimization

### 4. Comparative Analysis

Compare monthly reports with:

- Team productivity metrics
- Project timelines
- Business outcomes

## Related Commands

- [Daily Reports](/guide/daily-reports) - Day-by-day breakdown
- [Session Reports](/guide/session-reports) - Individual conversations
- [Blocks Reports](/guide/blocks-reports) - 5-hour billing periods

## Next Steps

After analyzing monthly trends, consider:

1. [Session Reports](/guide/session-reports) to identify high-cost conversations
2. [Live Monitoring](/guide/live-monitoring) to track real-time usage
3. [Custom Scripts](/examples/custom-scripts) for automated analysis
