# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Monorepo Structure

This is a monorepo containing multiple packages. For package-specific guidance, refer to the individual CLAUDE.md files:

- **Main CLI Package**: @apps/better-ccusage/CLAUDE.md - Core better-ccusage CLI tool and library
- **MCP Server Package**: @apps/mcp/CLAUDE.md - MCP server implementation for better-ccusage data
- **Documentation**: @docs/CLAUDE.md - VitePress-based documentation website

## About better-ccusage

better-ccusage is a fork of the original ccusage project that addresses a critical limitation: while ccusage focuses exclusively on Claude Code usage with Anthropic models, better-ccusage extends support to external providers that use Claude Code with different models like Zai and GLM-4.5.

### Why the Fork?

The original ccusage project is designed specifically for Anthropic's Claude Code and doesn't account for:

- **Zai** providers that use Claude Code infrastructure with their own models
- **GLM-4.5** models from other AI providers
- Multi-provider environments where organizations use different AI services through Claude Code

better-ccusage maintains full compatibility with ccusage while adding comprehensive support for these additional providers and models.

### Key Differences

| Feature | Original ccusage | better-ccusage |
|---------|-----------------|----------------|
| Anthropic Models | ✅ | ✅ |
| Zai Provider | ❌ | ✅ |
| GLM-4.5 Models | ❌ | ✅ |
| Multi-Provider Support | ❌ | ✅ |
| Provider Detection | ❌ | ✅ |
| Cost Calculation by Provider | ❌ | ✅ |
| Original ccusage Features | ✅ | ✅ |

Each package has its own development commands, dependencies, and specific guidelines. Always check the relevant package's CLAUDE.md when working within that package directory.

### Apps Are Bundled

All projects under `apps/` ship as bundled CLIs/binaries. Treat their runtime dependencies as bundled assets: list everything in each app's `devDependencies` (never `dependencies`) so the bundler owns the runtime payload.

## Guide for lsmcp mcp

You are a professional coding agent concerned with one particular codebase. You have
access to semantic coding tools on which you rely heavily for all your work, as well as collection of memory
files containing general information about the codebase. You operate in a frugal and intelligent manner, always
keeping in mind to not read or generate content that is not needed for the task at hand.

When reading code in order to answer a user question or task, you should try reading only the necessary code.
Some tasks may require you to understand the architecture of large parts of the codebase, while for others,
it may be enough to read a small set of symbols or a single file.
Generally, you should avoid reading entire files unless it is absolutely necessary, instead relying on
intelligent step-by-step acquisition of information. Use the symbol indexing tools to efficiently navigate the codebase.

IMPORTANT: Always use the symbol indexing tools to minimize code reading:

- Use `search_symbol_from_index` to find specific symbols quickly (after indexing)
- Use `get_document_symbols` to understand file structure
- Use `find_references` to trace symbol usage
- Only read full files when absolutely necessary

You can achieve intelligent code reading by:

1. Using `index_files` to build symbol index for fast searching
2. Using `search_symbol_from_index` with filters (name, kind, file, container) to find symbols
3. Using `get_document_symbols` to understand file structure
4. Using `get_definitions`, `find_references` to trace relationships
5. Using standard file operations when needed

## Working with Symbols

Symbols are identified by their name, kind, file location, and container. Use these tools:

- `index_files` - Build symbol index for files matching pattern (e.g., '\*_/_.ts')
- `search_symbol_from_index` - Fast search by name, kind (Class, Function, etc.), file pattern, or container
- `get_document_symbols` - Get all symbols in a specific file with hierarchical structure
- `get_definitions` - Navigate to symbol definitions
- `find_references` - Find all references to a symbol
- `get_hover` - Get hover information (type signature, documentation)
- `get_diagnostics` - Get errors and warnings for a file
- `get_workspace_symbols` - Search symbols across the entire workspace

Always prefer indexed searches (tools with `_from_index` suffix) over reading entire files.

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests (using vitest via pnpm, watch mode disabled)
- Lint code using ESLint MCP server (available via Claude Code tools)
- `pnpm run format` - Format code with ESLint (writes changes)
- `pnpm typecheck` - Type check with TypeScript

**Build and Release:**

- `pnpm run build` - Build distribution files with tsdown
- `pnpm run release` - Full release workflow (lint + typecheck + test + build + version bump)

**Development Usage:**

