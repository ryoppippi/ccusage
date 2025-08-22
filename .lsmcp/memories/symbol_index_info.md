---
created: 2025-08-10T20:53:29.066Z
updated: 2025-08-22T11:06:14.669Z
---

# Symbol Index Configuration for ccusage

## Project Setup
- **Language**: TypeScript
- **Pattern Used**: `src/**/*.ts` (automatically indexed by project overview)
- **Root Directory**: `/Users/ryoppippi/ghq/github.com/ryoppippi/ccusage`

## Index Statistics
- **Total Files**: 37
- **Total Symbols**: 226
- **Indexing Time**: 3s
- **Last Updated**: 2025-08-22T11:05:39.166Z

## Symbol Breakdown
- **Classes**: 61
- **Interfaces**: 0  
- **Functions**: 102
- **Methods**: 31
- **Properties**: 28

## Key Features Verified
✅ Symbol search by name (e.g., 'main' finds 2 functions)
✅ Symbol search by kind (e.g., 'Class' finds 61 classes)
✅ LSP integration working (definitions, references, hover)
✅ Project structure automatically detected

## Common Search Patterns
- Search by name: `search_symbols --name "functionName"`
- Search by type: `search_symbols --kind "Class"`
- Search in specific file: `search_symbols --file "src/commands/"`
- Get file symbols: `lsp_get_document_symbols --relativePath "src/index.ts"`

## Issues Encountered
None - indexing completed successfully on first attempt.

## Architecture Notes
This is a CLI tool for Claude Code usage analysis with clean TypeScript structure:
- Main entry: `src/index.ts`
- Commands: `src/commands/`
- Internal utilities: `src/_*.ts` (underscore prefix)
- Data types: `src/_types.ts`
- Configuration: TypeScript with strict mode enabled