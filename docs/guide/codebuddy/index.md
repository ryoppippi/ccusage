# CodeBuddy Data Source (Experimental)

ccusage can experimentally read Tencent CodeBuddy Code session data as one of its supported local data sources. CodeBuddy Code is Tencent's local coding-agent CLI; it stores per-session JSONL transcripts with token usage information.

## What is CodeBuddy Code?

CodeBuddy Code is a coding (agent) CLI from Tencent. It records assistant messages with token counts and cache metrics for each session. ccusage reads these JSONL files and aggregates them alongside its other supported sources.

> Distinct from the existing **OpenClaw** adapter despite the surface name similarity — OpenClaw scans `~/.openclaw/` and uses different model identifiers; CodeBuddy uses `~/.codebuddy/projects/` and Tencent MaaS model IDs (e.g. `MaaS_Cl_Opus_4.7_*`).

## Focused Views

```bash
# Recommended
bunx ccusage codebuddy --help

# Alternative package runners
npx ccusage@latest codebuddy --help
pnpm dlx ccusage codebuddy --help
pnpx ccusage codebuddy --help
```

Available subcommands: `daily`, `monthly`, `session`.

## Data Source

The CLI scans this directory for CodeBuddy session files:

| Source    | Default paths            | Override                              |
| --------- | ------------------------ | ------------------------------------- |
| CodeBuddy | `~/.codebuddy/projects/` | `CODEBUDDY_DIR` or `--codebuddy-path` |

ccusage walks the root recursively. Each session produces both a top-level `<dir-slug>/<session-uuid>.jsonl` (the main session) and a sibling `<dir-slug>/<session-uuid>/subagents/agent-*.jsonl` (per-subagent transcripts). Both are picked up; the per-session `memory/` subdirectory is intentionally skipped.

## Cost reporting

This adapter reports token counts only. USD cost is reported as `0.0` because Tencent MaaS model identifiers are not present in the LiteLLM pricing table that ccusage uses for other sources. Pricing support may be added in a follow-up release.

## Notes

- Each subagent has its own `sessionId` distinct from the parent main session, so subagents appear as independent sessions in the `session` report. This matches CodeBuddy's own session model.
- Display labels follow the `[codebuddy] ...` convention (similar to `[openclaw] ...`) so unified-report rows clearly attribute usage to this source.
