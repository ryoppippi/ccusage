# CLAUDE.md - ccusage Package

This is the main `ccusage` CLI package for Claude Code usage analysis.

## Skills

- Use `ccusage-development` for commands, bundled CLI dependency policy, style, exports, and validation.
- Use `ccusage-testing` for in-source Vitest, snapshots, fixtures, Claude models, and LiteLLM pricing tests.
- Use `ccusage-agent-sources` for Claude Code data directories, JSONL structure, session naming, cost modes, and report behavior.
- Use `byethrow` for Result-based error handling.
- Use `use-gunshi-cli` when changing command definitions.

## Package Notes

- Entry point: `src/index.ts`
- Data loading: `src/data-loader.ts`
- Cost aggregation: `src/calculate-cost.ts`
- Commands: `src/commands/`
- Logger: `src/logger.ts`

The package is distributed as the canonical bundled CLI. Keep the public surface centered on `ccusage`, agent subcommands such as `ccusage amp`, and stable `--json` output instead of library-style TypeScript exports.
