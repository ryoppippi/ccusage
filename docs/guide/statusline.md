# Statusline Integration (Beta) 🚀

Display real-time usage statistics in your Claude Code status line.

## Overview

The `statusline` command provides a compact, real-time view of your Claude Code usage, designed to integrate with Claude Code's status line hooks. It shows:

- 💬 **Current session cost** - Cost for your active conversation session
- 💰 **Today's total cost** - Your cumulative spending for the current day
- 🚀 **Current session block** - Cost and time remaining in your active 5-hour billing block
- 🔥 **Burn rate** - Token consumption rate with visual indicators
- 🤖 **Active model** - The Claude model you're currently using

## Setup

### Configure settings.json

Add this to your `~/.claude/settings.json` or `~/.config/claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun x ccusage statusline", // Use "npx -y ccusage statusline" if you prefer npm
    "padding": 0  // Optional: set to 0 to let status line go to edge
  }
}
```

By default, statusline uses **offline mode** with cached pricing data for optimal performance.

### Online Mode (Optional)

If you need the latest pricing data from LiteLLM API, you can explicitly enable online mode:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun x ccusage statusline --no-offline", // Fetches latest pricing from API
    "padding": 0
  }
}
```

### With Visual Burn Rate (Optional)

You can enhance the burn rate display with visual indicators:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun x ccusage statusline --visual-burn-rate emoji", // Add emoji indicators
    "padding": 0
  }
}
```

See [Visual Burn Rate](#visual-burn-rate) section for all available options.

### With Cost Source Options (Optional)

You can control how session costs are calculated and displayed:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun x ccusage statusline --cost-source both", // Show both CC and ccusage costs
    "padding": 0
  }
}
```

See [Cost Source Options](#cost-source-options) section for all available modes.

## Output Format

The statusline displays a compact, single-line summary:

```
🤖 Opus | 💰 $0.23 session / $1.23 today / $0.45 block (2h 45m left) | 🔥 $0.12/hr | 🧠 25,000 (12%)
```

When using `--cost-source both`, the session cost shows both Claude Code and ccusage calculations:

```
🤖 Opus | 💰 ($0.25 cc / $0.23 ccusage) session / $1.23 today / $0.45 block (2h 45m left) | 🔥 $0.12/hr | 🧠 25,000 (12%)
```

### Components Explained

- **Model** (`🤖 Opus`): Currently active Claude model
- **Session Cost** (`💰 $0.23 session`): Cost for the current conversation session (see [Cost Source Options](#cost-source-options) for different calculation modes)
- **Today's Cost** (`$1.23 today`): Total cost for the current day across all sessions
- **Session Block** (`$0.45 block (2h 45m left)`): Current 5-hour block cost with remaining time
- **Burn Rate** (`🔥 $0.12/hr`): Cost burn rate per hour with color-coded indicators:
  - Green text: Normal (< 2,000 tokens/min)
  - Yellow text: Moderate (2,000-5,000 tokens/min)
  - Red text: High (> 5,000 tokens/min)
  - Optional visual status indicators (see [Visual Burn Rate](#visual-burn-rate))
- **Context Usage** (`🧠 25,000 (12%)`): Shows input tokens with percentage of context limit:
  - Green text: Low usage (< 50% by default)
  - Yellow text: Medium usage (50-80% by default)
  - Red text: High usage (> 80% by default)

When no active block exists:
```
🤖 Opus | 💰 $0.00 session / $0.00 today / No active block
```

## Technical Details

The statusline command:
- Reads session information from stdin (provided by Claude Code hooks)
- Identifies the active 5-hour billing block
- Calculates real-time burn rates and projections
- Outputs a single line suitable for status bar display
- **Uses offline mode by default** for instant response times without network dependencies
- Can be configured to use online mode with `--no-offline` for latest pricing data

## Beta Notice

⚠️ This feature is currently in **beta**. More customization options and features are coming soon:

- Custom format templates
- Configurable burn rate thresholds
- Additional metrics display options
- Session-specific cost tracking

### Cost Source Options

The `--cost-source` option controls how session costs are calculated and displayed:

**Available modes:**

- `auto` (default): Prefer Claude Code's pre-calculated cost when available, fallback to ccusage calculation
- `ccusage`: Always calculate costs using ccusage's token-based calculation with LiteLLM pricing
- `cc`: Always use Claude Code's pre-calculated cost from session data
- `both`: Display both Claude Code and ccusage costs side by side for comparison

**Command-line usage:**

```bash
# Default auto mode
bun x ccusage statusline

