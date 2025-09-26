# CLAUDE.md - better-ccusage Package

This is the main better-ccusage CLI package that provides usage analysis for Claude Code.

## Package Overview

**Name**: `better-ccusage`
**Description**: Usage analysis tool for Claude Code
**Type**: CLI tool and library with TypeScript exports

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests (using vitest via pnpm, watch mode disabled)
- `pnpm run lint` - Lint code using ESLint
- `pnpm run format` - Format and auto-fix code with ESLint
- `pnpm typecheck` - Type check with TypeScript

**Build and Release:**

- `pnpm run build` - Build distribution files with tsdown (includes schema generation)
- `pnpm run generate:schema` - Generate JSON schema for configuration
- `pnpm run prerelease` - Full release workflow (lint + typecheck + build)

**Development Usage:**

- `pnpm run start daily` - Show daily usage report
- `pnpm run start monthly` - Show monthly usage report
- `pnpm run start session` - Show session-based usage report
- `pnpm run start blocks` - Show 5-hour billing blocks usage report
- `pnpm run start statusline` - Show compact status line (Beta)
- Add `--json` flag for JSON output format
- Add `--mode <mode>` for cost calculation control (auto/calculate/display)
- Add `--active` flag for blocks to show only active block with projections
- Add `--recent` flag for blocks to show last 3 days including active

**CLI Testing:**

- `pnpm run test:statusline` - Test statusline with default test data
- `pnpm run test:statusline:all` - Test statusline with all model variants
- `pnpm run test:statusline:sonnet4` - Test with Sonnet 4 data
- `pnpm run test:statusline:opus4` - Test with Opus 4 data
- `pnpm run test:statusline:sonnet41` - Test with Sonnet 4.1 data

## Architecture

This package contains the core better-ccusage functionality:

**Key Modules:**

- `src/index.ts` - CLI entry point with Gunshi-based command routing
- `src/data-loader.ts` - Parses JSONL files from Claude data directories
- `src/calculate-cost.ts` - Token aggregation and cost calculation utilities
- `src/commands/` - CLI subcommands (daily, monthly, session, blocks, statusline)
- `src/logger.ts` - Logging utilities (use instead of console.log)

**Data Flow:**

1. Loads JSONL files from `~/.claude/projects/` and `~/.config/claude/projects/`
2. Aggregates usage data by time periods or sessions
3. Calculates costs using local pricing database
4. Outputs formatted tables or JSON

## Testing Guidelines

- **In-Source Testing**: Tests are written in the same files using `if (import.meta.vitest != null)` blocks
- **Vitest Globals Enabled**: Use `describe`, `it`, `expect` directly without imports
- **Model Testing**: Use current Claude 4 models (sonnet-4, opus-4) in tests
- **Mock Data**: Uses `fs-fixture` with `createFixture()` for Claude data simulation
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks

## Code Style

- **Error Handling**: Prefer `@praha/byethrow Result` type over try-catch for functional error handling
- **Imports**: Use `.ts` extensions for local imports (e.g., `import { foo } from './utils.ts'`)
- **Exports**: Only export what's actually used by other modules
- **Dependencies**: Add as `devDependencies` unless explicitly requested otherwise
- **No console.log**: Use `logger.ts` instead

**Post-Change Workflow:**
Always run these commands in parallel after code changes:

- `pnpm run format` - Auto-fix and format
- `pnpm typecheck` - Type checking
- `pnpm run test` - Run tests

## Environment Variables

- `LOG_LEVEL` - Control logging verbosity (0=silent, 1=warn, 2=log, 3=info, 4=debug, 5=trace)
- `CLAUDE_CONFIG_DIR` - Custom Claude data directory paths (supports multiple comma-separated paths)

## Dependencies

Because `better-ccusage` is distributed as a bundled CLI, keep all runtime libraries in `devDependencies` so the bundler captures them.

**Key Runtime Dependencies:**

- `gunshi` - CLI framework
- `cli-table3` - Table formatting
- `valibot` - Schema validation
- `@praha/byethrow` - Functional error handling

**Key Dev Dependencies:**

- `vitest` - Testing framework
- `tsdown` - TypeScript build tool
- `eslint` - Linting and formatting
- `fs-fixture` - Test fixture creation

## Package Exports

The package provides multiple exports for library usage:

- `.` - Main CLI entry point
- `./calculate-cost` - Cost calculation utilities
- `./data-loader` - Data loading functions
- `./debug` - Debug utilities
- `./logger` - Logging utilities
- `./pricing-fetcher` - Pricing data integration
