# Library Usage

While **ccusage** itself is now CLI-only, the shared logic that powers the CLI is published via the `@ccusage/core` package. これを使うことで、Claude Code の使用状況をアプリケーション内から直接解析できます。

## Installation

```bash
pnpm add @ccusage/core
# or
npm install @ccusage/core
```

## Basic Usage

The library provides functions to load and analyze Claude Code usage data:

```typescript
import {
	loadDailyUsageData,
	loadMonthlyUsageData,
	loadSessionData,
} from '@ccusage/core/claude-code';

// Load daily usage data
const dailyData = await loadDailyUsageData();
console.log(dailyData);

// Load monthly usage data
const monthlyData = await loadMonthlyUsageData();
console.log(monthlyData);

// Load session data
const sessionData = await loadSessionData();
console.log(sessionData);
```

## Cost Calculation

Use the cost calculation utilities to work with token costs:

```typescript
import {
	calculateTotals,
	getTotalTokens,
} from '@ccusage/core/calculate-cost';

// Assume 'usageEntries' is an array of usage data objects
const totals = calculateTotals(usageEntries);

// Get total tokens from the same entries
const totalTokens = getTotalTokens(usageEntries);
```

## Advanced Configuration

You can customize the data loading behavior:

```typescript
import { loadDailyUsageData } from '@ccusage/core/claude-code';

// Load data with custom options
const data = await loadDailyUsageData({
	mode: 'calculate', // Force cost calculation
	claudePaths: ['/custom/path/to/claude'], // Custom Claude data paths
});
```

## TypeScript Support

The library is fully typed with TypeScript definitions:

```typescript
import type {
	DailyUsage,
	ModelBreakdown,
	MonthlyUsage,
	SessionUsage,
	UsageData,
} from '@ccusage/core/claude-code';

// Use the types in your application
function processUsageData(data: UsageData[]): void {
	// Your processing logic here
}
```

## MCP Server Integration

You can also create your own MCP server using the dedicated `@ccusage/mcp` package:

> **Note**: The MCP server consumes the same core utilities. Install both `@ccusage/core` and `@ccusage/mcp` (for example `pnpm add @ccusage/core @ccusage/mcp`).

```typescript
import { createMcpServer } from '@ccusage/mcp';

// Create an MCP server instance
const server = createMcpServer();

// Start the server
server.start();
```

## API Reference

For detailed information about all available functions, types, and options, see the [API Reference](/api/) section.

## Examples

Here are some common use cases:

### Building a Web Dashboard

```typescript
import { loadDailyUsageData } from '@ccusage/core/claude-code';

export async function GET() {
	const data = await loadDailyUsageData();
	return Response.json(data);
}
```

### Creating Custom Reports

```typescript
import {
	calculateTotals,
} from '@ccusage/core/calculate-cost';
import { loadSessionData } from '@ccusage/core/claude-code';

async function generateCustomReport() {
	const sessions = await loadSessionData();

	const report = sessions.map(session => ({
		project: session.project,
		session: session.session,
		totalCost: calculateTotals(session.usage).costUSD,
	}));

	return report;
}
```

### Monitoring Usage Programmatically

```typescript
import { loadDailyUsageData } from '@ccusage/core/claude-code';

async function checkUsageAlert() {
	const dailyData = await loadDailyUsageData();
	const today = dailyData[0]; // Most recent day

	if (today.totalCostUSD > 10) {
		console.warn(`High usage detected: $${today.totalCostUSD}`);
	}
}
```

## Next Steps

- Explore the [API Reference](/api/) for complete documentation
- Check out the [MCP Server guide](/guide/mcp-server) for integration examples
- See [JSON Output](/guide/json-output) for data format details
