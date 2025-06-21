# JSON Output

ccusage supports structured JSON output for all report types, making it easy to integrate with other tools, scripts, or applications that need to process usage data programmatically.

## Enabling JSON Output

Add the `--json` (or `-j`) flag to any command:

```bash
# Daily report in JSON format
ccusage daily --json

# Monthly report in JSON format
ccusage monthly --json

# Session report in JSON format
ccusage session --json

# 5-hour blocks report in JSON format
ccusage blocks --json
```

## JSON Structure

### Daily Reports

```json
{
	"type": "daily",
	"data": [
		{
			"date": "2025-05-30",
			"models": ["claude-opus-4-20250514", "claude-sonnet-4-20250514"],
			"inputTokens": 277,
			"outputTokens": 31456,
			"cacheCreationTokens": 512,
			"cacheReadTokens": 1024,
			"totalTokens": 33269,
			"costUSD": 17.58
		}
	],
	"summary": {
		"totalInputTokens": 11174,
		"totalOutputTokens": 720366,
		"totalCacheCreationTokens": 896,
		"totalCacheReadTokens": 2304,
		"totalTokens": 734740,
		"totalCostUSD": 336.47
	}
}
```

### Monthly Reports

```json
{
	"type": "monthly",
	"data": [
		{
			"month": "2025-05",
			"models": ["claude-opus-4-20250514", "claude-sonnet-4-20250514"],
			"inputTokens": 11174,
			"outputTokens": 720366,
			"cacheCreationTokens": 896,
			"cacheReadTokens": 2304,
			"totalTokens": 734740,
			"costUSD": 336.47
		}
	],
	"summary": {
		"totalInputTokens": 11174,
		"totalOutputTokens": 720366,
		"totalCacheCreationTokens": 896,
		"totalCacheReadTokens": 2304,
		"totalTokens": 734740,
		"totalCostUSD": 336.47
	}
}
```

### Session Reports

```json
{
	"type": "session",
	"data": [
		{
			"session": "session-1",
			"models": ["claude-opus-4-20250514", "claude-sonnet-4-20250514"],
			"inputTokens": 4512,
			"outputTokens": 350846,
			"cacheCreationTokens": 512,
			"cacheReadTokens": 1024,
			"totalTokens": 356894,
			"costUSD": 156.40,
			"lastActivity": "2025-05-24"
		}
	],
	"summary": {
		"totalInputTokens": 11174,
		"totalOutputTokens": 720445,
		"totalCacheCreationTokens": 768,
		"totalCacheReadTokens": 1792,
		"totalTokens": 734179,
		"totalCostUSD": 336.68
	}
}
```

### Blocks Reports

```json
{
	"type": "blocks",
	"data": [
		{
			"blockStart": "2025-05-30T10:00:00.000Z",
			"blockEnd": "2025-05-30T15:00:00.000Z",
			"isActive": true,
			"timeRemaining": "2h 15m",
			"models": ["claude-sonnet-4-20250514"],
			"inputTokens": 1250,
			"outputTokens": 15000,
			"cacheCreationTokens": 256,
			"cacheReadTokens": 512,
			"totalTokens": 17018,
			"costUSD": 8.75,
			"burnRate": 2400,
			"projectedTotal": 25000,
			"projectedCost": 12.50
		}
	],
	"summary": {
		"totalInputTokens": 11174,
		"totalOutputTokens": 720366,
		"totalCacheCreationTokens": 896,
		"totalCacheReadTokens": 2304,
		"totalTokens": 734740,
		"totalCostUSD": 336.47
	}
}
```

## Field Descriptions

### Common Fields

- `models`: Array of Claude model names used
- `inputTokens`: Number of input tokens consumed
- `outputTokens`: Number of output tokens generated
- `cacheCreationTokens`: Tokens used for cache creation
- `cacheReadTokens`: Tokens read from cache
- `totalTokens`: Sum of all token types
- `costUSD`: Estimated cost in US dollars

