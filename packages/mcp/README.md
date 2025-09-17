# @ccusage/mcp

MCP (Model Context Protocol) server implementation for ccusage - provides Claude Code usage data through the MCP protocol.

## Quick Start

```bash
# Using bunx (recommended for speed)
bunx @ccusage/mcp@latest

# Using npx
npx @ccusage/mcp@latest

# Start with HTTP transport
bunx @ccusage/mcp@latest -- --type http --port 8080
```

## Integrations

### Claude Desktop Integration

Add to your Claude Desktop MCP configuration:

```json
{
	"mcpServers": {
		"ccusage": {
			"command": "npx",
			"args": ["@ccusage/mcp@latest"],
			"type": "stdio"
		}
	}
}
```

### Claude Code

```sh
claude mcp add ccusage npx -- @ccusage/mcp@latest
```

## Documentation

For full documentation, visit **[ccusage.com/guide/mcp-server](https://ccusage.com/guide/mcp-server)**

## License

MIT
