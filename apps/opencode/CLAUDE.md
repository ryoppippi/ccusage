# OpenCode CLI Notes

This package implements OpenCode usage tracking for the unified `ccusage opencode` command.

## Skills

- Use `ccusage-agent-sources` for OpenCode data paths, JSON message shape, token mapping, cost handling, and CLI semantics.
- Use `ccusage-development` for monorepo, bundled CLI, dependency, logging, and validation conventions.
- Use `ccusage-testing` for in-source Vitest and fixture patterns.
- Use `use-gunshi-cli` when changing commands.

## Package Notes

Treat OpenCode as an agent subcommand of `ccusage`; reuse shared packages wherever possible. Data discovery relies on `OPENCODE_DATA_DIR`.

`ccusage-opencode` is a deprecated compatibility wrapper. Prefer `ccusage opencode ...` in examples, tests, docs, and new behavior.
