# Custom Paths

ccusage supports flexible path configuration to handle various Claude Code installation scenarios and custom data locations.

## Overview

By default, ccusage automatically detects Claude Code data in standard locations. However, you can customize these paths for:

- **Multiple Claude installations** - Different versions or profiles
- **Custom data locations** - Non-standard installation directories
- **Shared environments** - Team or organization setups
- **Backup/archive analysis** - Analyzing historical data from different locations

## CLAUDE_CONFIG_DIR Environment Variable

The primary method for specifying custom paths is the `CLAUDE_CONFIG_DIR` environment variable.

### Single Custom Path

Specify one custom directory:

```bash
# Set environment variable
export CLAUDE_CONFIG_DIR="/path/to/your/claude/data"

# Use with any command
ccusage daily
ccusage monthly --breakdown
ccusage blocks --live
```

Example scenarios:

```bash
# Custom installation location
export CLAUDE_CONFIG_DIR="/opt/claude-code/.claude"

# User-specific directory
export CLAUDE_CONFIG_DIR="/home/username/Documents/claude-data"

# Network drive
export CLAUDE_CONFIG_DIR="/mnt/shared/claude-usage"
```

### Multiple Custom Paths

Specify multiple directories separated by commas:

```bash
# Multiple installations
export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"

# Current and archived data
export CLAUDE_CONFIG_DIR="~/.claude,/backup/claude-archive"

# Team member data aggregation
export CLAUDE_CONFIG_DIR="/team/alice/.claude,/team/bob/.claude,/team/charlie/.claude"
```

When multiple paths are specified:

- ✅ **Data aggregation** - Usage from all paths is automatically combined
- ✅ **Automatic filtering** - Invalid or empty directories are silently skipped
- ✅ **Consistent reporting** - All reports show unified data across paths

## Default Path Detection

### Standard Locations

When `CLAUDE_CONFIG_DIR` is not set, ccusage searches these locations automatically:

1. **`~/.config/claude/projects/`** - New default (Claude Code v1.0.30+)
2. **`~/.claude/projects/`** - Legacy location (pre-v1.0.30)

### Version Compatibility

::: info Breaking Change
Claude Code v1.0.30 moved data from `~/.claude` to `~/.config/claude` without documentation. ccusage handles both locations automatically for seamless compatibility.
:::

#### Migration Scenarios

**Scenario 1: Fresh Installation**

```bash
# Claude Code v1.0.30+ - uses new location
ls ~/.config/claude/projects/

# ccusage automatically finds data
ccusage daily
```

**Scenario 2: Upgraded Installation**

```bash
# Old data still exists
ls ~/.claude/projects/

# New data in new location
ls ~/.config/claude/projects/

# ccusage combines both automatically
ccusage daily  # Shows data from both locations
```

**Scenario 3: Manual Migration**

```bash
# If you moved data manually
export CLAUDE_CONFIG_DIR="/custom/location/claude"
ccusage daily
```

## Path Structure Requirements

### Expected Directory Structure

ccusage expects this directory structure:

```
claude-data-directory/
├── projects/
│   ├── project-1/
│   │   ├── session-1/
│   │   │   ├── file1.jsonl
│   │   │   └── file2.jsonl
│   │   └── session-2/
│   │       └── file3.jsonl
│   └── project-2/
│       └── session-3/
│           └── file4.jsonl
```

### Validation

ccusage validates paths by checking:

- **Directory exists** and is readable
- **Contains `projects/` subdirectory**
- **Has JSONL files** in the expected structure

Invalid paths are automatically skipped with debug information available.

## Common Use Cases

### Multiple Claude Profiles

If you use multiple Claude profiles or installations:

```bash
# Work profile
export CLAUDE_CONFIG_DIR="/Users/username/.config/claude-work"

# Personal profile
export CLAUDE_CONFIG_DIR="/Users/username/.config/claude-personal"

# Combined analysis
export CLAUDE_CONFIG_DIR="/Users/username/.config/claude-work,/Users/username/.config/claude-personal"
```

### Team Environments

For team usage analysis:

```bash
# Individual analysis
export CLAUDE_CONFIG_DIR="/shared/claude-data/$USER"
ccusage daily

# Team aggregate
export CLAUDE_CONFIG_DIR="/shared/claude-data/alice,/shared/claude-data/bob"
ccusage monthly --breakdown
```

### Development vs Production

Separate environments:

```bash
# Development environment
export CLAUDE_CONFIG_DIR="/dev/claude-data"
ccusage daily --since 20250101

# Production environment
export CLAUDE_CONFIG_DIR="/prod/claude-data"
ccusage daily --since 20250101
```

### Historical Analysis

Analyzing archived or backup data:

```bash
# Current month
export CLAUDE_CONFIG_DIR="~/.config/claude"
ccusage monthly

# Compare with previous month backup
export CLAUDE_CONFIG_DIR="/backup/claude-2024-12"
ccusage monthly --since 20241201 --until 20241231

# Combined analysis
export CLAUDE_CONFIG_DIR="~/.config/claude,/backup/claude-2024-12"
ccusage monthly --since 20241201
```

