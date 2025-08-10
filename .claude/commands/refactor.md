# Refactor Command

When I need to refactor TypeScript code in this project, follow these steps:

## 1. Analyze Current Code Structure

- Use `mcp_lsmcp__get_module_symbols` to understand module exports
- Use `mcp_lsmcp__get_type_at_symbol` to analyze type information
- Use `mcp_lsmcp__find_references` to find all usages before refactoring

## 2. Choose Appropriate Refactoring Tools

### For Symbol Operations

- **Rename**: Use `mcp_lsmcp__rename_symbol` instead of Edit/MultiEdit
- **Delete**: Use `mcp_lsmcp__delete_symbol` to remove symbols and their references
- **Find usages**: Use `mcp_lsmcp__find_references` instead of grep

### For File Operations

- **Move file**: Use `mcp_lsmcp__move_file` instead of bash mv
- **Move directory**: Use `mcp_lsmcp__move_directory` for entire directories

### For Type Analysis

- **Get type info**: Use `mcp_lsmcp__get_type_at_symbol`
- **Module analysis**: Use `mcp_lsmcp__get_module_symbols`
- **Scope analysis**: Use `mcp_lsmcp__get_symbols_in_scope`

## 3. Verify Changes

After refactoring:

1. Run `pnpm typecheck` to ensure no TypeScript errors
2. Run `pnpm lint` to check code style
3. Run `pnpm test` to verify functionality
4. Use `mcp_lsmcp__get_diagnostics` to check for issues

## 4. Common Refactoring Patterns

### Extract Interface/Type

1. Identify the type structure using `get_type_at_symbol`
2. Create new type definition file
3. Use `rename_symbol` to update references

### Move Module

1. Use `move_file` or `move_directory`
2. Tool automatically updates all imports
3. Verify with `get_diagnostics`

### Rename Across Project

1. Use `find_references` to see impact
2. Use `rename_symbol` for safe renaming
3. Check affected files with `git status`

## 5. Best Practices

- Always use TypeScript MCP tools for semantic operations
- Never use text-based Edit/MultiEdit for refactoring
- Check references before deleting or moving
- Run tests after each refactoring step
- Commit frequently with descriptive messages

## Example Commands

```bash
# Rename a function across the project
> Use mcp_lsmcp__rename_symbol to rename processData to transformData in src/utils.ts

# Move a module to a new location
> Use mcp_lsmcp__move_file to move src/helpers/parser.ts to src/core/parser.ts

# Find all usages before refactoring
> Use mcp_lsmcp__find_references for the Parser class in src/parser.ts
```
