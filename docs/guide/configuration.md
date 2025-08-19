# Configuration

ccusage supports various configuration options to customize its behavior and adapt to different Claude Code installations. You can configure ccusage through configuration files, environment variables, and command-line options.

## Configuration Files

ccusage supports JSON configuration files to set default options for all commands or specific commands. This allows you to customize behavior without repeating options every time.

### Configuration File Locations

ccusage searches for configuration files in these locations (in priority order):

1. **Local project**: `.ccusage/ccusage.json` (highest priority)
2. **User config**: `~/.config/claude/ccusage.json`
3. **Legacy location**: `~/.claude/ccusage.json` (lowest priority)

Configuration files are merged in priority order, with local project settings overriding user settings.

### Basic Configuration

Create a `ccusage.json` file with default options:

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "json": false,
    "mode": "auto",
    "offline": false,
    "timezone": "Asia/Tokyo",
    "locale": "ja-JP",
    "breakdown": true
  }
}
```

### Command-Specific Configuration

Override defaults for specific commands:

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "mode": "auto",
    "offline": false
  },
  "commands": {
    "daily": {
      "instances": true,
      "breakdown": true
    },
    "blocks": {
      "active": true,
      "tokenLimit": "500000",
      "live": false
    },
    "statusline": {
      "offline": true,
      "cache": true,
      "refreshInterval": 2
    }
  }
}
```

### Available Configuration Options

#### Global Defaults

Set default values that apply to all commands:

```json
{
  "defaults": {
    "since": "20250101",
    "until": "20250630",
    "json": false,
    "mode": "auto",
    "debug": false,
    "debugSamples": 5,
    "order": "asc",
    "breakdown": false,
    "offline": false,
    "timezone": "UTC",
    "locale": "en-CA",
    "jq": ".data[]"
  }
}
```

#### Command-Specific Options

##### Daily Command

```json
{
  "commands": {
    "daily": {
      "instances": true,
      "project": "my-project",
      "breakdown": true
    }
  }
}
```

##### Weekly Command

```json
{
  "commands": {
    "weekly": {
      "startOfWeek": "monday",
      "breakdown": true
    }
  }
}
```

##### Session Command

```json
{
  "commands": {
    "session": {
      "id": "abc123-session"
    }
  }
}
```

##### Blocks Command

```json
{
  "commands": {
    "blocks": {
      "active": true,
      "recent": false,
      "tokenLimit": "max",
      "sessionLength": 5,
      "live": false,
      "refreshInterval": 1
    }
  }
}
```

##### MCP Server

```json
{
  "commands": {
    "mcp": {
      "type": "stdio",
      "port": 8080,
      "mode": "auto"
    }
  }
}
```

##### Statusline

```json
{
  "commands": {
    "statusline": {
      "offline": true,
      "cache": true,
      "refreshInterval": 1
    }
  }
}
```

### Configuration Priority

Settings are applied in this priority order (highest to lowest):

1. **Command-line arguments** (e.g., `--json`, `--offline`)
2. **Custom config file** (specified with `--config /path/to/config.json`)
3. **Local project config** (`.ccusage/ccusage.json`)
4. **User config** (`~/.config/claude/ccusage.json`)
5. **Legacy config** (`~/.claude/ccusage.json`)
6. **Built-in defaults**

### Custom Configuration Files

You can specify a custom configuration file using the `--config` option:

```bash
# Use a specific configuration file
ccusage daily --config ./my-config.json

# Works with all commands
ccusage blocks --config /path/to/team-config.json
```

This is useful for:
- **Team configurations** - Share configuration files across team members
- **Environment-specific settings** - Different configs for development/production
- **Project-specific overrides** - Use different settings for different projects

### IDE Support

ccusage provides JSON Schema for autocomplete and validation. Add the `$schema` property to get IntelliSense:

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "mode": "auto"
  }
}
```

You can also reference a local schema file (after installing ccusage):

```json
{
  "$schema": "./node_modules/ccusage/config-schema.json",
  "defaults": {
    "mode": "auto"
  }
}
```

### Configuration Examples

#### Team Development

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "timezone": "America/New_York",
    "locale": "en-US",
    "breakdown": true
  },
  "commands": {
    "daily": {
      "instances": true
    },
    "blocks": {
      "active": true,
      "tokenLimit": "500000"
    }
  }
}
```

