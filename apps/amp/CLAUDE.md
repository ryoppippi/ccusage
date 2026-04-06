# Amp CLI Notes

## Log Sources

- Amp session usage is recorded under `${AMP_DATA_DIR:-~/.local/share/amp}/threads/` (the CLI resolves `AMP_DATA_DIR` and falls back to `~/.local/share/amp`).
- Each thread is stored as a JSON file (not JSONL) named `T-{uuid}.json`.
- **Primary source** (since ~Jan 13, 2026): Token usage is extracted from `messages[].usage` for each assistant message.
- **Fallback** (legacy, pre-Jan 13, 2026): Uses `usageLedger.events[]` when `messages[].usage` is not available.

## Token Fields

- `inputTokens`: total input tokens sent to the model.
- `outputTokens`: output tokens (completion text).
- `cacheCreationInputTokens`: tokens used for cache creation (from message usage).
- `cacheReadInputTokens`: tokens read from cache (from message usage).
- `totalTokens`: sum of input and output tokens.

## Credits

- Amp uses a credits-based billing system in addition to standard token counts.
- Each usage event includes a `credits` field representing the billing cost in Amp's credit system.
- Credits are displayed alongside USD cost estimates in reports.

## Cost Calculation

- Pricing is pulled from LiteLLM's public JSON (`model_prices_and_context_window.json`).
- Amp primarily uses Anthropic Claude models (Haiku, Sonnet, Opus variants).
- Cost formula per model:
  - Input: `inputTokens / 1_000_000 * input_cost_per_mtoken`
  - Cached input read: `cacheReadInputTokens / 1_000_000 * cached_input_cost_per_mtoken`
  - Cache creation: `cacheCreationInputTokens / 1_000_000 * cache_creation_cost_per_mtoken`
  - Output: `outputTokens / 1_000_000 * output_cost_per_mtoken`

## CLI Usage

- Treat Amp as a sibling to `apps/ccusage`, `apps/codex`, and `apps/opencode`.
- Reuse shared packages (`@ccusage/terminal`, `@ccusage/internal`) wherever possible.
- Amp is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies`.
- Entry point uses Gunshi framework with subcommands: `daily`, `monthly`, `session`.
- Data discovery relies on `AMP_DATA_DIR` environment variable.
- Default path: `~/.local/share/amp`.

## Available Commands

- `ccusage-amp daily` - Show daily usage report
- `ccusage-amp monthly` - Show monthly usage report
- `ccusage-amp session` - Show usage by thread (session)
- Add `--json` flag for JSON output format
- Add `--compact` flag for compact table mode

## Testing Notes

- Tests rely on `fs-fixture` with `using` to ensure cleanup.
- All vitest blocks live alongside implementation files via `if (import.meta.vitest != null)`.
- Vitest globals are enabled - use `describe`, `it`, `expect` directly without imports.
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks.

## Data Structure

Amp thread files have the following structure:

**Current format (since ~Jan 13, 2026):**
```json
{
	"id": "T-{uuid}",
	"created": 1700000000000,
	"title": "Thread Title",
	"messages": [
		{
			"role": "assistant",
			"messageId": 1,
			"usage": {
				"model": "claude-opus-4-5-20251101",
				"inputTokens": 10,
				"outputTokens": 220,
				"cacheCreationInputTokens": 6904,
				"cacheReadInputTokens": 16371,
				"totalInputTokens": 23285,
				"timestamp": "2026-01-22T22:42:32.743Z"
			}
		}
	]
}
```

**Legacy format (before ~Jan 13, 2026):**
```json
{
	"id": "T-{uuid}",
	"messages": [],
	"usageLedger": {
		"events": [
			{
				"id": "event-uuid",
				"timestamp": "2025-11-23T10:00:00.000Z",
				"model": "claude-haiku-4-5-20251001",
				"credits": 1.5,
				"tokens": {
					"input": 100,
					"output": 50
				},
				"operationType": "inference",
				"fromMessageId": 0,
				"toMessageId": 1
			}
		]
	}
}
```

Note: Cache token information (`cacheCreationInputTokens`, `cacheReadInputTokens`) is only available in the current format via `messages[].usage`.

## Environment Variables

- `AMP_DATA_DIR` - Custom Amp data directory path (defaults to `~/.local/share/amp`)
- `LOG_LEVEL` - Control logging verbosity (0=silent, 1=warn, 2=log, 3=info, 4=debug, 5=trace)
