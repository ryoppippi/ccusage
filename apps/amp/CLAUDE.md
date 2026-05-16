# Amp CLI Notes

This package implements Amp usage tracking for the unified `ccusage amp` command.

## Skills

- Use `ccusage-agent-sources` for Amp thread files, usage ledger parsing, cache token breakdown, credits, cost calculation, and commands.
- Use `ccusage-development` for monorepo, bundled CLI, dependency, logging, and validation conventions.
- Use `ccusage-testing` for in-source Vitest and fixture patterns.
- Use `use-gunshi-cli` when changing commands.

## Package Notes

Treat Amp as an agent subcommand of `ccusage`; reuse shared packages wherever possible. Data discovery relies on `AMP_DATA_DIR`.

`ccusage-amp` is a deprecated compatibility wrapper. Prefer `ccusage amp ...` in examples, tests, docs, and new behavior.
