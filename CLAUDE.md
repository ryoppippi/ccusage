# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

**Testing and Quality:**
- `bun test` - Run all tests
- `bun run lint` - Lint code with Biome
- `bun run format` - Format code with Biome (writes changes)
- `bun typecheck` - Type check with TypeScript (note: script name has typo "typecheek")

**Build and Release:**
- `bun run build` - Build distribution files with tsdown
- `bun run release` - Full release workflow (lint + typecheck + test + build + version bump)

**Development Usage:**
- `bun run report daily` - Show daily usage report
- `bun run report session` - Show session-based usage report
- `bun run report daily --json` - Show daily usage report in JSON format
- `bun run report session --json` - Show session usage report in JSON format
- `bun run index.ts` - Direct execution for development

## Architecture Overview

This is a CLI tool that analyzes Claude Code usage data from local JSONL files stored in `~/.claude/projects/`. The architecture follows a clear separation of concerns:

**Core Data Flow:**
1. **Data Loading** (`data-loader.ts`) - Parses JSONL files from Claude's local storage
2. **Cost Calculation** (`cost-calculator.ts`) - Handles token-to-cost conversions using LiteLLM pricing data
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
- Uses LiteLLM model pricing data for cost calculations (JSON format in `model_prices.json`)
- Supports JST timezone conversion for date formatting
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
