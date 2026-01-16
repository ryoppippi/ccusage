# @ccusage/omni Implementation Plan

> Unified usage tracking across all AI coding assistants

## Overview

**Goal:** Create a new `@ccusage/omni` package that aggregates usage data from all existing ccusage CLI tools into a single, unified view.

**Supported Sources (v1):**
| Source | Package | Data Directory | Env Override |
|--------|---------|----------------|--------------|
| Claude Code | `ccusage` | `~/.claude/projects/` or `~/.config/claude/projects/` | `CLAUDE_CONFIG_DIR` |
| OpenAI Codex | `@ccusage/codex` | `~/.codex/sessions/` | `CODEX_HOME` |
| OpenCode | `@ccusage/opencode` | `~/.local/share/opencode/storage/message/` | `OPENCODE_DATA_DIR` |
| Pi-agent | `@ccusage/pi` | `~/.pi/agent/sessions/` | `PI_AGENT_DIR` |

> **Note:** Amp (`@ccusage/amp`) is excluded from v1 due to significant schema/semantics divergence (credits-based billing, different totalTokens calculation, different field names). Amp support is planned for a future version.

**Usage:**

```bash
npx @ccusage/omni@latest daily      # Combined daily report
npx @ccusage/omni@latest monthly    # Combined monthly report
npx @ccusage/omni@latest session    # Combined session report
```

---

## Key Design Decisions

These decisions have been confirmed through review:

1. **Data Access Strategy:** Add exports to each app (Option A)
   - Least disruptive approach
   - Requires adding `exports` to each app's `package.json`
   - Requires updating `tsdown.config.ts` to build exported files

2. **Totals Semantics:** Source-faithful (Option A)
   - Omni totals match each individual CLI exactly
   - Grand total row shows **cost only** (comparable across sources)
   - Token totals shown per-source only (not summed across sources with different semantics)

3. **`--breakdown` Flag:** Omit for v1 (Option C)
   - Only Claude and Pi support `--breakdown`
   - Show models list in output instead
   - Can add `--breakdown` later when all sources support it

4. **Amp Exclusion:** Removed from v1 scope
   - Different billing model (credits vs subscription)
   - Different totalTokens semantics (cache excluded)
   - Different field names throughout
   - Planned for future version

---

## Data Access Architecture

### Current State of Each App

| App      | Has Daily Loader            | Has Report Builder      | tsdown Builds       | Needs Changes                |
| -------- | --------------------------- | ----------------------- | ------------------- | ---------------------------- |
| ccusage  | ✅ `loadDailyUsageData()`   | Built-in                | `./src/*.ts`        | None (already exports)       |
| codex    | ❌ Raw only                 | ✅ `buildDailyReport()` | `src/index.ts` only | Add exports + tsdown entries |
| opencode | ❌ Raw only                 | ❌ In-command           | `src/index.ts` only | Add report builder + exports |
| pi       | ✅ `loadPiAgentDailyData()` | Built-in                | `src/index.ts` only | Add exports + tsdown entries |

### Required Changes Per App

#### `@ccusage/codex`

**package.json** - Add exports:

```json
{
	"exports": {
		".": "./src/index.ts",
		"./data-loader": "./src/data-loader.ts",
		"./daily-report": "./src/daily-report.ts",
		"./monthly-report": "./src/monthly-report.ts",
		"./session-report": "./src/session-report.ts",
		"./types": "./src/_types.ts",
		"./package.json": "./package.json"
	},
	"publishConfig": {
		"exports": {
			".": "./dist/index.js",
			"./data-loader": "./dist/data-loader.js",
			"./daily-report": "./dist/daily-report.js",
			"./monthly-report": "./dist/monthly-report.js",
			"./session-report": "./dist/session-report.js",
			"./types": "./dist/_types.js",
			"./package.json": "./package.json"
		}
	}
}
```

**tsdown.config.ts** - Add entry points:

```typescript
entry: [
  'src/index.ts',
  'src/data-loader.ts',
  'src/daily-report.ts',
  'src/monthly-report.ts',
  'src/session-report.ts',
  'src/_types.ts',
],
```

#### `@ccusage/pi`

**package.json** - Add exports:

