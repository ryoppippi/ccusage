# Session Reports

Session reports show your Claude Code usage grouped by individual conversation sessions, making it easy to identify which conversations consumed the most tokens and cost the most.

## Basic Usage

```bash
ccusage session
```

## Specific Session Lookup

Query individual session details by providing a session ID:

```bash
ccusage session --id <session-id>
```

This is particularly useful for:
- **Custom statuslines**: Integrate specific session data into your development environment
- **Programmatic usage**: Extract session metrics for scripts and automation
- **Detailed analysis**: Get comprehensive data about a single conversation

### Examples

```bash
# Get session data in table format
ccusage session --id session-abc123-def456

# Get session data as JSON for scripting
ccusage session --id session-abc123-def456 --json

# Extract just the cost using jq
ccusage session --id session-abc123-def456 --json --jq '.totalCost'

# Use in a custom statusline script
COST=$(ccusage session --id "$SESSION_ID" --json --jq '.totalCost')
echo "Current session: \$${COST}"
```

### Session ID Format

Session IDs are the actual filenames (without `.jsonl` extension) stored in Claude's data directories. They typically look like:
- `session-20250621-abc123-def456`
- `project-conversation-xyz789`

You can find session IDs by running `ccusage session` and looking for the files in your Claude data directory.

## Example Output

```
╭───────────────────────────────────────────────╮
│                                               │
│  Claude Code Token Usage Report - By Session  │
│                                               │
╰───────────────────────────────────────────────╯

┌────────────┬──────────────────┬────────┬─────────┬──────────────┬────────────┬──────────────┬────────────┬───────────────┐
│ Session    │ Models           │ Input  │ Output  │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │ Last Activity │
├────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┼───────────────┤
│ abc123-def │ • opus-4         │  4,512 │ 350,846 │          512 │      1,024 │      356,894 │    $156.40 │ 2025-06-21    │
│            │ • sonnet-4       │        │         │              │            │              │            │               │
│ ghi456-jkl │ • sonnet-4       │  2,775 │ 186,645 │          256 │        768 │      190,444 │     $98.45 │ 2025-06-20    │
│ mno789-pqr │ • opus-4         │  1,887 │ 183,055 │          128 │        512 │      185,582 │     $81.73 │ 2025-06-19    │
├────────────┼──────────────────┼────────┼─────────┼──────────────┼────────────┼──────────────┼────────────┼───────────────┤
│ Total      │                  │  9,174 │ 720,546 │          896 │      2,304 │      732,920 │    $336.58 │               │
└────────────┴──────────────────┴────────┴─────────┴──────────────┴────────────┴──────────────┴────────────┴───────────────┘
```

## Understanding Session Data

### Session Identification

Sessions are displayed using the last two segments of their full identifier:

- Full session ID: `project-20250621-session-abc123-def456`
- Displayed as: `abc123-def`

### Session Metrics

- **Input/Output Tokens**: Total tokens exchanged in the conversation
- **Cache Tokens**: Cache creation and read tokens for context efficiency
- **Cost**: Estimated USD cost for the entire conversation
- **Last Activity**: Date of the most recent message in the session

### Sorting

Sessions are sorted by cost (highest first) by default, making it easy to identify your most expensive conversations.

## Command Options

### Session ID Lookup

Get detailed information about a specific session:

```bash
# Query a specific session by ID
ccusage session --id <session-id>

# Get JSON output for a specific session
ccusage session --id <session-id> --json

# Short form using -i flag
ccusage session -i <session-id>
```

**Use cases:**
- Building custom statuslines that show current session costs
- Creating scripts that monitor specific conversation expenses
- Debugging or analyzing individual conversation patterns
- Integrating session data into development workflows

### Date Filtering

Filter sessions by their last activity date:

```bash
# Show sessions active since May 25th
ccusage session --since 20250525

# Show sessions active in a specific date range
ccusage session --since 20250520 --until 20250530

# Show only recent sessions (last week)
ccusage session --since $(date -d '7 days ago' +%Y%m%d)
```

### Cost Calculation Modes

```bash
# Use pre-calculated costs when available (default)
ccusage session --mode auto

# Always calculate costs from tokens
ccusage session --mode calculate

# Only show pre-calculated costs
ccusage session --mode display
```

### Model Breakdown

See per-model cost breakdown within each session:

```bash
ccusage session --breakdown
```

Example with breakdown:

