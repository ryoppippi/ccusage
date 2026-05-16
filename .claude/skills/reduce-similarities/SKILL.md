---
name: check-similarity-ts
description: Detect duplicate TypeScript/JavaScript code using AST-based similarity analysis. Use when working with .ts/.tsx/.js/.jsx files and looking for code duplication or refactoring opportunities.
argument-hint: '[path] [--threshold 0.85] [--print]'
allowed-tools: Bash(similarity-ts *) Read Grep Glob
paths: '**/*.ts,**/*.tsx,**/*.js,**/*.jsx'
---

# TypeScript/JavaScript Code Similarity Detection

## What to do

Run `similarity-ts` on the target project to detect duplicate functions and types, then analyze results and propose refactoring.

similarity-ts is installed via nix. check out flake.nix for details.

## Step 1: Run similarity analysis

```bash
similarity-ts $ARGUMENTS
```

If no arguments given:

```bash
similarity-ts . --threshold 0.85 --min-tokens 25
```

For type-level duplicates (interfaces, type aliases):

```bash
similarity-ts . --threshold 0.85 --experimental-types
```

## Step 2: Analyze results

### High-priority

- **100% similarity**: Extract shared function
- **95-100%**: Parameterize the small difference
- **Duplicate types/interfaces**: Consolidate into a single definition and re-export

### Medium-priority

- **85-95%**: Extract common pattern, especially for API handlers and data processing
- **Similar type literals**: Shared interface with optional fields

### Acceptable

- **Short utility functions** (< 5 lines) that naturally share structure
- **Overloaded variants** that differ by type parameter

## Step 3: Propose refactoring

For each high-priority pair, show before/after code with concrete implementation.

## Key Options

| Option                          | Description                                              |
| ------------------------------- | -------------------------------------------------------- |
| `--threshold <0-1>`             | Similarity threshold (default: 0.85)                     |
| `--min-tokens <n>`              | Skip functions with fewer AST nodes (recommended: 20-30) |
| `--print`                       | Show actual code snippets                                |
| `--experimental-types`          | Enable type/interface similarity detection               |
| `--experimental-overlap`        | Enable partial overlap detection                         |
| `--extensions <ext>`            | File extensions to check (comma-separated)               |
| `--filter-function <name>`      | Filter by function name                                  |
| `--filter-function-body <text>` | Filter by function body content                          |
| `--fail-on-duplicates`          | Exit code 1 if duplicates found                          |

## Common TS/JS refactoring patterns

- **Data processing loops** with different field names -> generic mapper
- **API handlers** with similar request/response logic -> shared middleware
- **Validation functions** -> schema-based validation
- **Duplicate interfaces** -> shared base interface with extensions
- **Similar type literals** -> extract named type