```json
{
	"exports": {
		".": "./src/index.ts",
		"./data-loader": "./src/data-loader.ts",
		"./package.json": "./package.json"
	},
	"publishConfig": {
		"exports": {
			".": "./dist/index.js",
			"./data-loader": "./dist/data-loader.js",
			"./package.json": "./package.json"
		}
	}
}
```

Note: Pi's types (`DailyUsageWithSource`, `SessionUsageWithSource`, `MonthlyUsageWithSource`) are defined and exported from `data-loader.ts`, not a separate types file.

**tsdown.config.ts** - Add entry points:

```typescript
entry: [
  'src/index.ts',
  'src/data-loader.ts',
],
```

#### `@ccusage/opencode`

This app needs **new report builder functions** similar to Codex's pattern.

**Naming Convention:**

- Report builders should be named `buildDailyReport`, `buildMonthlyReport`, `buildSessionReport`
- Return types should be `DailyReportRow`, `MonthlyReportRow`, `SessionReportRow`
- Types are exported from the report builder files

**Required Changes:**

1. Create `daily-report.ts`, `monthly-report.ts`, `session-report.ts`
2. Extract grouping logic from commands into these files
3. Export report row types from each report builder file
4. Add exports and tsdown entries

**OpenCode Report Row Types:**

```typescript
// daily-report.ts
export type DailyReportRow = {
	date: string; // YYYY-MM-DD
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number; // input + output + cache (additive)
	totalCost: number;
	modelsUsed: string[];
};

// monthly-report.ts
export type MonthlyReportRow = {
	month: string; // YYYY-MM
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
};

// session-report.ts
export type SessionReportRow = {
	sessionID: string; // Note: uppercase ID (matches current CLI output)
	sessionTitle: string;
	parentID: string | null; // Note: uppercase ID (matches current CLI output)
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	modelsUsed: string[];
	lastActivity: string; // ISO timestamp
};
```

### What Omni Will Import

```typescript
import type { DailyReportRow as CodexDailyReportRow } from '@ccusage/codex/types';
import type { DailyReportRow as OpenCodeDailyReportRow } from '@ccusage/opencode/daily-report';

import type { DailyUsageWithSource as PiDailyUsage } from '@ccusage/pi/data-loader';
import type { DailyUsage } from 'ccusage/data-loader';
import { buildDailyReport as buildCodexDailyReport } from '@ccusage/codex/daily-report';

// Codex - after adding exports (types already in _types.ts)
import { loadTokenUsageEvents } from '@ccusage/codex/data-loader';
// OpenCode - after adding report builders + exports
import { buildDailyReport as buildOpenCodeDailyReport } from '@ccusage/opencode/daily-report';

// Pi - after adding exports (types already in data-loader.ts)
import { loadPiAgentDailyData } from '@ccusage/pi/data-loader';
// Claude - already exports everything
import { loadDailyUsageData } from 'ccusage/data-loader';
```

---

## Architecture

### Directory Structure

```
apps/omni/
├── src/
│   ├── index.ts                 # CLI entry point (gunshi)
│   ├── run.ts                   # CLI runner setup
│   ├── logger.ts                # Logger instance
│   ├── _types.ts                # Unified type definitions
│   ├── _consts.ts               # Constants (source names, colors)
│   ├── _normalizers/            # Per-source data normalizers
│   │   ├── index.ts             # Re-exports all normalizers
│   │   ├── claude.ts            # Claude Code normalizer
│   │   ├── codex.ts             # Codex normalizer (special handling)
│   │   ├── opencode.ts          # OpenCode normalizer
│   │   └── pi.ts                # Pi-agent normalizer
│   ├── data-aggregator.ts       # Main aggregation logic
│   └── commands/
│       ├── index.ts             # Command exports
│       ├── daily.ts             # Combined daily report
│       ├── monthly.ts           # Combined monthly report
│       └── session.ts           # Combined session report
├── package.json
├── tsconfig.json
├── tsdown.config.ts
├── vitest.config.ts
├── eslint.config.js
└── CLAUDE.md
```

### Dependencies

