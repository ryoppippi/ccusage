# CLAUDE.md - Pi Package

This package provides usage tracking for pi-agent.

## Package Overview

**Name**: `@ccusage/pi`
**Description**: Pi-agent usage tracking
**Type**: CLI tool with TypeScript exports

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests using vitest
- `pnpm run lint` - Lint code using ESLint
- `pnpm run format` - Format and auto-fix code with ESLint
- `pnpm typecheck` - Type check with TypeScript

**Build and Release:**

- `pnpm run build` - Build distribution files with tsdown
- `pnpm run prerelease` - Full release workflow (lint + typecheck + build)

## Usage

```bash
# Show daily pi-agent usage
ccusage-pi daily

# Show monthly pi-agent usage
ccusage-pi monthly

# Show session-based pi-agent usage
ccusage-pi session

# JSON output
ccusage-pi daily --json

# Custom pi-agent path
ccusage-pi daily --pi-path /path/to/sessions
```

## Architecture

This package reads usage data from pi-agent only.

**Data Source:**

- **Pi-agent**: `~/.pi/agent/sessions/`

**Key Modules:**

- `src/index.ts` - CLI entry point with Gunshi-based command routing
- `src/data-loader.ts` - Loads and aggregates pi-agent JSONL data
- `src/_pi-agent.ts` - Pi-agent data parsing and transformation
- `src/commands/` - CLI subcommands (daily, monthly, session)

## Dependencies

**Key Runtime Dependencies:**

- `ccusage` - Main ccusage package (workspace dependency)
- `@ccusage/terminal` - Shared terminal utilities
- `gunshi` - CLI framework
- `valibot` - Schema validation
- `tinyglobby` - File globbing

**Key Dev Dependencies:**

- `vitest` - Testing framework
- `tsdown` - TypeScript build tool
- `eslint` - Linting and formatting
- `fs-fixture` - Test fixture creation

## Testing

- **In-Source Testing**: Uses the same testing pattern as the main package
- **Vitest Globals Enabled**: Use `describe`, `it`, `expect` directly without imports
- **Mock Data**: Uses `fs-fixture` for testing data loading functionality
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere

## Code Style

Follow the same code style guidelines as the main ccusage package:

- **Error Handling**: Prefer `@praha/byethrow Result` type over try-catch
- **Imports**: Use `.ts` extensions for local imports
- **Exports**: Only export what's actually used
- **Dependencies**: Add as `devDependencies` unless explicitly requested

**Post-Change Workflow:**
Always run these commands in parallel after code changes:

- `pnpm run format` - Auto-fix and format
- `pnpm typecheck` - Type checking
- `pnpm run test` - Run tests

## Environment Variables

| Variable       | Description                                   |
| -------------- | --------------------------------------------- |
| `PI_AGENT_DIR` | Custom path to pi-agent sessions directory    |
| `LOG_LEVEL`    | Adjust logging verbosity (0 silent … 5 trace) |

## Package Exports

The package provides the following exports:

- `.` - Main CLI entry point

## Binary

The package includes a binary `ccusage-pi` that can be used to run the CLI from the command line.