- `pnpm run start daily` - Show daily usage report
- `pnpm run start monthly` - Show monthly usage report
- `pnpm run start session` - Show session-based usage report
- `pnpm run start blocks` - Show 5-hour billing blocks usage report
- `pnpm run start statusline` - Show compact status line (Beta)
- `pnpm run start daily --json` - Show daily usage report in JSON format
- `pnpm run start monthly --json` - Show monthly usage report in JSON format
- `pnpm run start session --json` - Show session usage report in JSON format
- `pnpm run start blocks --json` - Show blocks usage report in JSON format
- `pnpm run start daily --mode <mode>` - Control cost calculation mode (auto/calculate/display)
- `pnpm run start monthly --mode <mode>` - Control cost calculation mode (auto/calculate/display)
- `pnpm run start session --mode <mode>` - Control cost calculation mode (auto/calculate/display)
- `pnpm run start blocks --mode <mode>` - Control cost calculation mode (auto/calculate/display)
- `pnpm run start blocks --active` - Show only active block with projections
- `pnpm run start blocks --recent` - Show blocks from last 3 days (including active)
- `pnpm run start blocks --token-limit <limit>` - Token limit for quota warnings (number or "max")
- `node ./src/index.ts` - Direct execution for development

**MCP Server Usage:** (now provided by the `@better-ccusage/mcp` package)

- `pnpm dlx @better-ccusage/mcp@latest -- --help` - Show available options
- `pnpm dlx @better-ccusage/mcp@latest -- --type http --port 8080` - Start HTTP transport

**Cost Calculation Modes:**

- `auto` (default) - Use pre-calculated costUSD when available, otherwise calculate from tokens
- `calculate` - Always calculate costs from token counts using model pricing, ignore costUSD
- `display` - Always use pre-calculated costUSD values, show 0 for missing costs

**Environment Variables:**

- `LOG_LEVEL` - Control logging verbosity (0=silent, 1=warn, 2=log, 3=info, 4=debug, 5=trace)
  - Example: `LOG_LEVEL=0 pnpm run start daily` for silent output
  - Useful for debugging or suppressing non-critical output

**Multiple Claude Data Directories:**

This tool supports multiple Claude data directories to handle different Claude Code installations:

- **Default Behavior**: Automatically searches both `~/.config/claude/projects/` (new default) and `~/.claude/projects/` (old default)
- **Environment Variable**: Set `CLAUDE_CONFIG_DIR` to specify custom path(s)
  - Single path: `export CLAUDE_CONFIG_DIR="/path/to/claude"`
  - Multiple paths: `export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"`
- **Data Aggregation**: Usage data from all valid directories is automatically combined
- **Backward Compatibility**: Existing configurations continue to work without changes

This addresses the breaking change in Claude Code where logs moved from `~/.claude` to `~/.config/claude`.

## Architecture Overview

This is a CLI tool that analyzes Claude Code usage data from local JSONL files stored in Claude data directories (supports both `~/.claude/projects/` and `~/.config/claude/projects/`). The architecture follows a clear separation of concerns:

**Core Data Flow:**

1. **Data Loading** (`data-loader.ts`) - Parses JSONL files from multiple Claude data directories, including pre-calculated costs
2. **Token Aggregation** (`calculate-cost.ts`) - Utility functions for aggregating token counts and costs
3. **Command Execution** (`commands/`) - CLI subcommands that orchestrate data loading and presentation
4. **CLI Entry** (`index.ts`) - Gunshi-based CLI setup with subcommand routing

**Output Formats:**

- Table format (default): Pretty-printed tables with colors for terminal display
- JSON format (`--json`): Structured JSON output for programmatic consumption

**Key Data Structures:**

- Raw usage data is parsed from JSONL with timestamp, token counts, and pre-calculated costs
- Data is aggregated into daily summaries, monthly summaries, session summaries, or 5-hour billing blocks
- **Important Note on Naming**: The term "session" in this codebase has two different meanings:
  1. **Session Reports** (`pnpm run start session`): Groups usage by project directories. What we call "sessionId" in these reports is actually derived from the directory structure (project/directory)
  2. **True Session ID**: The actual Claude Code session ID found in the `sessionId` field within JSONL entries and used as the filename ({sessionId}.jsonl)
- File structure: `projects/{project}/{sessionId}.jsonl` where:
  - `{project}` is the project directory name (used for grouping)
  - `{sessionId}.jsonl` is the JSONL file named with the actual session ID from Claude Code
  - Each JSONL file contains all usage entries for a single Claude Code session
  - The sessionId in the filename matches the `sessionId` field inside the JSONL entries
