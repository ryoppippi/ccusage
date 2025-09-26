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
- `total_tokens`: either provided directly or, for legacy entries, recomputed as `input + output` (reasoning is informational and already included in `output`).

-## Cost Calculation

- Pricing is pulled from LiteLLM's public JSON (`model_prices_and_context_window.json`).
- The CLI trusts the model metadata emitted in each `turn_context`. Sessions missing that metadata (observed in early September 2025 builds) fall back to `gpt-5` so the tokens remain visible, but the pricing should be considered approximate. These events are tagged with `isFallbackModel === true` and surface as `isFallback` in aggregated JSON.
- Per-model pricing is fetched through the shared `LiteLLMPricingFetcher` with an offline cache macro scoped to Codex-prefixed models. Aliases (e.g. `gpt-5-codex → gpt-5`) are handled in `CodexPricingSource` for pricing parity.
- Cost formula per model/date:
  - Non-cached input: `(input_tokens - cached_input_tokens) / 1_000_000 * input_cost_per_mtoken`.
  - Cached input: `cached_input_tokens / 1_000_000 * cached_input_cost_per_mtoken` (falls back to input price when missing).
  - Output: `output_tokens / 1_000_000 * output_cost_per_mtoken`.
- Cached token rate for `gpt-5` (2025-08-07 pricing):
  - Input: $0.00125 per 1K tokens (→ $1.25 per 1M).
  - Cached input: $0.000125 per 1K tokens (→ $0.125 per 1M).
  - Output: $0.01 per 1K tokens (→ $10 per 1M).
- Command flag `--offline` forces use of the embedded pricing snapshot.

### Token mapping & reasoning notes

| Field                                           | Meaning                                     | Billing treatment                                                        |
| ----------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `input_tokens`                                  | Prompt tokens sent this turn                | Priced at `input_cost_per_mtoken` minus the cached share                 |
| `cached_input_tokens`/`cache_read_input_tokens` | Prompt tokens satisfied from cache          | Priced at `cached_input_cost_per_mtoken` (falls back to input price)     |
| `output_tokens`                                 | Completion tokens, including reasoning cost | Priced at `output_cost_per_mtoken`                                       |
| `reasoning_output_tokens`                       | Optional breakdown for reasoning            | Informational only; already included in `output_tokens`                  |
| `total_tokens`                                  | Cumulative total emitted by Codex           | Used verbatim when present; legacy entries fall back to `input + output` |

Parsing normalizes every event through these rules. When we have to synthesize totals for legacy JSONL files we explicitly skip adding reasoning so the display matches what Codex billed. Events that rely on model/pricing fallbacks carry `isFallbackModel === true`, and aggregated model rows expose `isFallback` so table/JSON output highlights the assumption.

## CLI Usage

- Treat Codex as a sibling to `apps/ccusage`; whenever possible reuse the same shared packages (`@better-ccusage/terminal`, pricing helpers, logging), command names, and flag semantics. Diverge only when Codex-specific data forces it and document the reason inline.
- Codex is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies` so the bundle includes the code that ships.
- Entry point remains Gunshi-based; only `daily` subcommand is wired for now.
- Session discovery relies solely on `CODEX_HOME`; there is no explicit `--dir` override.
- `--json` toggles structured output; totals include aggregated tokens and USD cost.
- Table view lists models per day with their token totals in parentheses.

## Testing Notes

- Tests rely on `fs-fixture` with `using` to ensure cleanup.
- Pricing tests inject stub offline loaders to avoid network access.
- All vitest blocks live alongside implementation files via `if (import.meta.vitest != null)`.
