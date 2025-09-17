# Codex CLI Overview (Beta)

![Codex CLI daily report](https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/codex-cli.png)

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

The CLI reads Codex session JSONL files located under `CODEX_HOME` (defaults to `~/.codex`). Each file represents a single Codex CLI session and contains running token totals that the tool converts into per-day deltas.

## Environment Variables

| Variable | Description |
| --- | --- |
| `CODEX_HOME` | Override the root directory containing Codex session folders |
| `CODEX_USAGE_MODEL` | Default model name when a log entry does not include model metadata |
| `LOG_LEVEL` | Adjust consola verbosity (0 silent … 5 trace) |

## Next Steps

- [Daily report command](./daily.md) (currently implemented)
- Additional reports will mirror the ccusage CLI as the Codex tooling stabilizes.

Have feedback or ideas? [Open an issue](https://github.com/ryoppippi/ccusage/issues/new) so we can improve the beta.
