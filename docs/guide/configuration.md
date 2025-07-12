# Configuration

ccusage supports various configuration options to customize its behavior and adapt to different Claude Code installations.

## Environment Variables

### CLAUDE_CONFIG_DIR

The primary configuration option is the `CLAUDE_CONFIG_DIR` environment variable, which specifies where ccusage should look for Claude Code data.

#### Single Directory

```bash
# Set a single custom Claude data directory
export CLAUDE_CONFIG_DIR="/path/to/your/claude/data"
ccusage daily
```

#### Multiple Directories

```bash
# Set multiple directories (comma-separated)
export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"
ccusage daily
```

When multiple directories are specified, ccusage automatically aggregates usage data from all valid locations.

### CCUSAGE_PROJECT_ALIASES

Configure custom display names for project directories using the `CCUSAGE_PROJECT_ALIASES` environment variable:

```bash
# Set custom project aliases
export CCUSAGE_PROJECT_ALIASES="long-project-name=Short Name,uuid-project=My Project"
ccusage daily --instances
```

#### Format

Use comma-separated `raw-name=alias` pairs:

```bash
export CCUSAGE_PROJECT_ALIASES="project1=Production API,project2=Dev Environment"
```

#### Use Cases

- **UUID Projects**: Replace cryptic UUIDs with readable names
- **Long Paths**: Shorten verbose directory names for better table display
- **Team Consistency**: Standardize project names across team members

#### Example

```bash
# Without aliases
ccusage daily --instances
# Shows: a2cd99ed-a586-4fe4-8f59-b0026409ec09

# With aliases
export CCUSAGE_PROJECT_ALIASES="a2cd99ed-a586-4fe4-8f59-b0026409ec09=My Project"
ccusage daily --instances
# Shows: My Project
```

#### Project Name Formatting

ccusage automatically formats complex project directory names into readable display names:

**Automatic Cleanup:**
- **Path Removal**: Strips common directory prefixes like `/Users/username/Development/`
- **UUID Shortening**: Reduces long UUIDs to last two segments for brevity
- **Feature Branch Parsing**: Extracts meaningful names from complex paths

**Examples:**

```bash
# Complex project paths → Formatted names
-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot
→ configure-dependabot

a2cd99ed-a586-4fe4-8f59-b0026409ec09.jsonl  
→ 8f59-b0026409ec09.jsonl

/Users/john/Development/my-app
→ my-app
```

**Priority Order:**
1. **Custom aliases** (via `CCUSAGE_PROJECT_ALIASES`) take highest priority
2. **Automatic formatting** applies intelligent parsing rules
3. **Original name** used as fallback if parsing fails

## Default Directory Detection

### Automatic Detection

ccusage automatically searches for Claude Code data in these locations:

- **`~/.config/claude/projects/`** - New default location (Claude Code v1.0.30+)
- **`~/.claude/projects/`** - Legacy location (pre-v1.0.30)

::: info Directory Change
The directory change from `~/.claude` to `~/.config/claude` in Claude Code v1.0.30 was an undocumented breaking change. ccusage handles both locations automatically for compatibility.
:::

### Search Priority

When `CLAUDE_CONFIG_DIR` is not set, ccusage searches in this order:

1. `~/.config/claude/projects/` (preferred)
2. `~/.claude/projects/` (fallback)

Data from all valid directories is automatically combined.

## Command-Line Options

### Global Options

All ccusage commands support these configuration options:

```bash
# Date filtering
ccusage daily --since 20250101 --until 20250630

# Output format
ccusage daily --json                    # JSON output
ccusage daily --breakdown              # Per-model breakdown

# Cost calculation modes
ccusage daily --mode auto              # Use costUSD when available (default)
ccusage daily --mode calculate         # Always calculate from tokens
ccusage daily --mode display           # Always use pre-calculated costUSD

# Sort order
ccusage daily --order desc             # Newest first (default)
ccusage daily --order asc              # Oldest first

# Offline mode
ccusage daily --offline                # Use cached pricing data
ccusage daily -O                       # Short alias

# Project analysis (daily command only)
ccusage daily --instances              # Group by project
ccusage daily --project myproject      # Filter to specific project
ccusage daily --instances --project myproject  # Combined usage
```

### Debug Options

```bash
# Debug pricing mismatches
ccusage daily --debug

# Show sample discrepancies
ccusage daily --debug --debug-samples 10
```

## Cost Calculation Modes

ccusage supports three different cost calculation modes:

### auto (Default)

Uses pre-calculated `costUSD` values when available, falls back to calculating costs from token counts:

```bash
ccusage daily --mode auto
```

- ✅ Most accurate when Claude provides cost data
- ✅ Falls back gracefully for older data
- ✅ Best for general use