### Report-Specific Fields

#### Daily Reports

- `date`: Date in YYYY-MM-DD format

#### Monthly Reports

- `month`: Month in YYYY-MM format

#### Session Reports

- `session`: Session identifier
- `lastActivity`: Date of last activity in the session

#### Blocks Reports

- `blockStart`: ISO timestamp of block start
- `blockEnd`: ISO timestamp of block end
- `isActive`: Whether the block is currently active
- `timeRemaining`: Human-readable time remaining (active blocks only)
- `burnRate`: Tokens per hour rate (active blocks only)
- `projectedTotal`: Projected total tokens for the block
- `projectedCost`: Projected total cost for the block

## Filtering with JSON Output

All filtering options work with JSON output:

```bash
# Filter by date range
ccusage daily --json --since 20250525 --until 20250530

# Different cost calculation modes
ccusage monthly --json --mode calculate
ccusage session --json --mode display

# Sort order
ccusage daily --json --order asc

# With model breakdown
ccusage daily --json --breakdown
```

### Model Breakdown JSON

When using `--breakdown`, the JSON includes per-model details:

```json
{
	"type": "daily",
	"data": [
		{
			"date": "2025-05-30",
			"models": ["claude-opus-4-20250514", "claude-sonnet-4-20250514"],
			"inputTokens": 277,
			"outputTokens": 31456,
			"totalTokens": 33269,
			"costUSD": 17.58,
			"breakdown": {
				"claude-opus-4-20250514": {
					"inputTokens": 100,
					"outputTokens": 15000,
					"cacheCreationTokens": 256,
					"cacheReadTokens": 512,
					"totalTokens": 15868,
					"costUSD": 10.25
				},
				"claude-sonnet-4-20250514": {
					"inputTokens": 177,
					"outputTokens": 16456,
					"cacheCreationTokens": 256,
					"cacheReadTokens": 512,
					"totalTokens": 17401,
					"costUSD": 7.33
				}
			}
		}
	]
}
```

## Integration Examples

### Using with jq

Process JSON output with jq for advanced filtering and formatting:

```bash
# Get total cost for the last 7 days
ccusage daily --json --since $(date -d '7 days ago' +%Y%m%d) | jq '.summary.totalCostUSD'

# List all unique models used
ccusage session --json | jq -r '.data[].models[]' | sort -u

# Find the most expensive session
ccusage session --json | jq -r '.data | sort_by(.costUSD) | reverse | .[0].session'

# Get daily costs as CSV
ccusage daily --json | jq -r '.data[] | [.date, .costUSD] | @csv'
```

### Using with Python

```python
import json
import subprocess

# Get daily usage data
result = subprocess.run(['ccusage', 'daily', '--json'], capture_output=True, text=True)
data = json.loads(result.stdout)

# Process the data
for day in data['data']:
    print(f"Date: {day['date']}, Cost: ${day['costUSD']:.2f}")

total_cost = data['summary']['totalCostUSD']
print(f"Total cost: ${total_cost:.2f}")
```

### Using with Node.js

```javascript
import { execSync } from 'node:child_process';

// Get session usage data
const output = execSync('ccusage session --json', { encoding: 'utf-8' });
const data = JSON.parse(output);

// Find sessions over $10
const expensiveSessions = data.data.filter(session => session.costUSD > 10);
console.log(`Found ${expensiveSessions.length} expensive sessions`);

expensiveSessions.forEach((session) => {
	console.log(`${session.session}: $${session.costUSD.toFixed(2)}`);
});
```

## Programmatic Usage

JSON output is designed for programmatic consumption:

- **Consistent structure**: All fields are always present (with 0 or empty values when not applicable)
- **Standard types**: Numbers for metrics, strings for identifiers, arrays for lists
- **ISO timestamps**: Standardized date/time formats for reliable parsing
- **Stable schema**: Field names and structures remain consistent across versions
