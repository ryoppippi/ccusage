# Configuration Files

ccusage supports JSON configuration files for persistent settings. Configuration files allow you to set default options for all commands or customize behavior for specific commands without repeating options every time.

## Quick Start

### 1. Use Schema for IDE Support

Always include the schema for autocomplete and validation:

```json
{
  "$schema": "https://ccusage.com/config-schema.json"
}
```

### 2. Set Common Defaults

Put frequently used options in `defaults`:

```json
{
  "defaults": {
    "timezone": "UTC",
    "locale": "en-CA",
    "breakdown": true
  }
}
```

### 3. Override for Specific Commands

```json
{
  "defaults": {
    "breakdown": false
  },
  "commands": {
    "daily": {
      "breakdown": true  // Only daily needs breakdown
    }
  }
}
```

### 4. Convert CLI Arguments to Config

If you find yourself repeating CLI arguments:

```bash
# Before (repeated CLI arguments)
ccusage daily --breakdown --instances --timezone UTC
ccusage monthly --breakdown --timezone UTC
```

Convert them to a config file:

```json
// ccusage.json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "breakdown": true,
    "timezone": "UTC"
  },
  "commands": {
    "daily": {
      "instances": true
    }
  }
}
```

Now simpler commands:
```bash
ccusage daily
ccusage monthly
```

## Configuration File Locations

ccusage searches for configuration files in these locations (in priority order):

1. **Local project**: `.ccusage/ccusage.json` (highest priority)
2. **User config**: `~/.config/claude/ccusage.json`
3. **Legacy location**: `~/.claude/ccusage.json` (lowest priority)

Configuration files are merged in priority order, with local project settings overriding user settings.

## Basic Configuration

Create a `ccusage.json` file with your preferred defaults:

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

## Configuration Structure

### Schema Support

Add the `$schema` property to get IntelliSense and validation in your IDE:

```json
{
  "$schema": "https://ccusage.com/config-schema.json"
}
```

You can also reference a local schema file after installing ccusage:

```json
{
  "$schema": "./node_modules/ccusage/config-schema.json"
}
```

### Global Defaults

The `defaults` section sets default values for all commands:

```json
{
  "$schema": "https://ccusage.com/config-schema.json",
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

### Command-Specific Configuration

Override defaults for specific commands using the `commands` section:

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
      "tokenLimit": "500000"
    }
  }
}
```

## Command-Specific Options

### Daily Command

```json
{
  "commands": {
    "daily": {
      "instances": true,
      "project": "my-project",
      "breakdown": true,
      "since": "20250101",
      "until": "20250630"
    }
  }
}
```

### Weekly Command

```json
{
  "commands": {
    "weekly": {
      "startOfWeek": "monday",
      "breakdown": true,
      "timezone": "Europe/London"
    }
  }
}
```

### Monthly Command

```json
{
  "commands": {
    "monthly": {
      "breakdown": true,
      "mode": "calculate",
      "locale": "en-US"
    }
  }
}
```

### Session Command

```json
{
  "commands": {
    "session": {
      "id": "abc123-session",
      "project": "my-project",
      "json": true
    }
  }
}
```

### Blocks Command

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

### MCP Server

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

### Statusline

```json
{
  "commands": {
    "statusline": {
      "offline": true,
      "cache": true,
      "refreshInterval": 2
    }
  }
}
```

## Custom Configuration Files

Use the `--config` option to specify a custom configuration file:

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

## Configuration Example

For a complete configuration example, see [`/ccusage.example.json`](/ccusage.example.json) in the repository root, which demonstrates:

- Global defaults configuration
- Command-specific overrides
- All available options with proper types


## Configuration Priority

Settings are applied in this priority order (highest to lowest):

1. **Command-line arguments** (e.g., `--json`, `--offline`)
2. **Custom config file** (specified with `--config /path/to/config.json`)
3. **Local project config** (`.ccusage/ccusage.json`)
4. **User config** (`~/.config/claude/ccusage.json`)
5. **Legacy config** (`~/.claude/ccusage.json`)
6. **Built-in defaults**

Example:
```json
// .ccusage/ccusage.json
{
  "defaults": {
    "mode": "calculate"
  }
}
```

```bash
# Config file sets mode to "calculate"
ccusage daily  # Uses mode: calculate

# But CLI argument overrides it
ccusage daily --mode display  # Uses mode: display
```

## Debugging Configuration

Use the `--debug` flag to see configuration loading details:

```bash
# Debug configuration loading
ccusage daily --debug

# Debug custom config file
ccusage daily --debug --config ./my-config.json
```

Debug output shows:
- Which config files are checked and found
- Schema and option details from loaded configs
- How options are merged from different sources
- Final values used for each option

Example debug output:
```
[ccusage] ℹ Debug mode enabled - showing config loading details

[ccusage] ℹ Searching for config files:
  • Checking: .ccusage/ccusage.json (found ✓)
  • Checking: ~/.config/claude/ccusage.json (found ✓)
  • Checking: ~/.claude/ccusage.json (not found)

[ccusage] ℹ Loaded config from: .ccusage/ccusage.json
  • Schema: https://ccusage.com/config-schema.json
  • Has defaults: yes (3 options)
  • Has command configs: yes (daily)

[ccusage] ℹ Merging options for 'daily' command:
  • From defaults: mode="auto", offline=false
  • From command config: instances=true
  • From CLI args: debug=true
  • Final merged options: {
      mode: "auto" (from defaults),
      offline: false (from defaults),
      instances: true (from command config),
      debug: true (from CLI)
    }
```

## Best Practices

### Version Control

For project configs, commit `.ccusage/ccusage.json` to version control:

```bash
# Add to git
git add .ccusage/ccusage.json
git commit -m "Add ccusage configuration"
```

### Document Team Configs

Add comments using a README alongside team configs:

```
team-configs/
├── ccusage.json
└── README.md  # Explain configuration choices
```

## Troubleshooting

### Config Not Being Applied

1. Check file location is correct
2. Verify JSON syntax is valid
3. Use `--debug` to see loading details
4. Ensure option names match exactly

### Invalid JSON

Use a JSON validator or IDE with JSON support:

```bash
# Validate JSON syntax
jq . < ccusage.json
```

### Schema Validation Errors

Ensure option values match expected types:

```json
{
  "defaults": {
    "tokenLimit": "500000",  // ✅ String or number
    "active": true,          // ✅ Boolean
    "refreshInterval": 2     // ✅ Number
  }
}
```

## Related Documentation

- [Command-Line Options](/guide/cli-options) - Available CLI arguments
- [Environment Variables](/guide/environment-variables) - Environment configuration
- [Configuration Overview](/guide/configuration) - Complete configuration guide