#### International Team

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "timezone": "UTC",
    "locale": "en-CA",
    "json": true
  },
  "commands": {
    "daily": {
      "jq": ".data[] | select(.cost > 1.0)"
    }
  }
}
```

#### High-Performance Setup

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "offline": true,
    "mode": "calculate"
  },
  "commands": {
    "statusline": {
      "cache": true,
      "refreshInterval": 5
    },
    "blocks": {
      "live": true,
      "refreshInterval": 2
    }
  }
}
```

## Environment Variables

### CLAUDE_CONFIG_DIR

The `CLAUDE_CONFIG_DIR` environment variable specifies where ccusage should look for Claude Code data.

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

### LOG_LEVEL

Control the verbosity of log output using the `LOG_LEVEL` environment variable. ccusage uses [consola](https://github.com/unjs/consola) for logging under the hood:

```bash
# Set logging level
export LOG_LEVEL=0  # Silent (errors only)
export LOG_LEVEL=1  # Warnings
export LOG_LEVEL=2  # Normal logs
export LOG_LEVEL=3  # Informational logs (default)
export LOG_LEVEL=4  # Debug logs
export LOG_LEVEL=5  # Trace logs (most verbose)

# Examples
LOG_LEVEL=0 ccusage daily       # Silent output, only show results
LOG_LEVEL=4 ccusage daily       # Debug output for troubleshooting
LOG_LEVEL=5 ccusage session     # Trace all operations
```

#### Use Cases

- **Clean Output**: Use `LOG_LEVEL=0` for scripts or when piping output
- **Debugging**: Use `LOG_LEVEL=4` or `5` to troubleshoot issues
- **CI/CD**: Use `LOG_LEVEL=1` to only see warnings and errors
- **Development**: Use higher levels to understand internal operations

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

# Timezone
ccusage daily --timezone UTC           # Use UTC timezone
ccusage daily -z America/New_York      # Use New York timezone
ccusage daily --timezone Asia/Tokyo    # Use Tokyo timezone

# Locale
ccusage daily --locale en-US           # US English (12-hour time)
ccusage daily -l ja-JP                 # Japanese (24-hour time)
ccusage daily --locale de-DE           # German (24-hour time)

# Project analysis (daily command only)
ccusage daily --instances              # Group by project
ccusage daily --project myproject      # Filter to specific project
ccusage daily --instances --project myproject  # Combined usage
```

### Timezone Configuration

The `--timezone` option controls how dates are calculated for grouping usage data:

```bash
# Use UTC timezone for consistent reports
ccusage daily --timezone UTC

# Use specific timezone
ccusage daily --timezone America/New_York
ccusage monthly -z Asia/Tokyo

# Default behavior (no timezone specified)
ccusage daily  # Uses system's local timezone
```

#### Timezone Effect

The timezone affects how usage is grouped by date. For example, usage at 11 PM UTC on January 1st would appear on:
- **January 1st** when `--timezone UTC`
- **January 1st** when `--timezone America/New_York` (6 PM EST)
- **January 2nd** when `--timezone Asia/Tokyo` (8 AM JST next day)

#### Use Cases

- **UTC Alignment**: Use `--timezone UTC` for consistent reports across different locations
- **Remote Teams**: Align reports to team's primary timezone
- **Cross-Timezone Analysis**: Compare usage patterns across different time zones
- **CI/CD Environments**: Use UTC for consistent automated reports

### Locale Configuration

The `--locale` option controls date and time formatting:

```bash
# Use US English locale (12-hour time format)
ccusage daily --locale en-US

# Use Japanese locale (24-hour time format)
ccusage blocks --locale ja-JP

# Use German locale (24-hour time format)
ccusage session -l de-DE

# Default behavior (no locale specified)
ccusage daily  # Uses en-CA (ISO date format, 24-hour time)
```

#### Locale Effects

The locale affects how dates and times are displayed:

- **Date Format**:
  - `en-US`: 08/04/2025
  - `en-CA`: 2025-08-04 (ISO format)
  - `ja-JP`: 2025/08/04
  - `de-DE`: 04.08.2025

- **Time Format**:
  - `en-US`: 3:30:00 PM (12-hour)
  - `en-CA`, `ja-JP`, `de-DE`: 15:30:00 (24-hour)

#### Use Cases

- **International Teams**: Display dates/times in familiar formats
- **12/24 Hour Preference**: Choose between AM/PM or 24-hour time
- **Regional Standards**: Match local date formatting conventions
- **ISO Compliance**: Use `en-CA` for ISO 8601 date format

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

Each tool accepts `since`, `until`, `mode`, `timezone`, and `locale` parameters.

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
