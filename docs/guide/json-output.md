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

### Daily Reports (Standard)

Standard daily reports aggregate usage across all projects:

```json
{
	"daily": [
		{
			"date": "2025-05-30",
			"inputTokens": 277,
			"outputTokens": 31456,
			"cacheCreationTokens": 512,
			"cacheReadTokens": 1024,
			"totalTokens": 33269,
			"totalCost": 17.58,
			"modelsUsed": ["claude-opus-4-20250514", "claude-sonnet-4-20250514"],
			"modelBreakdowns": [...]
		}
	],
	"totals": {
		"inputTokens": 11174,
		"outputTokens": 720366,
		"cacheCreationTokens": 896,
		"cacheReadTokens": 2304,
		"totalTokens": 734740,
		"totalCost": 336.47
	}
}
```

### Daily Reports (Project-Grouped)

When using `--instances`, daily reports group usage by project:

```json
{
	"projects": {
		"my-frontend-app": [
			{
				"date": "2025-05-30",
				"inputTokens": 177,
				"outputTokens": 16456,
				"cacheCreationTokens": 256,
				"cacheReadTokens": 512,
				"totalTokens": 17401,
				"totalCost": 7.33,
				"modelsUsed": ["claude-sonnet-4-20250514"],
				"modelBreakdowns": [...]
			}
		],
		"backend-api": [
			{
				"date": "2025-05-30",
				"inputTokens": 100,
				"outputTokens": 15000,
				"cacheCreationTokens": 256,
				"cacheReadTokens": 512,
				"totalTokens": 15868,
				"totalCost": 10.25,
				"modelsUsed": ["claude-opus-4-20250514"],
				"modelBreakdowns": [...]
			}
		]
	},
	"totals": {
		"inputTokens": 277,
		"outputTokens": 31456,
		"cacheCreationTokens": 512,
		"cacheReadTokens": 1024,
		"totalTokens": 33269,
		"totalCost": 17.58
	}
}
```

#### Usage

```bash
# Standard aggregated output
ccusage daily --json

# Project-grouped output  
ccusage daily --instances --json

# Filter to specific project
ccusage daily --project my-frontend-app --json
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

# Project analysis
ccusage daily --json --instances                    # Group by project
ccusage daily --json --project my-project           # Filter to project
ccusage daily --json --instances --project my-app   # Combined usage
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

## Using the --jq Option

ccusage includes built-in jq processing with the `--jq` option. This allows you to process JSON output directly without using pipes:

```bash
# Get total cost directly
ccusage daily --jq '.totals.totalCost'

# Find the most expensive session
ccusage session --jq '.sessions | sort_by(.totalCost) | reverse | .[0]'

# Get daily costs as CSV
ccusage daily --jq '.daily[] | [.date, .totalCost] | @csv'

# List all unique models used
ccusage session --jq '[.sessions[].modelsUsed[]] | unique | sort[]'

# Get usage by specific date
ccusage daily --jq '.daily[] | select(.date == "2025-05-30")'

# Calculate average daily cost
ccusage daily --jq '[.daily[].totalCost] | add / length'
```

### Important Notes

- The `--jq` option implies `--json` (you don't need to specify both)
- Requires jq to be installed on your system
- If jq is not installed, you'll get an error message with installation instructions

## Integration Examples

### Using with jq (via pipes)

You can also pipe JSON output to jq for advanced filtering and formatting:

```bash
# Get total cost for the last 7 days
ccusage daily --json --since $(date -d '7 days ago' +%Y%m%d) | jq '.summary.totalCostUSD'

# List all unique models used
ccusage session --json | jq -r '.data[].models[]' | sort -u

# Find the most expensive session
ccusage session --json | jq -r '.data | sort_by(.costUSD) | reverse | .[0].session'

# Get daily costs as CSV
ccusage daily --json | jq -r '.daily[] | [.date, .totalCost] | @csv'

# Analyze project costs
ccusage daily --instances --json | jq -r '.projects | to_entries[] | [.key, (.value | map(.totalCost) | add)] | @csv'

# Find most expensive project
ccusage daily --instances --json | jq -r '.projects | to_entries | map({project: .key, total: (.value | map(.totalCost) | add)}) | sort_by(.total) | reverse | .[0].project'

# Get usage by project for specific date
ccusage daily --instances --json | jq '.projects | to_entries[] | select(.value[].date == "2025-05-30") | {project: .key, usage: .value[0]}'
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

total_cost = data['totals']['totalCost']
print(f"Total cost: ${total_cost:.2f}")

# Project analysis example
result = subprocess.run(['ccusage', 'daily', '--instances', '--json'], capture_output=True, text=True)
project_data = json.loads(result.stdout)

if 'projects' in project_data:
    for project_name, daily_entries in project_data['projects'].items():
        project_total = sum(day['totalCost'] for day in daily_entries)
        print(f"Project {project_name}: ${project_total:.2f}")
        
    # Find highest spending project
    project_totals = {
        project: sum(day['totalCost'] for day in days)
        for project, days in project_data['projects'].items()
    }
    top_project = max(project_totals, key=project_totals.get)
    print(f"Highest spending project: {top_project} (${project_totals[top_project]:.2f})")
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

// Project analysis example
const projectOutput = execSync('ccusage daily --instances --json', { encoding: 'utf-8' });
const projectData = JSON.parse(projectOutput);

if (projectData.projects) {
	// Calculate total cost per project
	const projectCosts = Object.entries(projectData.projects).map(([name, days]) => ({
		name,
		totalCost: days.reduce((sum, day) => sum + day.totalCost, 0),
		totalTokens: days.reduce((sum, day) => sum + day.totalTokens, 0)
	}));

	// Sort by cost descending
	projectCosts.sort((a, b) => b.totalCost - a.totalCost);
	
	console.log('Project Usage Summary:');
	projectCosts.forEach(project => {
		console.log(`${project.name}: $${project.totalCost.toFixed(2)} (${project.totalTokens.toLocaleString()} tokens)`);
	});
}
```

## Programmatic Usage

JSON output is designed for programmatic consumption:

- **Consistent structure**: All fields are always present (with 0 or empty values when not applicable)
- **Standard types**: Numbers for metrics, strings for identifiers, arrays for lists
- **ISO timestamps**: Standardized date/time formats for reliable parsing
- **Stable schema**: Field names and structures remain consistent across versions
