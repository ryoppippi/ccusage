---
name: reduce-similarities
description: Detect duplicate Rust code using AST-based similarity analysis. Use when working with .rs files and looking for code duplication or refactoring opportunities.
argument-hint: '[path] [--threshold 0.85] [--print]'
allowed-tools: Bash(similarity-rs *) Read Grep Glob
paths: '**/*.rs'
---

# Rust Code Similarity Detection

## What to do

Run `similarity-rs` on the target Rust project to detect duplicate functions, struct/enum definitions, and impl methods, then analyze results and propose refactoring.

If `similarity-rs` is not installed:

```bash
similarity-rs

# or

direnv exec . similarity-rs
```

## Step 1: Run similarity analysis

```bash
similarity-rs $ARGUMENTS
```

If no arguments given:

```bash
similarity-rs . --threshold 0.85 --min-lines 5
```

For struct/enum similarity:

```bash
similarity-rs . --threshold 0.85 --experimental-types
```

## Step 2: Analyze results

### High-priority

- **100% similarity**: Exact duplicates -> extract shared function or use generics
- **95-100%**: Same algorithm on different types -> generic function with trait bounds
- **Duplicate impl methods**: Same logic across types -> trait with default implementation

### Medium-priority

- **85-95%**: Similar match arms or error handling -> macro or shared helper
- **Parallel struct definitions**: Identical fields -> shared base or generic struct

### Acceptable

- **Short `new()` constructors** with field initialization
- **Simple `From`/`Into` implementations**
- **Derive-equivalent implementations**

## Step 3: Propose refactoring

For each high-priority pair, show before/after code with Rust idioms.

## Key Options

| Option                     | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `--threshold <0-1>`        | Similarity threshold (default: 0.85)             |
| `--min-lines <n>`          | Skip functions shorter than n lines (default: 3) |
| `--min-tokens <n>`         | Skip functions with fewer AST nodes              |
| `--print`                  | Show actual code snippets                        |
| `--experimental-types`     | Enable struct/enum similarity detection          |
| `--filter-function <name>` | Filter by function name                          |
| `--fail-on-duplicates`     | Exit code 1 if duplicates found                  |

## Common Rust refactoring patterns

- **Type-specific functions** -> generic `fn<T: Trait>` with trait bounds
- **Duplicate impl blocks** across types -> trait with default methods
- **Repeated match patterns** -> macro_rules! or helper function
- **Parallel X/Y/Z functions** -> enum parameter or tuple-based abstraction
- **Similar error handling** -> shared Result combinator or `?` chain
