# Copilot CLI Notes

## Log Sources

- Copilot CLI session data is stored under `${COPILOT_CONFIG_DIR:-~/.copilot}/session-state/`.
- Each session is stored as a directory named with the session UUID (e.g., `session-state/{uuid}/`).
- Usage data is extracted from `events.jsonl` files within each session directory.
- Session metadata is available from `session.start` events and `workspace.yaml` files.

## Data Format

- `events.jsonl`: JSON Lines format, one event per line.
- Key event types:
  - `session.start` — session metadata (sessionId, copilotVersion, startTime, context)
  - `session.shutdown` — aggregated per-model token metrics (primary usage data source)
  - `session.resume` — session resume marker
  - `assistant.usage` — per-request usage (ephemeral, NOT persisted to disk)

## Token Fields (from session.shutdown modelMetrics)

- `inputTokens`: total input tokens sent to the model.
- `outputTokens`: output tokens (completion text).
- `cacheReadTokens`: tokens read from cache.
- `cacheWriteTokens`: tokens written to cache.
- `totalTokens`: sum of all token types.

## Premium Requests

- Copilot CLI tracks costs as premium request counts (not USD directly).
- Each model's `requests.cost` represents the number of premium requests consumed.
- `requests.count` is the total number of API requests made to that model.
- `totalPremiumRequests` in shutdown data is the session-wide premium request total.

## Models

Copilot CLI supports both Anthropic Claude and OpenAI GPT models:

- Claude: claude-haiku-4.5, claude-sonnet-4, claude-sonnet-4.5, claude-sonnet-4.6, claude-opus-4.5, claude-opus-4.6, claude-opus-4.6-1m, claude-opus-4.7
- GPT: gpt-5.1, gpt-5.2, gpt-5.4
- Other: goldeneye

## Cost Calculation

- Pricing is pulled from LiteLLM's public JSON (`model_prices_and_context_window.json`).
- Both Claude and GPT model pricing prefixes are supported.
- Cost formula per model:
  - Input: `inputTokens / 1_000_000 * input_cost_per_mtoken`
  - Cached input read: `cacheReadTokens / 1_000_000 * cached_input_cost_per_mtoken`
  - Cache creation: `cacheWriteTokens / 1_000_000 * cache_creation_cost_per_mtoken`
  - Output: `outputTokens / 1_000_000 * output_cost_per_mtoken`

## CLI Usage

- Treat Copilot as a sibling to `apps/ccusage`, `apps/codex`, `apps/amp`, etc.
- Reuse shared packages (`@ccusage/terminal`, `@ccusage/internal`) wherever possible.
- Copilot is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies`.
- Entry point uses Gunshi framework with subcommands: `daily`, `monthly`, `session`.
- Shared args defined in `_shared-args.ts` (json, since, until, timezone, locale, offline, compact, mode, order, breakdown, color/noColor).
- Date utilities in `_date-utils.ts` (timezone-aware grouping, date filtering).
- Data discovery relies on `COPILOT_CONFIG_DIR` environment variable.

## Environment Variables

- `COPILOT_CONFIG_DIR` — override default Copilot data directory (default: `~/.copilot`)
