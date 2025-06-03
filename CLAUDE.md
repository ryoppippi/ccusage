# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Testing and Quality:**
- `bun test` - Run all tests
- `bun run lint` - Lint code with Biome
- `bun run format` - Format code with Biome (writes changes)
- `bun typecheck` - Type check with TypeScript

**Build and Release:**
- `bun run build` - Build distribution files with tsdown
- `bun run release` - Full release workflow (lint + typecheck + test + build + version bump)

**Development Usage:**
- `bun run report daily` - Show daily usage report
- `bun run report session` - Show session-based usage report
- `bun run report daily --json` - Show daily usage report in JSON format
- `bun run report session --json` - Show session usage report in JSON format
- `bun run report daily --mode <mode>` - Control cost calculation mode (auto/calculate/display)
- `bun run report session --mode <mode>` - Control cost calculation mode (auto/calculate/display)
- `bun run index.ts` - Direct execution for development

**Cost Calculation Modes:**
- `auto` (default) - Use pre-calculated costUSD when available, otherwise calculate from tokens
- `calculate` - Always calculate costs from token counts using model pricing, ignore costUSD
- `display` - Always use pre-calculated costUSD values, show 0 for missing costs

## Architecture Overview

This is a CLI tool that analyzes Claude Code usage data from local JSONL files stored in `~/.claude/projects/`. The architecture follows a clear separation of concerns:

**Core Data Flow:**
1. **Data Loading** (`data-loader.ts`) - Parses JSONL files from Claude's local storage, including pre-calculated costs
2. **Token Aggregation** (`calculate-cost.ts`) - Utility functions for aggregating token counts and costs
3. **Command Execution** (`commands/`) - CLI subcommands that orchestrate data loading and presentation
4. **CLI Entry** (`index.ts`) - Gunshi-based CLI setup with subcommand routing

**Output Formats:**
- Table format (default): Pretty-printed tables with colors for terminal display
- JSON format (`--json`): Structured JSON output for programmatic consumption

**Key Data Structures:**
- Raw usage data is parsed from JSONL with timestamp, token counts, and pre-calculated costs
- Data is aggregated into either daily summaries or session summaries
- Sessions are identified by directory structure: `projects/{project}/{session}/{file}.jsonl`

**External Dependencies:**
- Uses local timezone for date formatting
- CLI built with `gunshi` framework, tables with `cli-table3`

## Code Style Notes

- Uses Biome for formatting with tab indentation and double quotes
- TypeScript with strict mode and bundler module resolution
- No console.log allowed except where explicitly disabled with biome-ignore
- Error handling: silently skips malformed JSONL lines during parsing
- File paths always use Node.js path utilities for cross-platform compatibility

# Tips for Claude Code
- [gunshi](https://gunshi.dev/llms-full.txt)
- do not use console.log. use logger.ts instead

# important-instruction-reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
Dependencies should always be added as devDependencies unless explicitly requested otherwise.
