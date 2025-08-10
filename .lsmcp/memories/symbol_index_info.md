---
created: 2025-08-10T20:53:29.066Z
updated: 2025-08-10T20:53:29.066Z
---

# ccusage Symbol Index Configuration

## Project Information

- **Language**: TypeScript
- **Root Directory**: /Users/ryoppippi/ghq/github.com/ryoppippi/ccusage
- **Indexing Date**: 2025-08-10

## Index Configuration

- **Pattern Used**: `**/*.ts`
- **Files Indexed**: 32
- **Total Symbols**: 197
- **Average Indexing Time**: 243ms per file

## Project Structure

- Main source code: `src/` directory
- Test files: `test/` directory
- Documentation: `docs/` directory
- Configuration files: Root directory (tsconfig.json, vitest.config.ts, etc.)

## Key Observations

- Project is a CLI tool for analyzing Claude Code usage
- Uses TypeScript with strict mode
- Built with gunshi CLI framework
- Has MCP server integration
- Includes comprehensive test coverage with in-source testing

## Symbol Search Examples

- Search by name: `search_symbol_from_index { "name": "main", "root": "/Users/ryoppippi/ghq/github.com/ryoppippi/ccusage" }`
- Search by kind: `search_symbol_from_index { "kind": "Function", "root": "/Users/ryoppippi/ghq/github.com/ryoppippi/ccusage" }`
- Get file symbols: `get_document_symbols { "filePath": "src/data-loader.ts", "root": "/Users/ryoppippi/ghq/github.com/ryoppippi/ccusage" }`

## Notes

- LSP server successfully recognizes TypeScript files
- Index updates automatically with file changes
- Use incremental updates for better performance on subsequent runs