```json
{
	"devDependencies": {
		"ccusage": "workspace:*",
		"@ccusage/codex": "workspace:*",
		"@ccusage/opencode": "workspace:*",
		"@ccusage/pi": "workspace:*",
		"@ccusage/internal": "workspace:*",
		"@ccusage/terminal": "workspace:*",
		"@praha/byethrow": "catalog:runtime",
		"gunshi": "catalog:runtime",
		"picocolors": "catalog:runtime",
		"valibot": "catalog:runtime",
		"type-fest": "catalog:runtime",
		"es-toolkit": "catalog:runtime",
		"fast-sort": "catalog:runtime",
		"vitest": "catalog:testing",
		"fs-fixture": "catalog:testing",
		"tsdown": "catalog:build",
		"clean-pkg-json": "catalog:release",
		"eslint": "catalog:lint",
		"@ryoppippi/eslint-config": "catalog:lint",
		"@typescript/native-preview": "catalog:types"
	}
}
```

---

## Type Definitions

### Unified Types (`_types.ts`)

```typescript
import type { TupleToUnion } from 'type-fest';

/**
 * Supported data sources (v1)
 */
export const Sources = ['claude', 'codex', 'opencode', 'pi'] as const;
export type Source = TupleToUnion<typeof Sources>;

/**
 * Unified token usage (normalized across all sources)
 *
 * IMPORTANT: Token semantics differ by source - totals are SOURCE-FAITHFUL:
 * - Claude/OpenCode/Pi: totalTokens = input + output + cacheRead + cacheCreation
 * - Codex: totalTokens = input + output (cache is subset of input, NOT additive)
 *
 * The normalizers preserve each source's native totalTokens calculation.
 * Grand totals should show COST ONLY since token semantics are not comparable.
 */
export type UnifiedTokenUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number; // Source-faithful, NOT recalculated
};

/**
 * Unified daily usage entry
 */
export type UnifiedDailyUsage = UnifiedTokenUsage & {
	source: Source;
	date: string; // YYYY-MM-DD
	costUSD: number;
	models: string[];
};

/**
 * Unified monthly usage entry
 */
export type UnifiedMonthlyUsage = UnifiedTokenUsage & {
	source: Source;
	month: string; // YYYY-MM
	costUSD: number;
	models: string[];
};

/**
 * Unified session usage entry
 */
export type UnifiedSessionUsage = UnifiedTokenUsage & {
	source: Source;
	sessionId: string;
	displayName: string; // Session name or project path
	firstTimestamp: string;
	lastTimestamp: string;
	costUSD: number;
	models: string[];
};

/**
 * Aggregated totals by source
 */
export type SourceTotals = {
	source: Source;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	totalTokens: number; // Source-faithful
	costUSD: number;
};

/**
 * Combined report totals
 * NOTE: Only costUSD is summed across sources. Token totals are per-source only.
 */
export type CombinedTotals = {
	costUSD: number; // Sum across all sources (comparable)
	bySource: SourceTotals[]; // Per-source breakdown with tokens
};
```

### Field Mapping Reference

| Unified Field         | Claude                | Codex                 | OpenCode              | Pi                    |
| --------------------- | --------------------- | --------------------- | --------------------- | --------------------- |
| `inputTokens`         | `inputTokens`         | `inputTokens`         | `inputTokens`         | `inputTokens`         |
| `outputTokens`        | `outputTokens`        | `outputTokens`        | `outputTokens`        | `outputTokens`        |
| `cacheReadTokens`     | `cacheReadTokens`     | `cachedInputTokens`\* | `cacheReadTokens`     | `cacheReadTokens`     |
| `cacheCreationTokens` | `cacheCreationTokens` | `0`                   | `cacheCreationTokens` | `cacheCreationTokens` |
| `totalTokens`         | input+output+cache    | `totalTokens`\*\*     | input+output+cache    | input+output+cache    |
| `costUSD`             | `totalCost`           | `costUSD`             | `totalCost`           | `totalCost`           |

**\* Codex Note:** `cachedInputTokens` is a **subset** of `inputTokens`, not additive.

**\*\* Codex totalTokens:** `totalTokens = input + output` (cache is subset, not added separately)

---

## Token Normalization Strategy

### Source-Faithful Approach

Each normalizer preserves the source's native `totalTokens` calculation:

**`_normalizers/claude.ts`**

```typescript
import type { DailyUsage } from 'ccusage/data-loader';
import type { UnifiedDailyUsage } from '../_types.ts';

export function normalizeClaudeDaily(data: DailyUsage): UnifiedDailyUsage {
	return {
		source: 'claude',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		// Claude includes cache in total
		totalTokens:
			data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}
```

**`_normalizers/codex.ts`**

