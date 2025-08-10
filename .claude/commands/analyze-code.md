# Code Analysis with LSMCP MCP

This command uses the LSMCP (Language Server MCP) tools to perform rapid semantic code analysis, leveraging language server capabilities for more accurate results than traditional grep/search approaches.

## Overview

LSMCP provides semantic code analysis through language server protocol, enabling:

- Type-aware error detection
- Symbol reference tracking
- Cross-file dependency analysis
- Real-time diagnostics

## Command Template

```markdown
# Rapid Code Analysis Task

Project Root: <PROJECT_PATH>
Target Language: <LANGUAGE>
Analysis Goal: <SPECIFIC_GOAL>

Execute the following analysis phases:

## Phase 1: Capability Check (5 seconds)

Verify available LSP features:
```

mcp**lsmcp-<ADAPTER>**check_capabilities

```

## Phase 2: Project-wide Diagnostics (10 seconds)
Collect all errors and warnings:
```

mcp**lsmcp-<ADAPTER>**get_all_diagnostics

- root: "<PROJECT_PATH>"
- pattern: "\*_/_.<FILE_EXTENSION>"
- severityFilter: "error" # Start with errors only
- useGitignore: true

```

If few errors found, repeat with severityFilter: "warning"

## Phase 3: Symbol Analysis (5 seconds per symbol)
For critical functions/classes:
```

mcp**lsmcp-<ADAPTER>**find_references

- root: "<PROJECT_PATH>"
- filePath: "<RELATIVE_FILE_PATH>"
- line: <LINE_NUMBER>
- symbolName: "<SYMBOL_NAME>"

```

## Phase 4: Type Verification (3 seconds per location)
For suspicious code locations:
```

mcp**lsmcp-<ADAPTER>**get_hover

- root: "<PROJECT_PATH>"
- filePath: "<RELATIVE_FILE_PATH>"
- line: <LINE_NUMBER>
- target: "<CODE_SNIPPET>"

```

## Phase 5: Unused Code Detection
Identify symbols with zero references:
```

mcp**lsmcp-<ADAPTER>**find_references

- Check exported functions/classes
- Flag items with 0 references

```

## Report Format
1. Executive Summary
   - Total errors/warnings count
   - Critical issues requiring immediate attention

2. Detailed Findings
   - Group by severity (Error > Warning > Info)
   - Include file:line references
   - Show affected symbol names

3. Impact Analysis
   - Number of files affected
   - Cross-module dependencies

4. Recommendations
   - Priority fixes
   - Refactoring suggestions
   - Code quality improvements
```

## Supported Language Adapters

| Language              | Adapter Name | File Extension       | Special Notes                    |
| --------------------- | ------------ | -------------------- | -------------------------------- |
| TypeScript/JavaScript | tsgo-dev     | .ts, .tsx, .js, .jsx | Limited rename/workspace symbols |
| Python                | python-dev   | .py                  | Full LSP support                 |
| Rust                  | rust-dev     | .rs                  | Requires rust-analyzer           |
| Go                    | go-dev       | .go                  | Requires gopls                   |
| F#                    | fsharp-dev   | .fs, .fsx            | Requires fsautocomplete          |

## Example Usage

### TypeScript Project Analysis

```markdown
Project Root: /home/user/my-ts-project
Target Language: typescript
Analysis Goal: Find type errors and unused exports

## Phase 1: Capability Check

mcp**lsmcp-tsgo-dev**check_capabilities

## Phase 2: Project-wide Diagnostics

mcp**lsmcp-tsgo-dev**get_all_diagnostics

- root: "/home/user/my-ts-project"
- pattern: "src/\*_/_.ts"
- severityFilter: "error"
```

### Python Code Quality Check

```markdown
Project Root: /home/user/my-python-app
Target Language: python
Analysis Goal: Identify undefined variables and import issues

## Phase 1: Capability Check

mcp**lsmcp-python-dev**check_capabilities

## Phase 2: Project-wide Diagnostics

mcp**lsmcp-python-dev**get_all_diagnostics

- root: "/home/user/my-python-app"
- pattern: "\*_/_.py"
- severityFilter: "error"
```

## Performance Expectations

- **Phase 1**: Instant (<1s)
- **Phase 2**: 5-30s depending on project size
- **Phase 3**: 2-5s per symbol
- **Phase 4**: 1-3s per hover request
- **Phase 5**: 10-60s for full project scan

## Advantages over Traditional Search

1. **Semantic Accuracy**: Understands language constructs, not just text patterns
2. **Type Awareness**: Catches type mismatches and incompatibilities
3. **Cross-file Intelligence**: Tracks references across module boundaries
4. **Real-time Feedback**: Uses pre-indexed LSP data for instant results

## Limitations

- Requires language server support for the target language
- Some features may be limited by specific language server implementations
- Initial indexing may take time for large projects
- Memory usage scales with project size

## High-Level Analysis Tools

LSMCP now includes high-level analysis tools that provide faster symbol search and indexing capabilities:

### Symbol Indexing Tools

1. **index_files** - Build or update the symbol index

   ```
   mcp__lsmcp-<ADAPTER>__index_files
   - pattern: "**/*.ts"
   - root: "/project/path"
   - concurrency: 5
   ```

2. **find_symbol** - Fast symbol search using the index

   ```
   mcp__lsmcp-<ADAPTER>__find_symbol
   - name: "MyClass"           # Optional: partial matching supported
   - kind: ["Class", "Interface"]  # Optional: filter by symbol types
   - file: "src/models.ts"     # Optional: search within specific file
   - includeChildren: true     # Include nested symbols
   ```

3. **get_file_symbols** - Get all symbols in a file from index

   ```
   mcp__lsmcp-<ADAPTER>__get_file_symbols
   - filePath: "src/components/Button.tsx"
   ```

4. **get_index_stats** - View index statistics

   ```
   mcp__lsmcp-<ADAPTER>__get_index_stats
   ```

5. **clear_index** - Clear the symbol index
   ```
   mcp__lsmcp-<ADAPTER>__clear_index
   ```

### Example: Fast Symbol Search Workflow

```markdown
# Step 1: Build the index

mcp**lsmcp-tsgo-dev**index_files

- pattern: "src/\*_/_.ts"
- concurrency: 10

# Step 2: Find all classes and interfaces

mcp**lsmcp-tsgo-dev**find_symbol

- kind: ["Class", "Interface"]

# Step 3: Search for specific symbol

mcp**lsmcp-tsgo-dev**find_symbol

- name: "User"
- includeChildren: true

# Step 4: Get detailed symbols for a file

mcp**lsmcp-tsgo-dev**get_file_symbols

- filePath: "src/models/User.ts"
```

### Performance Benefits

- **Initial indexing**: 5-30 seconds for large projects
- **Symbol queries**: <100ms (vs 1-5 seconds with LSP)
- **File updates**: Automatic reindexing on changes
- **Memory efficient**: Indexed data structure

## Tips for Effective Analysis

1. Start with error-level diagnostics before checking warnings
2. Focus on high-traffic symbols (frequently imported/used)
3. Use specific file patterns to narrow scope when needed
4. Combine with traditional grep for text-pattern searches
5. Run analysis after significant refactoring to catch regressions
6. Build symbol index once at the start for faster repeated queries
7. Use partial name matching for flexible symbol search
