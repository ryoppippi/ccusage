# Cost Modes

ccusage supports three different cost calculation modes to handle various scenarios and data sources. Understanding these modes helps you get the most accurate cost estimates for your usage analysis.

## Overview

Claude Code stores usage data in JSONL files with both token counts and pre-calculated cost information. ccusage can handle this data in different ways depending on your needs:

- **`auto`** - Smart mode using the best available data
- **`calculate`** - Always calculate from token counts
- **`display`** - Only show pre-calculated costs

## Mode Details

### auto (Default)

The `auto` mode intelligently chooses the best cost calculation method for each entry:

```bash
ccusage daily --mode auto
# or simply:
ccusage daily
```

#### How it works:

1. **Pre-calculated costs available** → Uses Claude's `costUSD` values
2. **No pre-calculated costs** → Calculates from token counts using model pricing
3. **Mixed data** → Uses the best method for each entry

#### Best for:

- ✅ **General usage** - Works well for most scenarios
- ✅ **Mixed data sets** - Handles old and new data properly
- ✅ **Accuracy** - Uses official costs when available
- ✅ **Completeness** - Shows estimates for all entries

#### Example output:

```
┌──────────────┬─────────────┬────────┬─────────┬────────────┐
│ Date         │ Models      │ Input  │ Output  │ Cost (USD) │
├──────────────┼─────────────┼────────┼─────────┼────────────┤
│ 2025-01-15   │ • opus-4    │  1,245 │  28,756 │    $12.45  │ ← Pre-calculated
│ 2024-12-20   │ • sonnet-4  │    856 │  19,234 │     $8.67  │ ← Calculated
│ 2024-11-10   │ • opus-4    │    634 │  15,678 │     $7.23  │ ← Calculated
└──────────────┴─────────────┴────────┴─────────┴────────────┘
```

### calculate

The `calculate` mode always computes costs from token counts using model pricing:

```bash
ccusage daily --mode calculate
ccusage monthly --mode calculate --breakdown
```

#### How it works:

1. **Ignores `costUSD` values** from Claude Code data
2. **Uses token counts** (input, output, cache) for all entries
3. **Applies current model pricing** from LiteLLM database
4. **Consistent methodology** across all time periods

#### Best for:

- ✅ **Consistent comparisons** - Same calculation method for all data
- ✅ **Token analysis** - Understanding pure token-based costs
- ✅ **Historical analysis** - Comparing costs across different time periods
- ✅ **Pricing research** - Analyzing cost per token trends

#### Example output:

```
┌──────────────┬─────────────┬────────┬─────────┬────────────┐
│ Date         │ Models      │ Input  │ Output  │ Cost (USD) │
├──────────────┼─────────────┼────────┼─────────┼────────────┤
│ 2025-01-15   │ • opus-4    │  1,245 │  28,756 │    $12.38  │ ← Calculated
│ 2024-12-20   │ • sonnet-4  │    856 │  19,234 │     $8.67  │ ← Calculated
│ 2024-11-10   │ • opus-4    │    634 │  15,678 │     $7.23  │ ← Calculated
└──────────────┴─────────────┴────────┴─────────┴────────────┘
```

### display

The `display` mode only shows pre-calculated costs from Claude Code:

```bash
ccusage daily --mode display
ccusage session --mode display --json
```

#### How it works:

1. **Uses only `costUSD` values** from Claude Code data
2. **Shows $0.00** for entries without pre-calculated costs
3. **No token-based calculations** performed
4. **Exact Claude billing data** when available

#### Best for:

- ✅ **Official costs only** - Shows exactly what Claude calculated
- ✅ **Billing verification** - Comparing with actual Claude charges
- ✅ **Recent data** - Most accurate for newer usage entries
- ✅ **Audit purposes** - Verifying pre-calculated costs

#### Example output:

```
┌──────────────┬─────────────┬────────┬─────────┬────────────┐
│ Date         │ Models      │ Input  │ Output  │ Cost (USD) │
├──────────────┼─────────────┼────────┼─────────┼────────────┤
│ 2025-01-15   │ • opus-4    │  1,245 │  28,756 │    $12.45  │ ← Pre-calculated
│ 2024-12-20   │ • sonnet-4  │    856 │  19,234 │     $0.00  │ ← No cost data
│ 2024-11-10   │ • opus-4    │    634 │  15,678 │     $0.00  │ ← No cost data
└──────────────┴─────────────┴────────┴─────────┴────────────┘
```

## Practical Examples

### Scenario 1: Mixed Data Analysis

You have data from different time periods with varying cost information:

```bash
# Auto mode handles mixed data intelligently
ccusage daily --mode auto --since 20241201

# Shows:
# - Pre-calculated costs for recent entries (Jan 2025)
# - Calculated costs for older entries (Dec 2024)
```

### Scenario 2: Consistent Cost Comparison

You want to compare costs across different months using the same methodology:

