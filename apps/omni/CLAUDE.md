# Omni CLI Notes

## Goal

- `@ccusage/omni` aggregates usage data from Claude Code, Codex, OpenCode, and Pi-agent into a single report.
- Amp is intentionally excluded from v1 due to schema and billing differences.

## Data Sources

| Source       | Default Directory                                      | Env Override        |
| ------------ | ------------------------------------------------------ | ------------------- |
| Claude Code  | `~/.config/claude/projects/` and `~/.claude/projects/` | `CLAUDE_CONFIG_DIR` |
| OpenAI Codex | `~/.codex/sessions/`                                   | `CODEX_HOME`        |
| OpenCode     | `~/.local/share/opencode/storage/message/`             | `OPENCODE_DATA_DIR` |
| Pi-agent     | `~/.pi/agent/sessions/`                                | `PI_AGENT_DIR`      |

## Token Semantics

- Totals are source-faithful.
- Claude/OpenCode/Pi: `totalTokens = input + output + cacheRead + cacheCreation`.
- Codex: `totalTokens = input + output` (cache is a subset of input and is not additive).
- Omni grand totals only sum **cost** across sources.

## CLI Usage

```bash
npx @ccusage/omni@latest daily
npx @ccusage/omni@latest monthly
npx @ccusage/omni@latest session
```

Common flags:

- `--json` / `-j` JSON output
- `--sources` / `-s` Comma-separated list (claude,codex,opencode,pi)
- `--compact` / `-c` Force compact table
- `--since`, `--until` Date filters (YYYY-MM-DD or YYYYMMDD)
- `--days` / `-d` Last N days
- `--timezone` Timezone for date grouping
- `--locale` Locale for formatting
- `--offline` Use cached pricing data (Claude/Codex)

Notes:

- `--since`/`--until`/`--days` are passed to Claude, Codex, and Pi. OpenCode currently returns all data (future filtering).
- Codex rows mark cache with a dagger to indicate subset-of-input semantics.

## Architecture

- Normalizers live in `src/_normalizers/`.
- Aggregation logic is in `src/data-aggregator.ts`.
- CLI entry is `src/index.ts` and `src/run.ts` (Gunshi-based).

## Development

- Omni is a bundled CLI; keep runtime deps in `devDependencies`.
- Use `@ccusage/terminal` for tables and `@ccusage/internal` for logging/pricing.
- Prefer `@praha/byethrow` Result type when adding new error handling.

## Testing

- In-source vitest blocks using `if (import.meta.vitest != null)`.
- Vitest globals are enabled: use `describe`, `it`, `expect` without imports.
- Never use dynamic `await import()` in tests or runtime code.
