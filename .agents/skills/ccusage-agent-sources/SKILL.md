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

## Agent Details

Read only the relevant reference before changing parser behavior, token mappings, data directory detection, fallback models, or agent-specific CLI flags:

- Claude Code: `references/claude-code.md`
- Codex: `references/codex.md`
- OpenCode: `references/opencode.md`
- Amp: `references/amp.md`
- pi-agent: `references/pi-agent.md`

## Implementation Notes

- Treat Codex, OpenCode, Amp, and pi-agent as agent subcommands under the unified `ccusage` CLI.
- Reuse shared packages such as `@ccusage/terminal`, `@ccusage/internal`, pricing helpers, and logging where appropriate.
- Keep command names and flag semantics aligned unless the source data forces a difference.
- Internal workspace runtime libraries for bundled/private agent apps belong in `devDependencies`.
- Deprecated wrapper packages must keep install-time runtime dependencies such as `ccusage` in `dependencies`.
