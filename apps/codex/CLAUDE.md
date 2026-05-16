# Codex CLI Notes

This package implements Codex usage tracking for the unified `ccusage codex` command.

## Skills

- Use `ccusage-agent-sources` for Codex log sources, token fields, fallback model behavior, cost calculation, and CLI semantics.
- Use `ccusage-development` for monorepo, bundled CLI, dependency, logging, and validation conventions.
- Use `ccusage-testing` for in-source Vitest, fixtures, and pricing test patterns.
- Use `use-gunshi-cli` when changing commands.

## Package Notes

Treat Codex as an agent subcommand of `ccusage`; reuse shared terminal, pricing, and logging packages wherever possible. Data discovery relies on `CODEX_HOME`; there is no explicit `--dir` override.

`ccusage-codex` is a deprecated compatibility wrapper. Prefer `ccusage codex ...` in examples, tests, docs, and new behavior.
