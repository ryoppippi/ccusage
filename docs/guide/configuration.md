# Configuration Overview

ccusage provides multiple ways to configure its behavior, allowing you to customize it for your specific needs. Configuration can be done through command-line options, environment variables, configuration files, or a combination of all three.

## Configuration Methods

ccusage supports four configuration methods, each with its own use case:

1. **[Command-Line Options](/guide/cli-options)** - Direct control for individual commands
2. **[Environment Variables](/guide/environment-variables)** - System-wide or session settings
3. **[Configuration Files](/guide/config-files)** - Persistent, shareable settings
4. **[Directory Detection](/guide/directory-detection)** - Automatic Claude data discovery

## Configuration Priority

Settings are applied in this priority order (highest to lowest):

1. **Command-line arguments** (e.g., `--json`, `--offline`)
2. **Custom config file** (via `--config` flag)
3. **Environment variables** (e.g., `CLAUDE_CONFIG_DIR`, `LOG_LEVEL`)
4. **Local project config** (`.ccusage/ccusage.json`)
5. **User config** (`~/.config/claude/ccusage.json`)
6. **Legacy config** (`~/.claude/ccusage.json`)
7. **Built-in defaults**

### Priority Example

```bash
# Configuration file sets mode to "calculate"
# .ccusage/ccusage.json
{
  "defaults": {
    "mode": "calculate"
  }
}

# Environment variable sets timezone
export CCUSAGE_TIMEZONE="Asia/Tokyo"

# Command-line argument takes highest priority
ccusage daily --mode display --timezone UTC
# Result: mode=display (CLI), timezone=UTC (CLI)
```

## Quick Start

### Basic Setup

1. **Set your Claude directory** (if not using defaults):
```bash
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
```

2. **Create a configuration file** for your preferences:
```json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "timezone": "America/New_York",
    "locale": "en-US",
    "breakdown": true
  }
}
```

3. **Use command-line options** for one-off changes:
```bash
ccusage daily --since 20250101 --json
```

## Common Configuration Scenarios

### Personal Development

For individual developers working on multiple projects:

```json
// ~/.config/claude/ccusage.json
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "breakdown": true,
    "timezone": "local"
  },
  "commands": {
    "daily": {
      "instances": true
    }
  }
}
```

### Team Collaboration

For teams sharing configuration:

```json
// .ccusage/ccusage.json (committed to repo)
{
  "$schema": "https://ccusage.com/config-schema.json",
  "defaults": {
    "timezone": "UTC",
    "locale": "en-CA",
    "mode": "auto"
  }
}
```

### CI/CD Pipeline

For automated environments:

```bash
# Environment variables
export CLAUDE_CONFIG_DIR="/ci/claude-data"
export LOG_LEVEL=1  # Warnings only

# Run with specific options
ccusage daily --offline --json > report.json
```

### Multiple Claude Installations

For users with multiple Claude Code versions:

```bash
# Aggregate from multiple directories
export CLAUDE_CONFIG_DIR="$HOME/.claude,$HOME/.config/claude"
ccusage daily
```

## Configuration by Feature

### Cost Calculation

Control how costs are calculated:

- **Mode**: `auto` (default), `calculate`, or `display`
- **Offline**: Use cached pricing data
- **Breakdown**: Show per-model costs

```bash
ccusage daily --mode calculate --breakdown --offline
```

### Date and Time

Customize date/time handling:

- **Timezone**: Any valid timezone (e.g., `UTC`, `America/New_York`)
- **Locale**: Format preferences (e.g., `en-US`, `ja-JP`)
- **Date Range**: Filter with `--since` and `--until`

```bash
ccusage daily --timezone UTC --locale en-CA --since 20250101
```

### Output Format

Control output presentation:

- **JSON**: Machine-readable output with `--json`
- **JQ Filtering**: Process JSON with `--jq`
- **Debug**: Show detailed information with `--debug`

```bash
ccusage daily --json --jq ".data[] | select(.cost > 10)"
```

### Project Analysis

Analyze usage by project:

- **Instances**: Group by project with `--instances`
- **Project Filter**: Focus on specific project with `--project`
- **Aliases**: Set custom names via configuration file

```json
// .ccusage/ccusage.json
{
  "commands": {
    "daily": {
      "projectAliases": "uuid-123=My App,long-name=Backend"
    }
  }
}
```

```bash
ccusage daily --instances --project "My App"
```

## Debugging Configuration

Use debug mode to understand configuration loading:

```bash
# See which config files are loaded
ccusage daily --debug

# Check environment variables
env | grep -E "CLAUDE|CCUSAGE|LOG_LEVEL"

# Verbose logging
LOG_LEVEL=5 ccusage daily
```

### Debug Output

Debug mode shows:
- Config file discovery and loading
- Option merging from different sources
- Final configuration values
- Pricing calculation details

## Best Practices

### 1. Layer Your Configuration

Use different configuration methods for different scopes:

- **Environment variables**: Machine-specific settings (paths)
- **User config**: Personal preferences (timezone, locale)
- **Project config**: Team standards (mode, formatting)
- **CLI arguments**: One-off overrides

### 2. Use Configuration Files for Teams

Share consistent settings across team members:

```bash
# Commit to version control
git add .ccusage/ccusage.json
git commit -m "Add team ccusage configuration"
```

### 3. Document Your Configuration

Add comments or README files explaining configuration choices:

```markdown
# ccusage Configuration

Our team uses:
- UTC timezone for consistency
- JSON output for automated processing
- Calculate mode for accurate cost tracking
```

### 4. Validate Configuration

Use the schema for validation:

```json
{
  "$schema": "https://ccusage.com/config-schema.json"
}
```

### 5. Keep Secrets Secure

Never put sensitive information in configuration files:

- ❌ API keys or tokens
- ❌ Personal identifiers
- ✅ Timezone preferences
- ✅ Output formats

## Migration Guide

### From v1 to v2

If upgrading from older versions:

1. Update directory paths (now supports `~/.config/claude`)
2. Migrate environment variables to config files
3. Update any scripts using old CLI options

### From Manual Commands

Convert repeated commands to configuration:

```bash
# Before: Repeated commands
ccusage daily --breakdown --instances --timezone UTC

# After: Configuration file
{
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

# Simplified command
ccusage daily
```

## Troubleshooting

### Common Issues

1. **Configuration not applied**: Check priority order
2. **Invalid JSON**: Validate syntax with `jq`
3. **Directory not found**: Verify `CLAUDE_CONFIG_DIR`
4. **No data**: Check directory permissions

### Getting Help

If configuration issues persist:

1. Run with debug mode: `ccusage daily --debug`
2. Check verbose logs: `LOG_LEVEL=5 ccusage daily`
3. Validate JSON config: `jq . < ccusage.json`
4. Report issues on [GitHub](https://github.com/ryoppippi/ccusage/issues)

## Next Steps

Explore specific configuration topics:

- [Command-Line Options](/guide/cli-options) - All available CLI arguments
- [Environment Variables](/guide/environment-variables) - System configuration
- [Configuration Files](/guide/config-files) - Persistent settings
- [Directory Detection](/guide/directory-detection) - Claude data discovery
- [Cost Modes](/guide/cost-modes) - Understanding calculation modes
- [Custom Paths](/guide/custom-paths) - Advanced path management