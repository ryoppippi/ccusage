# Environment Variables

ccusage supports several environment variables for configuration and customization. Environment variables provide a way to configure ccusage without modifying command-line arguments or configuration files.

## CLAUDE_CONFIG_DIR

Specifies where ccusage should look for Claude Code data. This is the most important environment variable for ccusage.

### Single Directory

Set a single custom Claude data directory:

```bash
export CLAUDE_CONFIG_DIR="/path/to/your/claude/data"
ccusage daily
```

### Multiple Directories

Set multiple directories (comma-separated) to aggregate data from multiple sources:

```bash
export CLAUDE_CONFIG_DIR="/path/to/claude1,/path/to/claude2"
ccusage daily
```

When multiple directories are specified, ccusage automatically aggregates usage data from all valid locations.

### Default Behavior

When `CLAUDE_CONFIG_DIR` is not set, ccusage automatically searches in:
1. `~/.config/claude/projects/` (new default, Claude Code v1.0.30+)
2. `~/.claude/projects/` (legacy location, pre-v1.0.30)

Data from all valid directories is automatically combined.

::: info Directory Change
The directory change from `~/.claude` to `~/.config/claude` in Claude Code v1.0.30 was an undocumented breaking change. ccusage handles both locations automatically for backward compatibility.
:::

### Use Cases

#### Development Environment

```bash
# Set in your shell profile (.bashrc, .zshrc, config.fish)
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
```

#### Multiple Claude Installations

```bash
# Aggregate data from different Claude installations
export CLAUDE_CONFIG_DIR="$HOME/.claude,$HOME/.config/claude"
```

#### Team Shared Directory

```bash
# Use team-shared data directory
export CLAUDE_CONFIG_DIR="/team-shared/claude-data/$USER"
```

#### CI/CD Environment

```bash
# Use specific directory in CI pipeline
export CLAUDE_CONFIG_DIR="/ci-data/claude-logs"
ccusage daily --json > usage-report.json
```

## LOG_LEVEL

