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

## Output Format

The statusline displays a compact, single-line summary:

```
🤖 Opus | 💰 $0.23 session / $1.23 today / $0.45 block (2h 45m left) | 🔥 $0.12/hr | 🧠 25,000 (12%)
```

### Components Explained

- **Model** (`🤖 Opus`): Currently active Claude model
- **Session Cost** (`💰 $0.23 session`): Cost for the current conversation session
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

## Configuration

### Environment Variables

You can customize the context usage color thresholds using environment variables:

- `CCUSAGE_CONTEXT_LOW_THRESHOLD` - Percentage below which context usage is shown in green (default: 50)
- `CCUSAGE_CONTEXT_MEDIUM_THRESHOLD` - Percentage below which context usage is shown in yellow (default: 80)

**Validation and Safety Features:**
- Values are automatically clamped to the 0-100 range
- Non-numeric values fall back to defaults
- The `LOW` threshold must be less than the `MEDIUM` threshold; if not, both reset to defaults
- Invalid configurations gracefully fall back to safe defaults (50% and 80%)

For example:
```bash
export CCUSAGE_CONTEXT_LOW_THRESHOLD=60
export CCUSAGE_CONTEXT_MEDIUM_THRESHOLD=90
```

With these settings:
- Green: < 60%
- Yellow: 60-90%
- Red: > 90%

**Invalid Configuration Examples:**
```bash
# These will all fall back to defaults (50/80)
export CCUSAGE_CONTEXT_LOW_THRESHOLD=invalid   # Non-numeric
export CCUSAGE_CONTEXT_MEDIUM_THRESHOLD=150    # Clamped to 100, then reset due to ordering
export CCUSAGE_CONTEXT_LOW_THRESHOLD=90        # Would be >= MEDIUM (80), so both reset
export CCUSAGE_CONTEXT_MEDIUM_THRESHOLD=30     # Would be <= LOW (50), so both reset
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
- 🟢 Normal (Green): < 2,000 tokens/min
- ⚠️ Moderate (Yellow): 2,000-5,000 tokens/min  
- 🚨 High (Red): > 5,000 tokens/min

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
