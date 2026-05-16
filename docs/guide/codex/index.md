# Codex Data Source (Beta)

![ccusage daily report focused on Codex usage](/codex-cli.jpeg)

> ⚠️ Codex log support is experimental while the Codex CLI log format continues to evolve.

ccusage can read OpenAI Codex CLI session logs as one of its supported local data sources. Most users can start with unified reports such as `ccusage daily`; add the `codex` namespace only when you want to focus the same report shape on Codex usage.

## Focused Views

```bash
# Daily Codex usage
ccusage codex daily

# Monthly Codex usage
ccusage codex monthly

# Codex sessions
ccusage codex session
```

## Data Source

The CLI reads Codex session JSONL files located under `CODEX_HOME` (defaults to `~/.codex`). Each file represents a single Codex CLI session and contains running token totals that the tool converts into per-day or per-month deltas.

## What Gets Calculated

- **Token deltas** – Each `event_msg` with `payload.type === "token_count"` reports cumulative totals. The CLI subtracts the previous totals to recover per-turn token usage (input, cached input, output, reasoning, total).
- **Per-model grouping** – The `turn_context` metadata specifies the active model. We aggregate tokens per day/month and per model. Sessions lacking model metadata (seen in early September 2025 builds) are skipped.
- **Pricing** – Rates come from LiteLLM's pricing dataset via the shared `LiteLLMPricingFetcher`. Aliases such as `gpt-5-codex` map to canonical entries (`gpt-5`) so cost calculations remain accurate.
- **Speed pricing** – `--speed auto` is the default. It reads `${CODEX_HOME:-~/.codex}/config.toml` and applies fast pricing when Codex has `service_tier = "priority"` or legacy `service_tier = "fast"` configured. Fast mode uses the model-specific LiteLLM multiplier when available and otherwise falls back to 2x pricing. Pass `--speed fast` or `--speed standard` to override config-based detection.
- **Legacy fallback** – Early September 2025 logs that never recorded `turn_context` metadata are still included; the CLI assumes `gpt-5` for pricing so you can review the tokens even though the model tag is missing (the JSON output also marks these rows with `"isFallback": true`).
- **Cost formula** – Non-cached input uses the standard input price; cached input uses the cache-read price (falling back to the input price when missing); and output tokens are billed at the output price. All prices are per million tokens. Reasoning tokens may be shown for reference, but they are part of the output charge and are not billed separately.
- **Totals and reports** – Daily, monthly, and session views display per-model breakdowns, overall totals, and optional JSON for automation.

## Environment Variables

| Variable     | Description                                                  |
| ------------ | ------------------------------------------------------------ |
| `CODEX_HOME` | Override the root directory containing Codex session folders |
| `LOG_LEVEL`  | Adjust log verbosity (0 silent … 5 trace)                    |

When Codex emits a model alias (for example `gpt-5-codex`), the CLI automatically resolves it to the canonical LiteLLM pricing entry. No manual override is needed.

## Speed Pricing

Codex logs usually do not include whether a turn used fast mode. By default, `ccusage codex` uses `--speed auto`, reads `${CODEX_HOME:-~/.codex}/config.toml`, and treats `service_tier = "priority"` or legacy `service_tier = "fast"` as fast pricing. Fast mode uses the model-specific LiteLLM multiplier when available and otherwise falls back to 2x pricing.

```bash
# Default: read Codex config.toml
ccusage codex daily --speed auto

# Force fast pricing
ccusage codex daily --speed fast

# Force standard pricing
ccusage codex daily --speed standard
```

## Next Steps

- [Daily Codex view](./daily.md)
- [Monthly Codex view](./monthly.md)
- [Session Codex view](./session.md)
- Additional views will mirror the main ccusage reports as Codex support stabilizes.

Have feedback or ideas? [Open an issue](https://github.com/ryoppippi/ccusage/issues/new) so we can improve the beta.

## Troubleshooting

::: details Why are there no entries before September 2025?
OpenAI's Codex CLI started emitting `token_count` events in [commit 0269096](https://github.com/openai/codex/commit/0269096229e8c8bd95185173706807dc10838c7a) (2025-09-06). Earlier session logs simply don't contain token usage metrics, so `ccusage codex` has nothing to aggregate. If you need historic data, rerun those sessions after that Codex update.
:::

::: details What if some September 2025 sessions still get skipped?
During the 2025-09 rollouts a few Codex builds emitted `token_count` events without the matching `turn_context` metadata, so the CLI could not determine which model generated the tokens. Those entries are ignored to avoid mispriced reports. If you encounter this, relaunch the Codex CLI to generate fresh logs—the current builds restore the missing metadata.
:::
