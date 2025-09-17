# CLAUDE.md - MCP Package

This package provides the MCP (Model Context Protocol) server implementation for ccusage data.

## Package Overview

**Name**: `@ccusage/mcp`
**Description**: MCP server implementation for ccusage data
**Type**: MCP server with CLI and library exports

## Development Commands

**Testing and Quality:**

- `pnpm run test` - Run all tests using vitest
- `pnpm run lint` - Lint code using ESLint
- `pnpm run format` - Format and auto-fix code with ESLint
- `pnpm typecheck` - Type check with TypeScript

**Build and Release:**

- `pnpm run build` - Build distribution files with tsdown
- `pnpm run prerelease` - Full release workflow (lint + typecheck + build)

## Usage

**As MCP Server:**

```bash
# Install and run as MCP server
pnpm dlx @ccusage/mcp@latest -- --help
pnpm dlx @ccusage/mcp@latest -- --type http --port 8080
```

**Direct Usage:**

```bash
# Run the CLI directly
ccusage-mcp --help
```

## Architecture

This package implements an MCP server that exposes ccusage functionality through the Model Context Protocol:

**Key Modules:**

- `src/index.ts` - Main MCP server implementation
- `src/cli.ts` - CLI entry point for the MCP server
- `src/command.ts` - Command handling and routing

**MCP Tools Provided:**

- `daily` - Daily usage reports
- `session` - Session-based usage reports
- `monthly` - Monthly usage reports
- `blocks` - 5-hour billing blocks usage reports

**Transport Support:**

- HTTP transport for web-based integration
- Configurable port and host settings

## Dependencies

**Key Runtime Dependencies:**

- `@hono/mcp` - MCP implementation for Hono
- `@hono/node-server` - Node.js server adapter for Hono
- `@modelcontextprotocol/sdk` - Official MCP SDK
- `ccusage` - Main ccusage package (workspace dependency)
- `gunshi` - CLI framework
- `hono` - Web framework
- `zod` - Schema validation

**Key Dev Dependencies:**

- `vitest` - Testing framework
- `tsdown` - TypeScript build tool
- `eslint` - Linting and formatting
- `fs-fixture` - Test fixture creation

## Integration with Claude Desktop

This MCP server can be integrated with Claude Desktop to provide usage analysis directly within Claude conversations. Configure it in your Claude Desktop MCP settings to access ccusage data through the MCP protocol.

## Testing

- **In-Source Testing**: Uses the same testing pattern as the main package
- **Vitest Globals Enabled**: Use `describe`, `it`, `expect` directly without imports
- **Mock Data**: Uses `fs-fixture` for testing MCP server functionality
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere

## Code Style

Follow the same code style guidelines as the main ccusage package:

- **Error Handling**: Prefer `@praha/byethrow Result` type over try-catch
- **Imports**: Use `.ts` extensions for local imports
- **Exports**: Only export what's actually used
- **Dependencies**: Add as `devDependencies` unless explicitly requested

**Post-Change Workflow:**
Always run these commands in parallel after code changes:

- `pnpm run format` - Auto-fix and format
- `pnpm typecheck` - Type checking
- `pnpm run test` - Run tests

## Package Exports

The package provides multiple exports:

- `.` - Main MCP server
- `./cli` - CLI entry point
- `./command` - Command handling utilities

## Binary

The package includes a binary `ccusage-mcp` that can be used to start the MCP server from the command line.
