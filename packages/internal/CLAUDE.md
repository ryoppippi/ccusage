# CLAUDE.md - Internal Package

This package contains shared internal utilities for the better-ccusage monorepo.

## Package Overview

**Name**: `@better-ccusage/internal`
**Description**: Shared internal utilities for better-ccusage toolchain
**Type**: Internal library (private package)

## Important Notes

**CRITICAL**: This is an internal package that gets bundled into the final applications. Therefore:

- **Always add this package as a `devDependency`** in apps that use it, NOT as a regular dependency
- Apps in this monorepo (better-ccusage, mcp, codex) are bundled CLIs, so all their runtime dependencies should be in `devDependencies`
- The bundler will include the code from this package in the final output

## Available Exports

**Utilities:**

- `./pricing` - Pricing fetcher and utilities
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
   <!-- eslint-skip -->
   ```json
   "devDependencies": {
     "@better-ccusage/internal": "workspace:*"
   }
   ```
4. Use the utility:
   ```typescript
   import { createLogger } from '@better-ccusage/internal/logger';
   ```

## Dependencies

This package has minimal runtime dependencies that get bundled:

- `@praha/byethrow` - Functional error handling
- `consola` - Logging
- `valibot` - Schema validation

## Pricing Implementation Notes

### Tiered Pricing Support

The pricing data supports tiered pricing for large context window models. Not all models use tiered pricing:

**Models WITH tiered pricing:**

- **Claude/Anthropic models**: 200k token threshold
  - Fields: `input_cost_per_token_above_200k_tokens`, `output_cost_per_token_above_200k_tokens`
  - Cache fields: `cache_creation_input_token_cost_above_200k_tokens`, `cache_read_input_token_cost_above_200k_tokens`
  - ✅ Currently implemented in cost calculation logic

- **Gemini models**: 128k token threshold
  - Fields: `input_cost_per_token_above_128k_tokens`, `output_cost_per_token_above_128k_tokens`
  - ⚠️ Schema supports these fields but calculation logic NOT implemented
  - Would require different threshold handling if Gemini support is added

**Models WITHOUT tiered pricing:**

- **GPT/OpenAI models**: Flat rate pricing (no token-based tiers)
  - Note: OpenAI has "tier levels" but these are for API rate limits, not pricing

### ⚠️ IMPORTANT for Future Development

When adding support for new models:

1. **Check if the model has tiered pricing** in the pricing schema
2. **Verify the threshold value** (200k for Claude, 128k for Gemini, etc.)
3. **Update calculation logic** if threshold differs from currently implemented 200k
4. **Add comprehensive tests** for boundary conditions at the threshold
5. **Document the pricing structure** in relevant CLAUDE.md files
6. **If cache-specific rates are missing**, fall back to the corresponding input rates (base and above-threshold) to avoid under-charging cached tokens

The current implementation in `pricing.ts` only handles 200k threshold. Adding models with different thresholds would require refactoring the `calculateTieredCost` helper function.

## Code Style

Follow the same conventions as the main better-ccusage package:

- Use `.ts` extensions for local imports
- Prefer `@praha/byethrow Result` type over try-catch
- Only export what's actually used by other modules
- Use vitest in-source testing with `if (import.meta.vitest != null)` blocks
