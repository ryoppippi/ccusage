# CLAUDE.md - Internal Package

This package provides shared internal utilities for the ccusage toolchain.

## Package Overview

**Name**: `@ccusage/internal`
**Description**: Shared internal utilities for ccusage toolchain
**Type**: Internal library package (private)

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests using vitest
- `pnpm run lint` - Lint code using ESLint
- `pnpm run format` - Format and auto-fix code with ESLint
- `pnpm typecheck` - Type check with TypeScript

## Architecture

This package contains shared internal utilities used across the ccusage monorepo:

**Key Modules:**

- `src/pricing.ts` - Pricing data and model definitions
- `src/pricing-fetch-utils.ts` - Utilities for fetching pricing data from LiteLLM

**Exports:**

- `./pricing` - Pricing data and model definitions
- `./pricing-fetch-utils` - Pricing fetch utilities

## Dependencies

**Runtime Dependencies:**

- `@praha/byethrow` - Functional error handling
- `valibot` - Schema validation

**Dev Dependencies:**

- `vitest` - Testing framework
- `eslint` - Linting and formatting
- `fs-fixture` - Test fixture creation

## Testing Guidelines

- **In-Source Testing**: Tests are written in the same files using `if (import.meta.vitest != null)` blocks
- **Vitest Globals Enabled**: Use `describe`, `it`, `expect` directly without imports
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks

## Code Style

Follow the same code style guidelines as the main ccusage package:

- **Error Handling**: Prefer `@praha/byethrow Result` type over try-catch
- **Imports**: Use `.ts` extensions for local imports
- **Exports**: Only export what's actually used
- **No console.log**: Use proper logging utilities

**Post-Change Workflow:**
Always run these commands in parallel after code changes:

- `pnpm run format` - Auto-fix and format
- `pnpm typecheck` - Type checking
- `pnpm run test` - Run tests

## Important Notes

This is a private internal package and should not be published to npm. It exists solely to share code between other packages in the monorepo.
