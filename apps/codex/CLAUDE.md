# Codex CLI Notes

## Log Sources

- Codex session usage is recorded under `${CODEX_HOME:-~/.codex}/sessions/` (the CLI resolves `CODEX_HOME` and falls back to `~/.codex`).
- Each JSONL line is an `event_msg` with `payload.type === "token_count"`.
- `payload.info.total_token_usage` holds cumulative totals; `payload.info.last_token_usage` is the delta for the most recent turn.
- When only cumulative totals are present, we subtract the previous totals to recover a per-event delta.

## Token Fields

- `input_tokens`: total input tokens sent to the model.
- `cached_input_tokens`: cached portion of the input (prompt-caching).
- `output_tokens`: normal output tokens (includes completion text).
- `reasoning_output_tokens`: structured reasoning tokens counted separately by OpenAI.
- `total_tokens`: either provided directly or recomputed as `input + output + reasoning`.

-## Cost Calculation

- Pricing is pulled from LiteLLM's public JSON (`model_prices_and_context_window.json`).
- The CLI trusts the model metadata emitted in each `turn_context`. Sessions missing that metadata (observed in early September 2025 builds) should be skipped rather than attempting a fallback.
- Per-model pricing is fetched through the shared `LiteLLMPricingFetcher` with an offline cache macro scoped to Codex-prefixed models. Aliases (e.g. `gpt-5-codex → gpt-5`) are handled in `CodexPricingSource` for pricing parity.
- Cost formula per model/date:
  - Non-cached input: `(input_tokens - cached_input_tokens) / 1_000_000 * input_cost_per_mtoken`.
  - Cached input: `cached_input_tokens / 1_000_000 * cached_input_cost_per_mtoken` (falls back to input price when missing).
  - Output: `(output_tokens + reasoning_output_tokens) / 1_000_000 * output_cost_per_mtoken`.
- Cached token rate for `gpt-5` (2025-08-07 pricing):
  - Input: $0.00125 per 1K tokens (→ $1.25 per 1M).
  - Cached input: $0.000125 per 1K tokens (→ $0.125 per 1M).
  - Output: $0.01 per 1K tokens (→ $10 per 1M).
- Command flag `--offline` forces use of the embedded pricing snapshot.

## CLI Usage

- Treat Codex as a sibling to `apps/ccusage`; whenever possible reuse the same shared packages (`@ccusage/terminal`, pricing helpers, logging), command names, and flag semantics. Diverge only when Codex-specific data forces it and document the reason inline.
- Codex is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies` so the bundle includes the code that ships.
- Entry point remains Gunshi-based; only `daily` subcommand is wired for now.
- Session discovery relies solely on `CODEX_HOME`; there is no explicit `--dir` override.
- `--json` toggles structured output; totals include aggregated tokens and USD cost.
- Table view lists models per day with their token totals in parentheses.

## Testing Notes

- Tests rely on `fs-fixture` with `using` to ensure cleanup.
- Pricing tests inject stub offline loaders to avoid network access.
- All vitest blocks live alongside implementation files via `if (import.meta.vitest != null)`.
