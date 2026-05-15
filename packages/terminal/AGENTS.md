# CLAUDE.md - Terminal Package

This package provides terminal utilities for the ccusage toolchain.

## Package Overview

**Name**: `@ccusage/terminal`
**Description**: Terminal utilities for ccusage
**Type**: Internal library package (private)

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests using vitest
- `pnpm run lint` - Lint code using ESLint
- `pnpm run format` - Format and auto-fix code with ESLint
- `pnpm typecheck` - Type check with TypeScript

## Architecture

This package contains terminal utilities used across the ccusage monorepo:

**Key Modules:**

- `src/table.ts` - Table formatting and rendering utilities
- `src/utils.ts` - General terminal utilities

**Exports:**

- `./table` - Table formatting utilities
- `./utils` - Terminal utility functions

## Dependencies

**Runtime Dependencies:**

- `@oxc-project/runtime` - Runtime utilities
- `ansi-escapes` - ANSI escape sequences for terminal manipulation
- `cli-table3` - Table formatting for terminal output
- `es-toolkit` - Modern JavaScript utility library
- `picocolors` - Terminal color support
- `string-width` - Get the visual width of strings

**Dev Dependencies:**

- `vitest` - Testing framework
- `eslint` - Linting and formatting

## Testing Guidelines

- **In-Source Testing**: Tests are written in the same files using `if (import.meta.vitest != null)` blocks
- **Vitest Globals Enabled**: Use `describe`, `it`, `expect` directly without imports
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks

## Code Style

Follow the same code style guidelines as the main ccusage package:

- **Error Handling**: Prefer functional error handling patterns
- **Imports**: Use `.ts` extensions for local imports
- **Exports**: Only export what's actually used
- **No console.log**: Terminal output should be handled through proper utilities

**Post-Change Workflow:**
Always run these commands in parallel after code changes:

- `pnpm run format` - Auto-fix and format
- `pnpm typecheck` - Type checking
- `pnpm run test` - Run tests

## Important Notes

This is a private internal package and should not be published to npm. It exists solely to provide terminal utilities for other packages in the monorepo.
