---
name: byethrow
description: Reference the byethrow documentation to understand and use the Result type library for error handling in JavaScript/TypeScript. Access detailed API references, practical usage examples, and best practice guides.
allowed-tools: Read, Grep, Glob, Bash(npx @praha/byethrow-docs:*)
---

## About byethrow

`@praha/byethrow` is a lightweight, tree-shakable Result type library for handling fallible operations in JavaScript and TypeScript.
It provides a simple, consistent API for managing errors and results without throwing exceptions.

For detailed API references and usage examples, refer to the documentation in `node_modules/@praha/byethrow-docs/docs/**/*.md`.

### Documentation CLI

The byethrow documentation CLI provides commands to browse, search, and navigate documentation directly from your terminal.

#### `list` command

List all available documentation organized by sections.

```bash
# List all documentation
npx @praha/byethrow-docs list

# List documentation with filter query
npx @praha/byethrow-docs list --query "your query"
```

**Options:**

- `--query <string>`: Filter documentation by keywords (optional)

#### `search` command

Search documentation and get matching results with highlighted snippets.

```bash
# Search documentation
npx @praha/byethrow-docs search "your query"

# Limit number of results (default: 5)
npx @praha/byethrow-docs search "your query" --limit 10
```

**Arguments:**

- `query`: Search query string (required)

**Options:**

- `--limit <number>`: Maximum number of results to return (default: 5)

#### `toc` command

Display table of contents from a documentation file.

```bash
# Display table of contents from a markdown file
npx @praha/byethrow-docs toc path/to/document.md
```

**Arguments:**

- `path`: Path to the documentation file (required)