Controls the verbosity of log output. ccusage uses [consola](https://github.com/unjs/consola) for logging under the hood.

### Log Levels

| Level | Value | Description | Use Case |
|-------|-------|-------------|----------|
| Silent | `0` | Errors only | Scripts, piping output |
| Warn | `1` | Warnings and errors | CI/CD environments |
| Log | `2` | Normal logs | General use |
| Info | `3` | Informational logs (default) | Standard operation |
| Debug | `4` | Debug information | Troubleshooting |
| Trace | `5` | All operations | Deep debugging |

### Usage Examples

```bash
# Silent mode - only show results
LOG_LEVEL=0 ccusage daily

# Warning level - for CI/CD
LOG_LEVEL=1 ccusage monthly

# Debug mode - troubleshooting
LOG_LEVEL=4 ccusage session

# Trace everything - deep debugging
LOG_LEVEL=5 ccusage blocks
```

### Practical Applications

#### Clean Output for Scripts

```bash
# Get clean JSON output without logs
LOG_LEVEL=0 ccusage daily --json | jq '.summary.totalCost'
```

#### CI/CD Pipeline

```bash
# Show only warnings and errors in CI
LOG_LEVEL=1 ccusage daily --instances
```

#### Debugging Issues

```bash
# Maximum verbosity for troubleshooting
LOG_LEVEL=5 ccusage daily --debug
```

#### Piping Output

```bash
# Silent logs when piping to other commands
LOG_LEVEL=0 ccusage monthly --json | python analyze.py
```

## CCUSAGE_PROJECT_ALIASES

Configure custom display names for project directories. This is useful for replacing cryptic directory names with human-readable aliases.

### Format

Use comma-separated `raw-name=alias` pairs:

```bash
export CCUSAGE_PROJECT_ALIASES="long-project-name=Short Name,uuid-project=My Project"
```

### Examples

#### UUID Projects

Replace cryptic UUIDs with readable names:

```bash
# Without aliases
ccusage daily --instances
# Shows: a2cd99ed-a586-4fe4-8f59-b0026409ec09

# With aliases
export CCUSAGE_PROJECT_ALIASES="a2cd99ed-a586-4fe4-8f59-b0026409ec09=Production API"
ccusage daily --instances
# Shows: Production API
```

#### Long Directory Names

Shorten verbose directory names for better display:

```bash
export CCUSAGE_PROJECT_ALIASES="-Users-john-Development-my-app=My App"
ccusage daily --instances
```

#### Multiple Projects

Set aliases for multiple projects:

```bash
export CCUSAGE_PROJECT_ALIASES="project1=Frontend,project2=Backend,project3=Database"
ccusage session
```

### Automatic Formatting

ccusage automatically formats complex project names even without aliases:

**Automatic Cleanup:**
- Strips common directory prefixes
- Shortens long UUIDs to last two segments
- Extracts meaningful names from complex paths

**Examples:**
```
# Original → Formatted
-Users-phaedrus-Development-adminifi-edugakko-api--feature-ticket-002-configure-dependabot
→ configure-dependabot

a2cd99ed-a586-4fe4-8f59-b0026409ec09
→ 8f59-b0026409ec09

/Users/john/Development/my-app
→ my-app
```

**Priority Order:**
1. Custom aliases (via `CCUSAGE_PROJECT_ALIASES`)
2. Automatic formatting
3. Original name (fallback)

## Additional Environment Variables

### CCUSAGE_OFFLINE

Force offline mode by default:

```bash
export CCUSAGE_OFFLINE=1
ccusage daily  # Runs in offline mode
```

### NO_COLOR

Disable colored output (standard CLI convention):

```bash
export NO_COLOR=1
ccusage daily  # No color formatting
```

### FORCE_COLOR

Force colored output even when piping:

```bash
export FORCE_COLOR=1
ccusage daily | less -R  # Preserves colors
```

## Setting Environment Variables

### Temporary (Current Session)

```bash
# Set for single command
LOG_LEVEL=0 ccusage daily

# Set for current shell session
export CLAUDE_CONFIG_DIR="/custom/path"
ccusage daily
```

### Permanent (Shell Profile)

Add to your shell configuration file:

#### Bash (~/.bashrc)

```bash
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
export LOG_LEVEL=3
export CCUSAGE_PROJECT_ALIASES="project1=MyApp,project2=API"
```

#### Zsh (~/.zshrc)

```zsh
export CLAUDE_CONFIG_DIR="$HOME/.config/claude"
export LOG_LEVEL=3
export CCUSAGE_PROJECT_ALIASES="project1=MyApp,project2=API"
```

#### Fish (~/.config/fish/config.fish)

```fish
set -x CLAUDE_CONFIG_DIR "$HOME/.config/claude"
set -x LOG_LEVEL 3
set -x CCUSAGE_PROJECT_ALIASES "project1=MyApp,project2=API"
```

#### PowerShell (Profile.ps1)

```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.config\claude"
$env:LOG_LEVEL = "3"
$env:CCUSAGE_PROJECT_ALIASES = "project1=MyApp,project2=API"
```

## Precedence

Environment variables have lower precedence than command-line arguments but higher than configuration files:

1. **Command-line arguments** (highest priority)
2. **Environment variables**
3. **Configuration files**
4. **Built-in defaults** (lowest priority)

Example:
```bash
# Environment variable sets offline mode
export CCUSAGE_OFFLINE=1

# But command-line argument overrides it
ccusage daily --no-offline  # Runs in online mode
```

## Debugging

To see which environment variables are being used:

```bash
# Show all environment variables
env | grep -E "CLAUDE|CCUSAGE|LOG_LEVEL"

# Debug mode shows environment variable usage
LOG_LEVEL=4 ccusage daily --debug
```

## Related Documentation

- [Command-Line Options](/guide/cli-options) - CLI arguments and flags
- [Configuration Files](/guide/config-files) - JSON configuration files
- [Configuration Overview](/guide/configuration) - Complete configuration guide