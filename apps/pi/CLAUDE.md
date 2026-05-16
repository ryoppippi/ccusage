# CLAUDE.md - Pi Package

This package implements pi-agent usage tracking for the unified `ccusage pi` command.

## Skills

- Use `ccusage-agent-sources` for pi-agent data paths, command behavior, and shared usage-report concepts.
- Use `ccusage-development` for monorepo, dependency, logging, export, and validation conventions.
- Use `ccusage-testing` for in-source Vitest and fixture patterns.
- Use `use-gunshi-cli` when changing commands.

## Package Notes

- Entry point: `src/index.ts`
- Data loading: `src/data-loader.ts`
- pi-agent transformation: `src/_pi-agent.ts`
- Commands: `src/commands/`
- Deprecated compatibility wrapper: `pi`

Prefer `ccusage pi ...` in examples, tests, docs, and new behavior. The package provides only the `.` export.
