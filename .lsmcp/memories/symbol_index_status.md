---
created: 2025-08-15T10:09:44.271Z
updated: 2025-08-15T11:07:13.578Z
---

Symbol Index Onboarding Complete - ccusage Project

Project: /Users/ryoppippi/ghq/github.com/ryoppippi/ccusage
Language: TypeScript/JavaScript
Pattern Used: \*_/_.{ts,tsx,js,jsx} (automatic detection)

INDEX STATISTICS:

- Total files indexed: 34
- Total symbols: 209
- Indexing time: 1.44 seconds
- Average time per file: 41ms

KEY SYMBOLS FOUND:

- 87 Functions (including main, formatRemainingTime, calculateCost, etc.)
- Core command handlers in src/commands/
- Utility functions in src/\_\*.ts files
- Type definitions and schemas

RECENT ADDITIONS (Feature: Dynamic Context Limits):

- `getModelContextLimit` method in PricingFetcher class
- Enhanced `calculateContextTokens` function with model-specific limits
- Updated statusline command to support dynamic context calculations
- Added context limit fields to modelPricingSchema (max_tokens, max_input_tokens, max_output_tokens)
- Comprehensive test coverage for new functionality
- Test fixtures for Claude 4 model variants (Sonnet 4, Opus 4.1, Sonnet 4.1)

STATUS: ✅ Fully operational

- Symbol search working correctly
- Fast lookup capabilities enabled
- Ready for advanced code navigation
- Latest dynamic context limit functionality indexed

RECOMMENDED USAGE:

- Use search_symbol_from_index for fast symbol lookup
- Use get_definitions to navigate to symbol definitions
- Use find_references to trace symbol usage
- Leverage kind filtering (Function, Class, Interface, etc.)

TESTING COMMANDS:

- `bun run test:statusline:sonnet4` - Test with Claude 4 Sonnet
- `bun run test:statusline:opus4` - Test with Claude 4.1 Opus
- `bun run test:statusline:sonnet41` - Test with Claude 4.1 Sonnet
- `bun run test:statusline:all` - Run all model tests

Last updated: 2025-08-15 (Dynamic Context Limits feature)
