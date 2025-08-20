# Directory Detection

ccusage automatically detects and manages Claude Code data directories.

## Default Directory Locations

ccusage automatically searches for Claude Code data in these locations:

- **`~/.config/claude/projects/`** - New default location (Claude Code v1.0.30+)
- **`~/.claude/projects/`** - Legacy location (pre-v1.0.30)

When no custom directory is specified, ccusage searches both locations and aggregates data from all valid directories found.

::: info Breaking Change
The directory change from `~/.claude` to `~/.config/claude` in Claude Code v1.0.30 was an undocumented breaking change. ccusage handles both locations automatically to ensure backward compatibility.
:::

## Search Priority

When `CLAUDE_CONFIG_DIR` environment variable is not set, ccusage searches in this order:

1. **Primary**: `~/.config/claude/projects/` (preferred for newer installations)
2. **Fallback**: `~/.claude/projects/` (for legacy installations)

Data from all valid directories is automatically combined.

## Custom Directory Configuration

### Single Custom Directory

Override the default search with a specific directory:

```bash
export CLAUDE_CONFIG_DIR="/custom/path/to/claude"
ccusage daily
```

### Multiple Directories

Aggregate data from multiple Claude installations:

```bash
export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"
ccusage daily
```

## Directory Structure

Claude Code stores usage data in a specific structure:

```
~/.config/claude/projects/
├── project-name-1/
│   ├── session-id-1.jsonl
│   ├── session-id-2.jsonl
│   └── session-id-3.jsonl
├── project-name-2/
│   └── session-id-4.jsonl
└── project-name-3/
    └── session-id-5.jsonl
```

Each:
- **Project directory** represents a different Claude Code project/workspace
- **JSONL file** contains usage data for a specific session
- **Session ID** in the filename matches the `sessionId` field within the file

## Troubleshooting

### No Data Found

If ccusage reports no data found:

```bash
# Check if directories exist
ls -la ~/.claude/projects/
ls -la ~/.config/claude/projects/

# Verify environment variable
echo $CLAUDE_CONFIG_DIR

# Test with explicit directory
export CLAUDE_CONFIG_DIR="/path/to/claude"
ccusage daily
```

### Permission Errors

```bash
# Check directory permissions
ls -la ~/.claude/
ls -la ~/.config/claude/

# Fix permissions if needed
chmod -R 755 ~/.claude/
chmod -R 755 ~/.config/claude/
```

### Wrong Directory Detection

```bash
# Force specific directory
export CLAUDE_CONFIG_DIR="/exact/path/to/claude"
ccusage daily

# Verify which directory is being used
LOG_LEVEL=4 ccusage daily
```

## Related Documentation

- [Environment Variables](/guide/environment-variables) - Configure with CLAUDE_CONFIG_DIR
- [Custom Paths](/guide/custom-paths) - Advanced path management
- [Configuration Overview](/guide/configuration) - Complete configuration guide