# Always use ccusage calculation
bun x ccusage statusline --cost-source ccusage

# Always use Claude Code cost
bun x ccusage statusline --cost-source cc  

# Show both costs for comparison
bun x ccusage statusline --cost-source both
```

**Settings.json configuration:**

```json
{
  "statusLine": {
    "type": "command",
    "command": "bun x ccusage statusline --cost-source both",
    "padding": 0
  }
}
```

**When to use each mode:**

- **`auto`**: Best for most users, provides accurate costs with fallback reliability
- **`ccusage`**: When you want consistent calculation methods across all ccusage commands
- **`cc`**: When you trust Claude Code's cost calculations and want minimal processing
- **`both`**: For debugging cost discrepancies or comparing calculation methods

**Output differences:**

- **Single cost modes** (`auto`, `ccusage`, `cc`): `💰 $0.23 session`
- **Both mode**: `💰 ($0.25 cc / $0.23 ccusage) session`

## Configuration

### Context Usage Thresholds

You can customize the context usage color thresholds using command-line options or configuration files:

- `--context-low-threshold` - Percentage below which context usage is shown in green (default: 50)
- `--context-medium-threshold` - Percentage below which context usage is shown in yellow (default: 80)

**Validation and Safety Features:**
- Values are automatically validated to be integers in the 0-100 range
- The `LOW` threshold must be less than the `MEDIUM` threshold
- Invalid configurations will show clear error messages

**Command-line usage:**
```bash
bun x ccusage statusline --context-low-threshold 60 --context-medium-threshold 90
```

**Configuration file usage:**
You can also set these options in your configuration file. See the [Configuration Guide](/guide/configuration) for more details.

With these settings:
- Green: < 60%
- Yellow: 60-90%
- Red: > 90%

**Example usage in Claude Code settings:**
```json
{
  "command": "bun x ccusage statusline --context-low-threshold 60 --context-medium-threshold 90",
  "timeout": 5000
}
```

### Visual Burn Rate

You can enhance the burn rate display with visual status indicators using the `--visual-burn-rate` option:

```bash
# Add to your settings.json command
bun x ccusage statusline --visual-burn-rate emoji
```

**Available options:**

- `off` (default): No visual indicators, only colored text
- `emoji`: Add emoji indicators (🟢/⚠️/🚨) 
- `text`: Add text status in parentheses (Normal/Moderate/High)
- `emoji-text`: Combine both emoji and text indicators

**Examples:**

```bash
# Default (off)
🔥 $0.12/hr

# With emoji
🔥 $0.12/hr 🟢

# With text  
🔥 $0.12/hr (Normal)

# With both emoji and text
🔥 $0.12/hr 🟢 (Normal)
```

**Status Indicators:**
- 🟢 Normal (Green)
- ⚠️ Moderate (Yellow)
- 🚨 High (Red)

## Troubleshooting

### No Output Displayed

If the statusline doesn't show:
1. Verify `ccusage` is in your PATH
2. Check Claude Code logs for any errors
3. Ensure you have valid usage data in your Claude data directory

### Incorrect Costs

If costs seem incorrect:
- The command uses the same cost calculation as other ccusage commands
- Verify with `ccusage daily` or `ccusage blocks` for detailed breakdowns

## Related Commands

- [`blocks`](./blocks-reports.md) - Detailed 5-hour billing block analysis
- [`daily`](./daily-reports.md) - Daily usage reports
- [`session`](./session-reports.md) - Session-based usage analysis
