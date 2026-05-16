---
name: ccusage-agent-sources
description: Implement or debug ccusage parsers and reports for Claude Code, Codex, OpenCode, Amp, and pi-agent usage data, including log locations, token field mappings, pricing rules, CLI flags, and package-specific behavior.
---

# ccusage Agent Sources

Use this skill when touching data loading, token normalization, cost calculation, or commands for any ccusage app.

## Shared Report Concepts

Reports aggregate raw usage into daily, monthly, session, or billing-block summaries and output either tables or JSON.

The canonical command surface is the unified `ccusage` CLI:

```sh
ccusage daily
ccusage codex daily
ccusage opencode daily
ccusage amp daily
ccusage pi daily
```

Standalone agent binaries such as `ccusage-codex`, `ccusage-opencode`, `ccusage-amp`, and `ccusage-pi` are deprecated compatibility wrappers. Preserve compatibility when needed, but do not promote standalone binaries in new docs, tests, or examples.

Cost modes:

- `auto` - prefer pre-calculated `costUSD` when available, otherwise calculate from tokens.
- `calculate` - calculate from token counts and ignore pre-calculated costs.
- `display` - use pre-calculated costs and show `0` when missing.

Pricing generally comes from LiteLLM's `model_prices_and_context_window.json`. The `--offline` flag forces embedded pricing snapshots where supported.

## Claude Code

Default data directories:

- `~/.config/claude/projects/`
- `~/.claude/projects/`

`CLAUDE_CONFIG_DIR` can specify one path or comma-separated multiple paths. Data from valid directories is combined.

File shape:

```text
projects/{project}/{sessionId}.jsonl
```

The term `session` has two meanings in this codebase:

- Session report grouping uses project directories.
- True Claude Code session ID is the JSONL `sessionId` field and filename.

Malformed JSONL lines are skipped during parsing.

## Codex

Data source:

```text
${CODEX_HOME:-~/.codex}/sessions/
```

Relevant JSONL event:

- `type === "event_msg"`
- `payload.type === "token_count"`
- `payload.info.total_token_usage` is cumulative.
- `payload.info.last_token_usage` is the current turn delta.
- If only cumulative totals exist, subtract prior totals to recover deltas.

Token mapping:

- `input_tokens` - total input tokens.
- `cached_input_tokens` - cached prompt tokens.
- `output_tokens` - completion tokens, including reasoning cost.
- `reasoning_output_tokens` - informational breakdown; already included in output billing.
- `total_tokens` - provided directly or recomputed as input plus output for legacy entries.

Pricing uses model metadata from `turn_context`. Early sessions without metadata fall back to `gpt-5`, mark `isFallbackModel === true`, and expose fallback rows as approximate in aggregate JSON.

## OpenCode

Data source:

```text
${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode.db
${OPENCODE_DATA_DIR:-~/.local/share/opencode}/opencode-*.db
```

SQLite databases are the primary source. Legacy JSON messages under `storage/message/` are loaded as a fallback and deduplicated behind database rows. Token mapping:

- `inputTokens` <- `tokens.input`
- `outputTokens` <- `tokens.output`
- `cacheReadInputTokens` <- `tokens.cache.read`
- `cacheCreationInputTokens` <- `tokens.cache.write`

Messages may include a pre-calculated `cost` field in USD.

## Amp

Data source:

```text
${AMP_DATA_DIR:-~/.local/share/amp}/threads/
```

Each thread is a JSON file named `T-{uuid}.json`.

Usage comes from:

- `usageLedger.events[]` for token usage and credits.
- `messages[].usage` for cache creation/read breakdown.

Token fields:

- `inputTokens`
- `outputTokens`
- `cacheCreationInputTokens`
- `cacheReadInputTokens`
- `totalTokens`

Amp also reports `credits`; display credits alongside USD estimates when the command/report supports it.

Commands:

```sh
ccusage amp daily
ccusage amp monthly
ccusage amp session
ccusage amp daily --json
ccusage amp daily --compact
```

## pi-agent

Data source:

```text
${PI_AGENT_DIR:-~/.pi/agent/sessions/}
```

Commands:

```sh
ccusage pi daily
ccusage pi monthly
ccusage pi session
ccusage pi daily --json
ccusage pi daily --pi-path /path/to/sessions
```

## Implementation Notes

- Treat Codex, OpenCode, Amp, and pi-agent as agent subcommands under the unified `ccusage` CLI.
- Reuse shared packages such as `@ccusage/terminal`, `@ccusage/internal`, pricing helpers, and logging where appropriate.
- Keep command names and flag semantics aligned unless the source data forces a difference.
- Agent packages may still contain deprecated wrapper binaries, so runtime libraries belong in `devDependencies`.