```typescript
import type { DailyReportRow } from '@ccusage/codex/types';
import type { UnifiedDailyUsage } from '../_types.ts';

export function normalizeCodexDaily(data: DailyReportRow): UnifiedDailyUsage {
	return {
		source: 'codex',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		// Codex: cachedInputTokens is subset of inputTokens
		cacheReadTokens: data.cachedInputTokens,
		cacheCreationTokens: 0,
		// Source-faithful: use Codex's totalTokens directly (input + output)
		totalTokens: data.totalTokens,
		costUSD: data.costUSD,
		models: Object.keys(data.models),
	};
}
```

**`_normalizers/opencode.ts`**

```typescript
import type { DailyReportRow } from '@ccusage/opencode/daily-report';
import type { UnifiedDailyUsage } from '../_types.ts';

export function normalizeOpenCodeDaily(data: DailyReportRow): UnifiedDailyUsage {
	return {
		source: 'opencode',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		// OpenCode includes cache in total
		totalTokens: data.totalTokens,
		costUSD: data.totalCost,
		models: data.modelsUsed,
	};
}
```

**`_normalizers/pi.ts`**

```typescript
import type { DailyUsageWithSource } from '@ccusage/pi/data-loader';
import type { UnifiedDailyUsage } from '../_types.ts';

export function normalizePiDaily(data: DailyUsageWithSource): UnifiedDailyUsage {
	return {
		source: 'pi',
		date: data.date,
		inputTokens: data.inputTokens,
		outputTokens: data.outputTokens,
		cacheReadTokens: data.cacheReadTokens,
		cacheCreationTokens: data.cacheCreationTokens,
		// Pi includes cache in total
		totalTokens:
			data.inputTokens + data.outputTokens + data.cacheReadTokens + data.cacheCreationTokens,
		costUSD: data.totalCost, // Pi uses totalCost, not costUSD
		models: data.modelsUsed,
	};
}
```

---

## CLI Interface Design

### Common Flags

| Flag         | Short | Description                                | Notes                  |
| ------------ | ----- | ------------------------------------------ | ---------------------- |
| `--json`     | `-j`  | Output in JSON format                      | All sources            |
| `--sources`  | `-s`  | Comma-separated list of sources to include | All sources            |
| `--compact`  | `-c`  | Force compact table mode                   | All sources            |
| `--since`    |       | Start date filter (YYYY-MM-DD)             | Claude, Codex, Pi only |
| `--until`    |       | End date filter (YYYY-MM-DD)               | Claude, Codex, Pi only |
| `--days`     | `-d`  | Show last N days                           | Claude, Codex, Pi only |
| `--timezone` |       | Timezone for date display                  | Claude, Codex, Pi only |
| `--locale`   |       | Locale for number/date formatting          | Claude, Codex, Pi only |
| `--offline`  |       | Use cached pricing data                    | Claude, Codex only     |

**Notes:**

- `--breakdown` is intentionally omitted from v1. Models are shown in a column instead.
- `--offline` is passed only to Claude/Codex loaders until other sources support offline pricing.
- `--since`, `--until`, `--days`, `--timezone`, `--locale` are passed only to Claude/Codex/Pi loaders. OpenCode returns all data (filtering can be added in a future version).

### Example Commands

```bash
# All sources, daily report
npx @ccusage/omni@latest daily

# Only Claude and Codex
npx @ccusage/omni@latest daily --sources claude,codex

# JSON output
npx @ccusage/omni@latest daily --json

# Last 7 days
npx @ccusage/omni@latest daily --days 7

# With date range filter
npx @ccusage/omni@latest daily --since 2026-01-01 --until 2026-01-15
```

### Table Output Design

**Daily Report:**

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                    Omni Usage Report - Daily (All Sources)                           ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

