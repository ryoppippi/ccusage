# CLAUDE.md - ccusage Package

This is the published `ccusage` npm package. The CLI implementation lives in Rust under `../../rust/crates/ccusage`; this package provides the npm metadata, package runner launcher, schema artifact, and benchmark scripts.

## Skills

- Use `ccusage-development` for commands, bundled CLI dependency policy, style, exports, and validation.
- Use `ccusage-testing` for in-source Vitest, snapshots, fixtures, Claude models, and LiteLLM pricing tests.
- Use `ccusage-agent-sources` for Claude Code data directories, JSONL structure, session naming, cost modes, and report behavior.
- Use `typescript-style` before reading or editing TypeScript or JavaScript package code.

## Package Notes

- Published bin launcher: `src/cli.ts`
- Empty library export: `src/index.ts`
- Rust CLI implementation: `../../rust/crates/ccusage`
- PR benchmark scripts: `scripts/compare-pr-performance.ts` and `scripts/generate-large-fixture.ts`

The package is distributed as the canonical native CLI. Keep the public surface centered on `ccusage`, agent subcommands such as `ccusage amp`, and stable `--json` output instead of library-style TypeScript exports.