- 5-hour blocks group usage data by Claude's billing cycles with active block tracking

**External Dependencies:**

- Uses local timezone for date formatting
- CLI built with `gunshi` framework, tables with `cli-table3`
- **LiteLLM Integration**: Cost calculations depend on LiteLLM's pricing database for model pricing data

**MCP Integration:**

- **Built-in MCP Server**: Exposes usage data through MCP protocol with tools:
  - `daily` - Daily usage reports
  - `session` - Session-based usage reports
  - `monthly` - Monthly usage reports
  - `blocks` - 5-hour billing blocks usage reports
- **External MCP Servers Available:**
  - **ESLint MCP**: Lint TypeScript/JavaScript files directly through Claude Code tools
  - **Context7 MCP**: Look up documentation for libraries and frameworks
  - **Gunshi MCP**: Access gunshi.dev documentation and examples
  - **Byethrow MCP**: Access @praha/byethrow documentation and examples for functional error handling
  - **TypeScript MCP (lsmcp)**: Search for TypeScript functions, types, and symbols across the codebase

## Git Commit and PR Conventions

**Commit Message Format:**

Follow the Conventional Commits specification with package/area prefixes:

```
<type>(<scope>): <subject>
```

**Scope Naming Rules:**

- **Apps**: Use the app directory name
  - `feat(better-ccusage):` - Changes to apps/better-ccusage
  - `fix(mcp):` - Fixes in apps/mcp
  - `feat(codex):` - Features for apps/codex (if exists)
  - `feat(better-ccusage):` - Changes to better-ccusage core functionality

- **Packages**: Use the package directory name
  - `feat(terminal):` - Changes to packages/terminal
  - `fix(ui):` - Fixes in packages/ui
  - `refactor(core):` - Refactoring packages/core

- **Documentation**: Use `docs` scope
  - `docs:` or `docs(guide):` - Documentation updates
  - `docs(api):` - API documentation changes

- **Root-level changes**: No scope (preferred) or use `root`
  - `chore:` - Root config updates
  - `ci:` - CI/CD changes
  - `feat:` - Root-level features
  - `docs:` - Root documentation updates
  - `build:` or `build(root):` - Root build system changes

**Type Prefixes:**

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation only changes
- `style:` - Code style changes (formatting, missing semi-colons, etc)
- `refactor:` - Code change that neither fixes a bug nor adds a feature
- `perf:` - Performance improvements
- `test:` - Adding missing tests or correcting existing tests
- `chore:` - Changes to the build process or auxiliary tools
- `ci:` - CI/CD configuration changes
- `revert:` - Reverting a previous commit

**Examples:**

```
feat(better-ccusage): add support for GLM-4.5 models
fix(mcp): resolve connection timeout issues
docs(guide): update installation instructions
refactor(better-ccusage): extract cost calculation to separate module
feat(better-better-ccusage): add Zai provider integration
test(mcp): add integration tests for HTTP transport
chore: update dependencies
```

**PR Title Convention:**

PR titles should follow the same format as commit messages. When a PR contains multiple commits, the title should describe the main change:

```
feat(better-ccusage): implement session-based usage reports
fix(mcp): handle edge cases in data aggregation
docs: comprehensive API documentation update
```

## Code Style Notes

- Uses ESLint for linting and formatting with tab indentation and double quotes
- TypeScript with strict mode and bundler module resolution
- No console.log allowed except where explicitly disabled with eslint-disable
- Error handling: silently skips malformed JSONL lines during parsing
- File paths always use Node.js path utilities for cross-platform compatibility
- **Import conventions**: Use `.ts` extensions for local file imports (e.g., `import { foo } from './utils.ts'`)

**Error Handling:**

- **Prefer @praha/byethrow Result type** over traditional try-catch for functional error handling
  - Documentation: Available via byethrow MCP server
- Use `Result.try()` for wrapping operations that may throw (JSON parsing, etc.)
- Use `Result.isFailure()` for checking errors (more readable than `!Result.isSuccess()`)
- Use early return pattern (`if (Result.isFailure(result)) continue;`) instead of ternary operators
- For async operations: create wrapper function with `Result.try()` then call it
- Keep traditional try-catch only for: file I/O with complex error handling, legacy code that's hard to refactor
- Always use `Result.isFailure()` and `Result.isSuccess()` type guards for better code clarity

**Naming Conventions:**

