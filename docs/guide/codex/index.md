# Codex CLI Overview (Beta)

![Codex CLI daily report](/codex-cli.jpeg)

> ⚠️ The Codex companion CLI is experimental. Expect breaking changes while both ccusage and [OpenAI's Codex CLI](https://github.com/openai/codex) continue to evolve.

The `@ccusage/codex` package reuses ccusage's responsive tables, pricing cache, and token accounting to analyze OpenAI Codex CLI session logs. It is intentionally small so you can run it directly from the workspace during active development.

## Installation & Launch

```bash
# Recommended (fastest)
bunx @ccusage/codex --help

# Using npx
npx @ccusage/codex@latest --help
```

## Data Source

The CLI reads Codex session JSONL files located under `CODEX_HOME` (defaults to `~/.codex`). Each file represents a single Codex CLI session and contains running token totals that the tool converts into per-day or per-month deltas.

## Environment Variables

| Variable | Description |
| --- | --- |
| `CODEX_HOME` | Override the root directory containing Codex session folders |
| `LOG_LEVEL` | Adjust consola verbosity (0 silent … 5 trace) |

When Codex emits a model alias (for example `gpt-5-codex`), the CLI automatically resolves it to the canonical LiteLLM pricing entry. No manual override is needed.

## Next Steps

- [Daily report command](./daily.md)
- [Monthly report command](./monthly.md)
- Additional reports will mirror the ccusage CLI as the Codex tooling stabilizes.

Have feedback or ideas? [Open an issue](https://github.com/ryoppippi/ccusage/issues/new) so we can improve the beta.

## Troubleshooting

::: details Why are there no entries before September 2025?
OpenAI's Codex CLI started emitting `token_count` events in [commit 0269096](https://github.com/openai/codex/commit/0269096229e8c8bd95185173706807dc10838c7a) (2025-09-06). Earlier session logs simply don't contain token usage metrics, so `@ccusage/codex` has nothing to aggregate. If you need historic data, rerun those sessions after that Codex update.
:::

::: details What if some September 2025 sessions still get skipped?
During the 2025-09 rollouts a few Codex builds emitted `token_count` events without the matching `turn_context` metadata, so the CLI could not determine which model generated the tokens. Those entries are ignored to avoid mispriced reports. If you encounter this, relaunch the Codex CLI to generate fresh logs—the current builds restore the missing metadata.
:::
