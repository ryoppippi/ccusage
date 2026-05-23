# AGENTS.md - ccusage Package

This is the published `ccusage` npm package. The CLI implementation lives in Rust under `../../rust/crates/ccusage`; this package provides the npm metadata, package runner launcher, schema artifact, and benchmark scripts.

## Skills

- Use `development` for commands, bundled CLI dependency policy, style, exports, and validation.
- Use `testing` for Rust cargo tests, snapshots, fixtures, Claude models, LiteLLM pricing tests, and Vitest tests.
- Use `agent-sources` for Claude Code data directories, JSONL structure, session naming, cost modes, and report behavior.
- Use `typescript` before reading or editing TypeScript or JavaScript package code.

## Package Notes

- Published bin launcher: `src/cli.ts`
- Rust CLI implementation: `../../rust/crates/ccusage`
- PR benchmark scripts: `scripts/compare-pr-performance.ts` and `scripts/generate-large-fixture.ts`

The package is distributed as the canonical native CLI. Keep the public surface centered on `ccusage`, agent subcommands such as `ccusage amp`, and stable `--json` output instead of library-style TypeScript exports.
