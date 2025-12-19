# CLAUDE.md - OpenCode Package

This package provides usage analysis for OpenCode, following the same patterns as the codex package.

## Package Overview

**Name**: `@ccusage/opencode`
**Description**: Usage analysis tool for OpenCode sessions
**Type**: CLI tool (bundled)

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests with vitest
- `pnpm run lint` - Lint code using ESLint
- `pnpm run format` - Format and auto-fix code with ESLint
- `pnpm typecheck` - Type check with TypeScript

**Build and Release:**

- `pnpm run build` - Build distribution files with tsdown
- `pnpm run prerelease` - Full release workflow (lint + typecheck + build)

**Development Usage:**

- `pnpm run start daily` - Show daily usage report
- Add `--json` flag for JSON output format

## Architecture

This package mirrors the codex package structure:

**Key Modules:**

- `src/data-loader.ts` - Loads OpenCode message JSON files
- `src/commands/daily.ts` - Daily usage reports
- `src/commands/index.ts` - Command exports

**Data Flow:**

1. Loads JSON files from `~/.local/share/opencode/storage/message/`
2. Converts to common `LoadedUsageEntry` format
3. Aggregates by date
4. Outputs formatted tables or JSON

## Testing Guidelines

- **In-Source Testing**: Tests written in same files using `if (import.meta.vitest != null)` blocks
- **Vitest Globals Enabled**: Use `describe`, `it`, `expect` directly without imports
- **Mock Data**: Uses `fs-fixture` with `using` for test data
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere

## Code Style

- **Error Handling**: Skip malformed files silently, no Result type needed for simple cases
- **Imports**: Use workspace packages (`@ccusage/terminal`, `@ccusage/internal`)
- **Dependencies**: All runtime deps in `devDependencies` (bundled CLI)

## Environment Variables

- `OPENCODE_DATA_DIR` - Custom OpenCode data directory path (defaults to `~/.local/share/opencode`)

## Package Exports

Minimal exports for CLI usage - primarily the command interface through gunshi.