```bash
# Calculate mode ensures consistent methodology
ccusage monthly --mode calculate --breakdown

# All months use the same token-based calculation
# Useful for trend analysis and cost projections
```

### Scenario 3: Billing Verification

You want to verify Claude's official cost calculations:

```bash
# Display mode shows only official Claude costs
ccusage daily --mode display --since 20250101

# Compare with your Claude billing dashboard
# Entries without costs show $0.00
```

### Scenario 4: Historical Analysis

Analyzing usage patterns over time:

```bash
# Auto mode for complete picture
ccusage daily --mode auto --since 20240101 --until 20241231

# Calculate mode for consistent comparison
ccusage monthly --mode calculate --order asc
```

## Cost Calculation Details

### Token-Based Calculation

When calculating costs from tokens, ccusage uses:

#### Model Pricing Sources

- **LiteLLM database** - Up-to-date model pricing
- **Automatic updates** - Pricing refreshed regularly
- **Multiple models** - Supports Claude Opus, Sonnet, and other models

#### Token Types

```typescript
type TokenCosts = {
	input: number; // Input tokens
	output: number; // Output tokens
	cacheCreate: number; // Cache creation tokens
	cacheRead: number; // Cache read tokens
};
```

#### Calculation Formula

```typescript
totalCost
	= (inputTokens * inputPrice)
		+ (outputTokens * outputPrice)
		+ (cacheCreateTokens * cacheCreatePrice)
		+ (cacheReadTokens * cacheReadPrice);
```

### Pre-calculated Costs

Claude Code provides `costUSD` values in JSONL files:

```json
{
	"timestamp": "2025-01-15T10:30:00Z",
	"model": "claude-opus-4-20250514",
	"usage": {
		"input_tokens": 1245,
		"output_tokens": 28756,
		"cache_creation_input_tokens": 512,
		"cache_read_input_tokens": 256
	},
	"costUSD": 12.45
}
```

## Debug Mode

Use debug mode to understand cost calculation discrepancies:

```bash
ccusage daily --mode auto --debug
```

Shows:

- **Pricing mismatches** between calculated and pre-calculated costs
- **Missing cost data** entries
- **Calculation details** for each entry
- **Sample discrepancies** for investigation

```bash
# Show more sample discrepancies
ccusage daily --debug --debug-samples 10
```

## Mode Selection Guide

### When to use `auto` mode:

- **General usage** - Default for most scenarios
- **Mixed data sets** - Combining old and new usage data
- **Maximum accuracy** - Best available cost information
- **Regular reporting** - Daily/monthly usage tracking

### When to use `calculate` mode:

- **Consistent analysis** - Comparing different time periods
- **Token cost research** - Understanding pure token costs
- **Pricing validation** - Verifying calculated vs actual costs
- **Historical comparison** - Analyzing cost trends over time

### When to use `display` mode:

- **Billing verification** - Comparing with Claude charges
- **Official costs only** - Trusting Claude's calculations
- **Recent data analysis** - Most accurate for new usage
- **Audit purposes** - Verifying pre-calculated costs

## Advanced Usage

### Combining with Other Options

```bash
# Calculate mode with breakdown by model
ccusage daily --mode calculate --breakdown

# Display mode with JSON output for analysis
ccusage session --mode display --json | jq '.[] | select(.totalCost > 0)'

# Auto mode with date filtering
ccusage monthly --mode auto --since 20240101 --order asc
```

### Performance Considerations

- **`display` mode** - Fastest (no calculations)
- **`auto` mode** - Moderate (conditional calculations)
- **`calculate` mode** - Slowest (always calculates)

### Offline Mode Compatibility

```bash
# All modes work with offline pricing data
ccusage daily --mode calculate --offline
ccusage monthly --mode auto --offline
```

## Common Issues and Solutions

### Issue: Costs showing as $0.00

**Cause**: Using `display` mode with data that lacks pre-calculated costs

**Solution**:

```bash
# Switch to auto or calculate mode
ccusage daily --mode auto
ccusage daily --mode calculate
```

### Issue: Inconsistent cost calculations

**Cause**: Mixed use of different modes or pricing changes

**Solution**:

```bash
# Use calculate mode for consistency
ccusage daily --mode calculate --since 20240101
```

### Issue: Large discrepancies in debug mode

**Cause**: Pricing updates or model changes

**Solution**:

```bash
# Check for pricing updates
ccusage daily --mode auto  # Updates pricing cache
ccusage daily --mode calculate --debug  # Compare calculations
```

### Issue: Missing cost data for recent entries

**Cause**: Claude Code hasn't calculated costs yet

**Solution**:

```bash
# Use calculate mode as fallback
ccusage daily --mode calculate
```

## Next Steps

After understanding cost modes:

- Explore [Configuration](/guide/configuration) for environment setup
- Learn about [Custom Paths](/guide/custom-paths) for multiple data sources
- Try [Live Monitoring](/guide/live-monitoring) with different cost modes