## Shell Integration

### Setting Persistent Environment Variables

#### Bash/Zsh

Add to `~/.bashrc`, `~/.zshrc`, or `~/.profile`:

```bash
# Default Claude data directory
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"

# Or multiple directories
export CLAUDE_CONFIG_DIR="$HOME/.config/claude,$HOME/.claude"
```

#### Fish Shell

Add to `~/.config/fish/config.fish`:

```fish
# Default Claude data directory
set -gx CLAUDE_CONFIG_DIR "$HOME/.config/claude"

# Or multiple directories
set -gx CLAUDE_CONFIG_DIR "$HOME/.config/claude,$HOME/.claude"
```

### Temporary Path Override

For one-time analysis without changing environment:

```bash
# Temporary override for single command
CLAUDE_CONFIG_DIR="/tmp/claude-backup" ccusage daily

# Multiple commands with temporary override
(
  export CLAUDE_CONFIG_DIR="/archive/claude-2024"
  ccusage daily --json > 2024-report.json
  ccusage monthly --breakdown > 2024-monthly.txt
)
```

### Aliases and Functions

Create convenient aliases:

```bash
# ~/.bashrc or ~/.zshrc
alias ccu-work="CLAUDE_CONFIG_DIR='/work/claude' ccusage"
alias ccu-personal="CLAUDE_CONFIG_DIR='/personal/claude' ccusage"
alias ccu-archive="CLAUDE_CONFIG_DIR='/archive/claude' ccusage"

# Usage
ccu-work daily
ccu-personal monthly --breakdown
ccu-archive session --since 20240101
```

Or use functions for more complex setups:

```bash
# Function to analyze specific time periods
ccu-period() {
  local period=$1
  local path="/archive/claude-$period"

  if [[ -d "$path" ]]; then
    CLAUDE_CONFIG_DIR="$path" ccusage daily --since "${period}01" --until "${period}31"
  else
    echo "Archive not found: $path"
  fi
}

# Usage
ccu-period 202412  # December 2024
ccu-period 202501  # January 2025
```

## MCP Integration with Custom Paths

When using ccusage as an MCP server with custom paths:

### Claude Desktop Configuration

```json
{
	"mcpServers": {
		"ccusage": {
			"command": "ccusage",
			"args": ["mcp"],
			"env": {
				"CLAUDE_CONFIG_DIR": "/path/to/your/claude/data"
			}
		},
		"ccusage-archive": {
			"command": "ccusage",
			"args": ["mcp"],
			"env": {
				"CLAUDE_CONFIG_DIR": "/archive/claude-2024,/archive/claude-2025"
			}
		}
	}
}
```

This allows you to have multiple MCP servers analyzing different data sets.

## Troubleshooting Custom Paths

### Path Validation

Check if your custom path is valid:

```bash
# Test path manually
ls -la "$CLAUDE_CONFIG_DIR/projects/"

# Run with debug output
ccusage daily --debug
```

### Common Issues

#### Path Not Found

```bash
# Error: Directory doesn't exist
export CLAUDE_CONFIG_DIR="/nonexistent/path"
ccusage daily
# Result: No data found

# Solution: Verify path exists
ls -la /nonexistent/path
```

#### Permission Issues

```bash
# Error: Permission denied
export CLAUDE_CONFIG_DIR="/root/.claude"
ccusage daily  # May fail if no read permission

# Solution: Check permissions
ls -la /root/.claude
```

#### Multiple Paths Syntax

```bash
# Wrong: Using semicolon or space
export CLAUDE_CONFIG_DIR="/path1;/path2"  # ❌
export CLAUDE_CONFIG_DIR="/path1 /path2"  # ❌

# Correct: Using comma
export CLAUDE_CONFIG_DIR="/path1,/path2"  # ✅
```

#### Data Structure Issues

```bash
# Wrong structure
/custom/claude/
├── file1.jsonl  # ❌ Files in wrong location
└── data/
    └── file2.jsonl

# Correct structure
/custom/claude/
└── projects/
    └── project1/
        └── session1/
            └── file1.jsonl
```

### Debug Mode

Use debug mode to troubleshoot path issues:

```bash
ccusage daily --debug

# Shows:
# - Which paths are being searched
# - Which paths are valid/invalid
# - How many files are found in each path
# - Any permission or structure issues
```

## Performance Considerations

### Large Data Sets

When using multiple paths with large data sets:

```bash
# Filter by date to improve performance
ccusage daily --since 20250101 --until 20250131

# Use JSON output for programmatic processing
ccusage daily --json | jq '.[] | select(.totalCost > 10)'
```

### Network Paths

For network-mounted directories:

```bash
# Ensure network path is mounted
mount | grep claude-data

# Consider local caching for frequently accessed data
rsync -av /network/claude-data/ /local/cache/claude-data/
export CLAUDE_CONFIG_DIR="/local/cache/claude-data"
```

## Next Steps

After setting up custom paths:

- Learn about [Configuration](/guide/configuration) for additional options
- Explore [Cost Modes](/guide/cost-modes) for different calculation methods
- Set up [Live Monitoring](/guide/live-monitoring) with your custom data