┌──────────┬────────────┬─────────────┬──────────────┬───────────┬──────────┬──────────┐
│ Source   │ Date       │ Input       │ Output       │ Cache     │ Cost     │ Models   │
├──────────┼────────────┼─────────────┼──────────────┼───────────┼──────────┼──────────┤
│ Claude   │ 2026-01-16 │ 1,234,567   │ 456,789      │ 789,012   │ $12.34   │ sonnet-4 │
│ Codex    │ 2026-01-16 │ 987,654     │ 321,098      │ 654,321†  │ $8.76    │ gpt-5    │
│ OpenCode │ 2026-01-16 │ 543,210     │ 123,456      │ 234,567   │ $5.43    │ sonnet-4 │
│ Pi       │ 2026-01-16 │ 111,111     │ 22,222       │ 33,333    │ $1.50    │ sonnet-4 │
│ Claude   │ 2026-01-15 │ 1,111,111   │ 222,222      │ 333,333   │ $10.00   │ sonnet-4 │
│ Codex    │ 2026-01-15 │ 444,444     │ 555,555      │ 666,666†  │ $7.50    │ gpt-5    │
└──────────┴────────────┴─────────────┴──────────────┴───────────┴──────────┴──────────┘

† Codex cache is subset of input (not additive)

By Source:                              Cost
  • Claude ...................... $22.34
  • Codex ....................... $16.26
  • OpenCode ....................  $5.43
  • Pi ..........................  $1.50
                                 ───────
  TOTAL                          $45.53
```

**Key Design Points:**

- Token grand totals are NOT shown (different semantics per source)
- Cost grand total IS shown (comparable across sources)
- Per-source breakdown shows individual token totals
- Footnote explains Codex cache semantics

**Cache Column Definition:**

- Cache = `cacheReadTokens + cacheCreationTokens` (sum of both)
- For Codex, cache is still shown but marked with † to indicate it's a subset of input (not additive)

**JSON Output Structure:**

```json
{
	"daily": [
		{
			"source": "claude",
			"date": "2026-01-16",
			"inputTokens": 1234567,
			"outputTokens": 456789,
			"cacheReadTokens": 789012,
			"cacheCreationTokens": 0,
			"totalTokens": 2480368,
			"costUSD": 12.34,
			"models": ["claude-sonnet-4-20250514"]
		},
		{
			"source": "codex",
			"date": "2026-01-16",
			"inputTokens": 987654,
			"outputTokens": 321098,
			"cacheReadTokens": 654321,
			"cacheCreationTokens": 0,
			"totalTokens": 1308752,
			"costUSD": 8.76,
			"models": ["gpt-5"]
		}
	],
	"totals": {
		"costUSD": 45.53,
		"bySource": [
			{
				"source": "claude",
				"inputTokens": 2345678,
				"outputTokens": 679011,
				"cacheReadTokens": 1122345,
				"cacheCreationTokens": 0,
				"totalTokens": 4147034,
				"costUSD": 22.34
			},
			{
				"source": "codex",
				"inputTokens": 1432098,
				"outputTokens": 876653,
				"cacheReadTokens": 1320987,
				"cacheCreationTokens": 0,
				"totalTokens": 2308751,
				"costUSD": 16.26
			},
			{
				"source": "opencode",
				"inputTokens": 543210,
				"outputTokens": 123456,
				"cacheReadTokens": 200000,
				"cacheCreationTokens": 34567,
				"totalTokens": 901233,
				"costUSD": 5.43
			},
			{
				"source": "pi",
				"inputTokens": 111111,
				"outputTokens": 22222,
				"cacheReadTokens": 33333,
				"cacheCreationTokens": 0,
				"totalTokens": 166666,
				"costUSD": 1.5
			}
		]
	}
}
```

---

## CLI Entry Point

**`run.ts`** - Following existing Gunshi patterns:

```typescript
import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import { dailyCommand } from './commands/daily.ts';
import { monthlyCommand } from './commands/monthly.ts';
import { sessionCommand } from './commands/session.ts';

export async function run(): Promise<void> {
	const args = process.argv.slice(2);

	// Strip binary name if present (matches existing CLI patterns)
	const filteredArgs = args[0] === name ? args.slice(1) : args;

	await cli(filteredArgs, dailyCommand, {
		name,
		description,
		version,
		subCommands: {
			daily: dailyCommand,
			monthly: monthlyCommand,
			session: sessionCommand,
		},
	});
}
```

**`index.ts`**:

```typescript
#!/usr/bin/env node
import { run } from './run.ts';

