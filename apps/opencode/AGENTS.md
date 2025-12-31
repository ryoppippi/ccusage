# OpenCode CLI Notes

## Architecture Overview

This is a CLI tool for analyzing OpenCode token usage, following the same patterns as `@ccusage/codex`. The architecture consists of:

1. **Data Loading** (`data-loader.ts`) - Reads hierarchical JSON files from OpenCode storage
2. **Pricing** (`pricing.ts`) - LiteLLM pricing fallback for models with zero pre-calculated costs
3. **Reports** (`daily-report.ts`, `monthly-report.ts`, `session-report.ts`) - Aggregate and format usage data
4. **CLI** (`commands/`) - Gunshi-based CLI with subcommands

## Log Sources

- OpenCode stores usage data under `${XDG_DATA_HOME:-~/.local/share}/opencode/storage/` following XDG Base Directory specification.
- Data is stored in hierarchical JSON files (not JSONL):
  - `project/{projectID}.json` - Project metadata
  - `session/{projectID}/{sessionID}.json` - Session metadata
  - `message/{sessionID}/{messageID}.json` - Individual message data with token counts and costs
  - `part/{messageID}/{partID}.json` - Message parts (not used for usage tracking)
- Only assistant messages contain token usage data; user messages are skipped.

## Token Fields

- `tokens.input`: total input tokens sent to the model.
- `tokens.output`: output tokens (completion text).
- `tokens.reasoning`: reasoning tokens (structured thinking).
- `tokens.cache.read`: tokens read from prompt cache.
- `tokens.cache.write`: tokens written to prompt cache.
- `cost`: pre-calculated USD cost from OpenCode (may be 0 for some providers).

## Cost Calculation

OpenCode provides pre-calculated costs in each message, but many providers (Google, Anthropic direct API) report `cost: 0`. This package implements a **hybrid cost calculation approach**:

### Primary: Pre-calculated Costs
- The `cost` field in message JSON is used when available and non-zero.
- This ensures cost accuracy matches OpenCode's billing for providers that report costs.

### Fallback: LiteLLM Pricing
- When `cost === 0` and `totalTokens > 0`, costs are calculated from token counts using LiteLLM pricing data.
- The `OpenCodePricingSource` class (in `pricing.ts`) fetches pricing from LiteLLM's model database.
- Supports provider prefixes: `anthropic/`, `openai/`, `azure/`, `google/`, `openrouter/`, `moonshotai/`.

### Cost Calculation Formula
```typescript
cost = (inputTokens / 1M) * inputCostPerMToken
     + (outputTokens / 1M) * outputCostPerMToken
     + (cacheReadTokens / 1M) * cacheReadCostPerMToken
     + (cacheWriteTokens / 1M) * cacheWriteCostPerMToken
```

### CLI Options
- `--offline`: Use cached LiteLLM pricing data (no network requests)
- Default: Fetches latest pricing from LiteLLM on first use

### Token Mapping & Billing

| Field                | Meaning                        | Billing treatment                          |
| -------------------- | ------------------------------ | ------------------------------------------ |
| `tokens.input`       | Prompt tokens sent this turn   | Pre-calculated or LiteLLM input cost       |
| `tokens.output`      | Completion tokens              | Pre-calculated or LiteLLM output cost      |
| `tokens.reasoning`   | Reasoning/thinking tokens      | Included in output (not billed separately) |
| `tokens.cache.read`  | Prompt tokens from cache       | Pre-calculated or LiteLLM cache read cost  |
| `tokens.cache.write` | Prompt tokens written to cache | Pre-calculated or LiteLLM cache write cost |
| `cost`               | Pre-calculated USD cost        | Used directly when non-zero                |

## CLI Usage

- Treat OpenCode as a sibling to `apps/ccusage` and `apps/codex`; reuse shared packages (`@ccusage/terminal`, `@ccusage/internal`) where possible.
- OpenCode is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies` so the bundle includes the code that ships.
- Entry point is Gunshi-based with subcommands: `daily`, `monthly`, `session`.
- Data discovery uses `OPENCODE_DATA_DIR` environment variable or defaults to XDG data path.
- `--json` toggles structured output; totals include aggregated tokens and USD cost.
- `--offline` uses cached pricing data without network requests.
- Table view lists models per day/month/session with their token totals.

## Key Differences from Codex

| Aspect           | Codex                           | OpenCode                                        |
| ---------------- | ------------------------------- | ----------------------------------------------- |
| Data format      | JSONL files                     | Hierarchical JSON files                         |
| Cost source      | LiteLLM pricing only            | Pre-calculated + LiteLLM fallback               |
| Cache tokens     | `cachedInputTokens` only        | `cacheReadTokens` + `cacheWriteTokens`          |
| Reasoning tokens | `reasoningOutputTokens`         | `reasoningTokens`                               |
| Timestamps       | ISO string                      | Unix milliseconds (number)                      |
| Session ID       | From filename                   | From JSON content                               |
| Pricing class    | `CodexPricingSource`            | `OpenCodePricingSource`                         |

## File Structure

```
src/
  _consts.ts          # Constants (MILLION, default paths)
  _types.ts           # TypeScript types (TokenUsageEvent, ModelPricing, etc.)
  _shared-args.ts     # CLI argument definitions (--json, --offline)
  logger.ts           # Logging utilities
  token-utils.ts      # Token aggregation helpers
  date-utils.ts       # Date formatting utilities
  command-utils.ts    # CLI command helpers
  data-loader.ts      # OpenCode JSON file parser
  pricing.ts          # LiteLLM pricing integration
  daily-report.ts     # Daily aggregation and formatting
  monthly-report.ts   # Monthly aggregation and formatting
  session-report.ts   # Session aggregation and formatting
  run.ts              # CLI runner setup
  index.ts            # Entry point
  commands/
    daily.ts          # Daily subcommand
    monthly.ts        # Monthly subcommand
    session.ts        # Session subcommand
```

## Testing Notes

- Tests use in-source testing with `if (import.meta.vitest != null)` blocks.
- Vitest globals are enabled; use `describe`, `it`, `expect` directly without imports.
- Mock data creates TokenUsageEvent arrays directly without filesystem fixtures.
- Pricing tests use offline mode with mock pricing data loaders.
- All tests use current Claude 4 models for realistic validation.
