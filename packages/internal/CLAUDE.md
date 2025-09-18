# CLAUDE.md - Internal Package

This package contains shared internal utilities for the ccusage monorepo.

## Package Overview

**Name**: `@ccusage/internal`
**Description**: Shared internal utilities for ccusage toolchain
**Type**: Internal library (private package)

## Important Notes

**CRITICAL**: This is an internal package that gets bundled into the final applications. Therefore:
- **Always add this package as a `devDependency`** in apps that use it, NOT as a regular dependency
- Apps in this monorepo (ccusage, mcp, codex) are bundled CLIs, so all their runtime dependencies should be in `devDependencies`
- The bundler will include the code from this package in the final output

## Available Exports

**Utilities:**
- `./pricing` - LiteLLM pricing fetcher and utilities
- `./pricing-fetch-utils` - Pricing fetch helper functions
- `./logger` - Logger factory using consola with LOG_LEVEL support
- `./format` - Number formatting utilities (formatTokens, formatCurrency)
- `./constants` - Shared constants (DEFAULT_LOCALE, MILLION)

## Development Commands

- `pnpm run test` - Run tests
- `pnpm run lint` - Lint code
- `pnpm run format` - Format and auto-fix code
- `pnpm typecheck` - Type check with TypeScript

## Adding New Utilities

When adding new shared utilities:

1. Create the utility file in `src/`
2. Add the export to `package.json` exports field
3. Import in consuming apps as `devDependencies`:
   ```json
   "devDependencies": {
     "@ccusage/internal": "workspace:*"
   }
   ```
4. Use the utility:
   ```typescript
   import { createLogger } from '@ccusage/internal/logger';
   ```

## Dependencies

This package has minimal runtime dependencies that get bundled:
- `@praha/byethrow` - Functional error handling
- `consola` - Logging
- `valibot` - Schema validation

## Code Style

Follow the same conventions as the main ccusage package:
- Use `.ts` extensions for local imports
- Prefer `@praha/byethrow Result` type over try-catch
- Only export what's actually used by other modules
- Use vitest in-source testing with `if (import.meta.vitest != null)` blocks