- Variables: start with lowercase (camelCase) - e.g., `usageDataSchema`, `modelBreakdownSchema`
- Types: start with uppercase (PascalCase) - e.g., `UsageData`, `ModelBreakdown`
- Constants: can use UPPER_SNAKE_CASE - e.g., `DEFAULT_CLAUDE_CODE_PATH`
- Internal files: use underscore prefix - e.g., `_types.ts`, `_utils.ts`, `_consts.ts`

**Export Rules:**

- **IMPORTANT**: Only export constants, functions, and types that are actually used by other modules
- Internal/private constants that are only used within the same file should NOT be exported
- Always check if a constant is used elsewhere before making it `export const` vs just `const`
- This follows the principle of minimizing the public API surface area
- Dependencies should always be added as `devDependencies` unless explicitly requested otherwise

**Post-Code Change Workflow:**

After making any code changes, ALWAYS run these commands in parallel:

- `pnpm run format` - Auto-fix and format code with ESLint (includes linting)
- `pnpm typecheck` - Type check with TypeScript
- `pnpm run test` - Run all tests

This ensures code quality and catches issues immediately after changes.

## Documentation Guidelines

**Screenshot Usage:**

- **Placement**: Always place screenshots immediately after the main heading (H1) in documentation pages
- **Purpose**: Provide immediate visual context to users before textual explanations
- **Guides with Screenshots**:
  - `/docs/guide/index.md` (What is better-ccusage) - Main usage screenshot
  - `/docs/guide/daily-reports.md` - Daily report output screenshot
  - `/docs/guide/live-monitoring.md` - Live monitoring dashboard screenshot
  - `/docs/guide/mcp-server.md` - Claude Desktop integration screenshot
- **Image Path**: Use relative paths like `/screenshot.png` for images stored in `/docs/public/`
- **Alt Text**: Always include descriptive alt text for accessibility

## Claude Models and Testing

**Supported Claude 4 Models (as of 2025):**

- `claude-sonnet-4-20250514` - Latest Claude 4 Sonnet model
- `claude-opus-4-20250514` - Latest Claude 4 Opus model

**Model Naming Convention:**

- Pattern: `claude-{model-type}-{generation}-{date}`
- Example: `claude-sonnet-4-20250514` (NOT `claude-4-sonnet-20250514`)
- The generation number comes AFTER the model type

**Testing Guidelines:**

- **In-Source Testing Pattern**: This project uses in-source testing with `if (import.meta.vitest != null)` blocks
- Tests are written directly in the same files as the source code, not in separate test files
- Vitest globals (`describe`, `it`, `expect`) are available automatically without imports
- **IMPORTANT**: DO NOT use `await import()` dynamic imports anywhere in the codebase - this causes tree-shaking issues and should be avoided entirely
- **ESPECIALLY**: Never use dynamic imports in vitest test blocks - this is particularly problematic for test execution
- **Vitest globals are enabled**: Use `describe`, `it`, `expect` directly without any imports since globals are configured
- Mock data is created using `fs-fixture` with `createFixture()` for Claude data directory simulation
- All test files must use current Claude 4 models, not outdated Claude 3 models
- Test coverage should include both Sonnet and Opus models for comprehensive validation
- Model names in tests must exactly match LiteLLM's pricing database entries
- When adding new model tests, verify the model exists in LiteLLM before implementation
- Tests depend on real pricing data from LiteLLM - failures may indicate model availability issues

**LiteLLM Integration Notes:**

- Cost calculations require exact model name matches with LiteLLM's database
- Test failures often indicate model names don't exist in LiteLLM's pricing data
- Future model updates require checking LiteLLM compatibility first
- The application cannot calculate costs for models not supported by LiteLLM

# Tips for Claude Code

- [gunshi](https://gunshi.dev/llms.txt) - Documentation available via Gunshi MCP server
- Context7 MCP server available for library documentation lookup
- do not use console.log. use logger.ts instead
- **IMPORTANT**: When searching for TypeScript functions, types, or symbols in the codebase, ALWAYS use TypeScript MCP (lsmcp) tools like `get_definitions`, `find_references`, `get_hover`, etc. DO NOT use grep/rg for searching TypeScript code structures.
- **CRITICAL VITEST REMINDER**: Vitest globals are enabled - use `describe`, `it`, `expect` directly WITHOUT imports. NEVER use `await import()` dynamic imports anywhere, especially in test blocks.

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.
Dependencies should always be added as devDependencies unless explicitly requested otherwise.