await run();
```

---

## Testing Strategy

### Unit Tests (In-Source)

1. **Normalizer tests** - Verify each normalizer correctly transforms source data
   - **Critical: Test source-faithful totalTokens** - Codex uses input+output only
2. **Aggregator tests** - Verify data is properly combined and sorted
3. **Totals calculation tests** - Verify cost totals are summed, token totals are per-source only

### Test File Structure

Tests will be in-source using `if (import.meta.vitest != null)` blocks per project convention.

---

## Edge Cases & Error Handling

| Scenario                       | Handling                                             |
| ------------------------------ | ---------------------------------------------------- |
| Source has no data             | Skip silently, continue with other sources           |
| Source directory doesn't exist | Skip silently, log at debug level                    |
| Source data fails to parse     | Skip that source, log warning                        |
| All sources empty              | Display "No usage data found" message                |
| Single source requested        | Works like running that tool directly                |
| Network error (pricing)        | Use cached/fallback pricing                          |
| Codex missing totalTokens      | Calculate as `input + output` (per Codex convention) |

---

## Implementation Checklist

### Phase 0: Prerequisite Changes to Other Apps

- [ ] **@ccusage/codex**
  - [ ] Add exports to `package.json` (include `./types` → `_types.ts`)
  - [ ] Update `tsdown.config.ts` entry points (add `_types.ts`)

- [ ] **@ccusage/pi**
  - [ ] Add exports to `package.json` (types are in `data-loader.ts`, not `_types.ts`)
  - [ ] Update `tsdown.config.ts` entry points

- [ ] **@ccusage/opencode**
  - [ ] Create `daily-report.ts` (extract from command, export `DailyReportRow` type)
  - [ ] Create `monthly-report.ts` (extract from command, export `MonthlyReportRow` type)
  - [ ] Create `session-report.ts` (extract from command, export `SessionReportRow` type)
  - [ ] Add exports to `package.json`
  - [ ] Update `tsdown.config.ts` entry points

### Phase 1: Omni Scaffolding

- [ ] Create `apps/omni/` directory structure
- [ ] Create `package.json` with dependencies
- [ ] Create config files (tsconfig, tsdown, vitest, eslint)
- [ ] Create `CLAUDE.md`

### Phase 2: Core Infrastructure

- [ ] Create `_types.ts` with unified types (include token semantics docs)
- [ ] Create `_consts.ts` with source colors/labels
- [ ] Create `logger.ts`

### Phase 3: Normalizers

- [ ] Create `_normalizers/claude.ts`
- [ ] Create `_normalizers/codex.ts` (source-faithful totals)
- [ ] Create `_normalizers/opencode.ts`
- [ ] Create `_normalizers/pi.ts`
- [ ] Create `_normalizers/index.ts`
- [ ] Add unit tests for each normalizer

### Phase 4: Data Aggregator

- [ ] Create `data-aggregator.ts`
- [ ] Implement `loadCombinedDailyData()`
- [ ] Implement `loadCombinedMonthlyData()`
- [ ] Implement `loadCombinedSessionData()`
- [ ] Add unit tests

### Phase 5: Commands

- [ ] Create `commands/daily.ts`
- [ ] Create `commands/monthly.ts`
- [ ] Create `commands/session.ts`
- [ ] Create `commands/index.ts`

### Phase 6: CLI Entry

- [ ] Create `index.ts`
- [ ] Create `run.ts` (follow existing Gunshi patterns)
- [ ] Test CLI execution

### Phase 7: Release

- [ ] Run `pnpm run format`
- [ ] Run `pnpm typecheck`
- [ ] Run `pnpm run test`
- [ ] Build and test locally
- [ ] Submit PR

---

## Future Enhancements (Post v1)

1. **Amp support** - Add `@ccusage/amp` once schema/semantics alignment is resolved
2. **`--breakdown`** - Add once all sources support per-model breakdowns
3. **`--group-by-date`** - Aggregate all sources per date into single row
4. **Configurable source paths** - Override default directories via flags
5. **Trend analysis** - Compare usage across time periods
6. **Export formats** - CSV, HTML report generation
7. **MCP integration** - Add omni tools to `@ccusage/mcp`

---

## Notes

- All dependencies should be `devDependencies` (bundled app pattern)
- Follow existing code style (tabs, double quotes, `.ts` imports)
- Use `@praha/byethrow` Result type for error handling
- Use `gunshi` for CLI framework
- Use `@ccusage/terminal` for table rendering
- No `console.log` - use logger instead
- Vitest globals enabled - no imports needed for `describe`, `it`, `expect`
- `type-fest` is already used in ccusage for `TupleToUnion` - follow same pattern