### calculate

Always calculates costs from token counts using model pricing, ignores pre-calculated values:

```bash
ccusage daily --mode calculate
```

- ✅ Consistent calculation method
- ✅ Useful for comparing different time periods
- ❌ May differ from actual Claude billing

### display

Always uses pre-calculated `costUSD` values only, shows $0.00 for missing costs:

```bash
ccusage daily --mode display
```

- ✅ Shows only Claude-provided cost data
- ✅ Most accurate for recent usage
- ❌ Shows $0.00 for older entries without cost data

## Offline Mode

ccusage can operate without network connectivity by using pre-cached pricing data:

```bash
# Use offline mode
ccusage daily --offline
ccusage monthly -O
```

### When to Use Offline Mode

#### ✅ Ideal For

- **Air-gapped systems** - Networks with restricted internet access
- **Corporate environments** - Behind firewalls or proxies
- **Consistent pricing** - Using cached model pricing for consistent reports
- **Fast execution** - Avoiding network delays

#### ❌ Limitations

- **Claude models only** - Only supports Claude models (Opus, Sonnet, etc.)
- **Pricing updates** - Won't get latest pricing information
- **New models** - May not support newly released models

### Updating Cached Data

Cached pricing data is updated automatically when running in online mode. To refresh:

```bash
# Run online to update cache
ccusage daily

# Then use offline mode
ccusage daily --offline
```

## MCP Server Configuration

ccusage includes a built-in MCP (Model Context Protocol) server for integration with other tools.

### Basic Usage

```bash
# Start MCP server with stdio transport (default)
ccusage mcp

# Start with HTTP transport
ccusage mcp --type http --port 8080

# Configure cost calculation mode
ccusage mcp --mode calculate
```

### Claude Desktop Integration

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
	"mcpServers": {
		"ccusage": {
			"command": "npx",
			"args": ["ccusage@latest", "mcp"],
			"env": {
				"CLAUDE_CONFIG_DIR": "/custom/path/to/claude"
			}
		}
	}
}
```

Or with global installation:

```json
{
	"mcpServers": {
		"ccusage": {
			"command": "ccusage",
			"args": ["mcp"],
			"env": {}
		}
	}
}
```

### Available MCP Tools

- **`daily`** - Daily usage reports
- **`monthly`** - Monthly usage reports
- **`session`** - Session-based reports
- **`blocks`** - 5-hour billing blocks reports

Each tool accepts `since`, `until`, and `mode` parameters.

## Terminal Display Configuration

ccusage automatically adapts its display based on terminal width:

### Wide Terminals (≥100 characters)

- Shows all columns with full model names
- Displays cache metrics and total tokens
- Uses bulleted model lists for readability

### Narrow Terminals (<100 characters)

- Automatic compact mode with essential columns only
- Shows Date, Models, Input, Output, Cost (USD)
- Helpful message about expanding terminal width

### Force Display Mode

Currently, display mode is automatic based on terminal width. Future versions may include manual override options.

## Configuration Examples

### Development Environment

```bash
# Set environment variables in your shell profile
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"

# Add aliases for common commands
alias ccu-daily="ccusage daily --breakdown"
alias ccu-live="ccusage blocks --live"
alias ccu-json="ccusage daily --json"
```

### CI/CD Environment

```bash
# Use offline mode in CI
export CCUSAGE_OFFLINE=1
ccusage daily --offline --json > usage-report.json
```

### Multiple Team Members

```bash
# Each team member sets their own Claude directory
export CLAUDE_CONFIG_DIR="/team-shared/claude-data/$USER"
ccusage daily --since 20250101
```

## Troubleshooting Configuration

### Common Issues

#### No Data Found

If ccusage reports no data found:

```bash
# Check if Claude directories exist
ls -la ~/.claude/projects/
ls -la ~/.config/claude/projects/

# Verify environment variable
echo $CLAUDE_CONFIG_DIR

# Test with explicit environment variable
export CLAUDE_CONFIG_DIR="/path/to/claude/projects"
ccusage daily
```

#### Permission Errors

```bash
# Check directory permissions
ls -la ~/.claude/
ls -la ~/.config/claude/

# Fix permissions if needed
chmod -R 755 ~/.claude/
chmod -R 755 ~/.config/claude/
```

#### Network Issues in Offline Mode

```bash
# Run online first to cache pricing data
ccusage daily

# Then use offline mode
ccusage daily --offline
```

## Next Steps

After configuring ccusage:

- Learn about [Custom Paths](/guide/custom-paths) for advanced directory management
- Explore [Cost Modes](/guide/cost-modes) for different calculation approaches
- Try [Live Monitoring](/guide/live-monitoring) for real-time usage tracking