```
┌────────────┬──────────────────┬────────┬─────────┬────────────┬───────────────┐
│ Session    │ Models           │ Input  │ Output  │ Cost (USD) │ Last Activity │
├────────────┼──────────────────┼────────┼─────────┼────────────┼───────────────┤
│ abc123-def │ opus-4, sonnet-4 │  4,512 │ 350,846 │    $156.40 │ 2025-06-21    │
├────────────┼──────────────────┼────────┼─────────┼────────────┼───────────────┤
│   └─ opus-4│                  │  2,000 │ 200,000 │     $95.50 │               │
├────────────┼──────────────────┼────────┼─────────┼────────────┼───────────────┤
│   └─ sonnet-4                 │  2,512 │ 150,846 │     $60.90 │               │
└────────────┴──────────────────┴────────┴─────────┴────────────┴───────────────┘
```

### JSON Output

Export session data as JSON for further analysis:

```bash
ccusage session --json
```

```json
{
	"sessions": [
		{
			"sessionId": "abc123-def",
			"inputTokens": 4512,
			"outputTokens": 350846,
			"cacheCreationTokens": 512,
			"cacheReadTokens": 1024,
			"totalTokens": 356894,
			"totalCost": 156.40,
			"lastActivity": "2025-06-21",
			"modelsUsed": ["opus-4", "sonnet-4"],
			"modelBreakdowns": [
				{
					"model": "opus-4",
					"inputTokens": 2000,
					"outputTokens": 200000,
					"totalCost": 95.50
				}
			]
		}
	],
	"totals": {
		"inputTokens": 9174,
		"outputTokens": 720546,
		"totalCost": 336.58
	}
}
```

### Offline Mode

Use cached pricing data without network access:

```bash
ccusage session --offline
# or short form:
ccusage session -O
```

## Analysis Use Cases

### Identify Expensive Conversations

Session reports help you understand which conversations are most costly:

```bash
ccusage session
```

Look at the top sessions to understand:

- Which types of conversations cost the most
- Whether long coding sessions or research tasks are more expensive
- How model choice (Opus vs Sonnet) affects costs

### Track Conversation Patterns

```bash
# See recent conversation activity
ccusage session --since 20250615

# Compare different time periods
ccusage session --since 20250601 --until 20250615  # First half of month
ccusage session --since 20250616 --until 20250630  # Second half of month
```

### Model Usage Analysis

```bash
# See which models you use in different conversations
ccusage session --breakdown
```

This helps understand:

- Whether you prefer Opus for complex tasks
- If Sonnet is sufficient for routine work
- How model mixing affects total costs

### Budget Optimization

```bash
# Export data for spreadsheet analysis
ccusage session --json > sessions.json

# Find sessions above a certain cost threshold
ccusage session --json | jq '.sessions[] | select(.totalCost > 50)'
```

## Tips for Session Analysis

### 1. Cost Context Understanding

Session costs help you understand:

- **Conversation Value**: High-cost sessions should provide proportional value
- **Efficiency Patterns**: Some conversation styles may be more token-efficient
- **Model Selection**: Whether your model choices align with task complexity

### 2. Usage Optimization

Use session data to:

- **Identify expensive patterns**: What makes some conversations cost more?
- **Optimize conversation flow**: Break long sessions into smaller focused chats
- **Choose appropriate models**: Use Sonnet for simpler tasks, Opus for complex ones

### 3. Budget Planning

Session analysis helps with:

- **Conversation budgeting**: Understanding typical session costs
- **Usage forecasting**: Predicting monthly costs based on session patterns
- **Value assessment**: Ensuring expensive sessions provide good value

### 4. Comparative Analysis

Compare sessions to understand:

- **Task types**: Coding vs writing vs research costs
- **Model effectiveness**: Whether Opus provides value over Sonnet
- **Time patterns**: Whether longer sessions are more or less efficient

## Responsive Display

Session reports adapt to your terminal width:

- **Wide terminals (≥100 chars)**: Shows all columns including cache metrics
- **Narrow terminals (<100 chars)**: Compact mode with essential columns (Session, Models, Input, Output, Cost, Last Activity)

When in compact mode, ccusage displays a message explaining how to see the full data.

## Related Commands

- [Daily Reports](/guide/daily-reports) - Usage aggregated by date
- [Monthly Reports](/guide/monthly-reports) - Monthly summaries
- [Blocks Reports](/guide/blocks-reports) - 5-hour billing windows
- [Live Monitoring](/guide/live-monitoring) - Real-time session tracking

## Next Steps

After analyzing session patterns, consider:

1. [Blocks Reports](/guide/blocks-reports) to understand timing within 5-hour windows
2. [Live Monitoring](/guide/live-monitoring) to track active conversations in real-time
3. [Daily Reports](/guide/daily-reports) to see how session patterns vary by day
