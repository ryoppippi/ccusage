# Statusline Integration (Beta)

Display real-time usage statistics in your Claude Code status line.

## Overview

The `statusline` command provides a compact, real-time view of your Claude Code usage, designed to integrate with Claude Code's status line hooks. It shows:

- **Active model** - The Claude model you're currently using
- **Current session cost** - Cost for your active conversation session
- **Today's total cost** - Your cumulative spending for the current day
- **Current session block** - Cost and time remaining in your active 5-hour billing block
- **Token breakdown** - Input/output tokens in compact format
- **Context usage** - Percentage of context window used with color coding
- **Promotion indicator** - Active promotions (e.g., 2x off-peak)

## Setup

### Quick Setup (Recommended)

Run the setup command to automatically configure your Claude Code settings:

```bash
npx -y ccusage setup-statusline
```

This will:

- Detect the best package runner (`bun` or `npx`)
- Find your Claude Code settings file
- Write the statusline configuration automatically

**Options:**

```bash
# Preview changes without writing
npx -y ccusage setup-statusline --dry-run

# Overwrite existing configuration
npx -y ccusage setup-statusline --force

# Specify runner explicitly
npx -y ccusage setup-statusline --runner bun

# Configure options during setup
npx -y ccusage setup-statusline --visual-burn-rate emoji --cost-source both
```

### Manual Configuration

Add this to your `~/.claude/settings.json` or `~/.config/claude/settings.json`:

::: code-group

```json [bun x (Recommended)]
{
	"statusLine": {
		"type": "command",
		"command": "bun x ccusage statusline",
		"padding": 0
	}
}
```

```json [claude x]
{
	"statusLine": {
		"type": "command",
		"command": "BUN_BE_BUN=1 claude x ccusage statusline",
		"padding": 0
	}
}
```

```json [npx]
{
	"statusLine": {
		"type": "command",
		"command": "npx -y ccusage statusline",
		"padding": 0
	}
}
```

:::

::: tip claude x option
The `claude x` option requires the native version of Claude Code (not the npm version). If you installed Claude Code via npm, use the `bun x` or `npx` options instead.
:::

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
Opus 4 | $0.23 session · $1.23 today · $0.45 block 2h45m | $8.50/hr | ↑25K ↓3.2K | 12% ctx | 45m +23 -5 | ⚡2x
```

During peak hours, a countdown to off-peak is shown instead:

```
Opus 4 | $0.23 session · $1.23 today · $0.45 block 2h45m | $8.50/hr | ↑25K ↓3.2K | 12% ctx | 45m +23 -5 | ⚡2x in 2h15m 12d
```

When using `--cost-source both`, the session cost shows both Claude Code and ccusage calculations:

```
Opus 4 | ($0.25 cc / $0.23 ccusage) session · $1.23 today · $0.45 block 2h45m | ↑25K ↓3.2K | 12% ctx
```

### Components Explained

- **Model** (`Opus 4`): Currently active Claude model (bold)
- **Session Cost** (`$0.23 session`): Cost for the current conversation session in cyan (see [Cost Source Options](#cost-source-options) for different calculation modes)
- **Today's Cost** (`$1.23 today`): Total cost for the current day across all sessions in cyan
- **Session Block** (`$0.45 block 2h45m`): Current 5-hour block cost with remaining time
- **Burn Rate** (`$8.50/hr`): Current spending rate, separated by pipe for visual clarity
- **Input Tokens** (`↑25K`): Input tokens sent to the model in green, compact format (K/M)
- **Output Tokens** (`↓3.2K`): Output tokens from the model in magenta, compact format (K/M)
- **Context Usage** (`12% ctx`): Percentage of context window used:
  - Green text: Low usage (< 50% by default)
  - Yellow text: Medium usage (50-80% by default)
  - Red text: High usage (> 80% by default)
  - Uses Claude Code's [`context_window` data](https://code.claude.com/docs/en/statusline) when available for accurate token counts
- **Session Duration** (`45m`): How long the current session has been running (dim)
- **Lines Changed** (`+23 -5`): Lines added (green) and removed (red) during the session
- **Promotion** (`⚡2x`): Active promotion indicator — bold yellow during off-peak, with countdown during peak hours (`⚡2x in 2h15m`), and days remaining (`12d`)

When no active block exists:

```
Opus 4 | $0.00 session · $0.00 today · $0.00 block | ↑0 ↓0 | 0% ctx
```

### Color Scheme

| Element                      | Color       | Purpose                         |
| ---------------------------- | ----------- | ------------------------------- |
| Model name                   | Bold        | Visual anchor                   |
| Pipe separator               | Dim         | Reduces visual noise            |
| Cost values                  | Cyan        | Standard info color             |
| Labels (session/today/block) | Dim         | Secondary info                  |
| Dot separator (·)            | Dim         | Visual separation between costs |
| Remaining time               | Dim         | Supplementary info              |
| Input tokens (↑)             | Green       | Data flowing to model           |
| Output tokens (↓)            | Magenta     | Contrast to input               |
| Context (low)                | Green       | < 50%                           |
| Context (medium)             | Yellow      | 50-80%                          |
| Context (high)               | Red         | > 80%                           |
| Session duration             | Dim         | Background metric               |
| Lines added (+N)             | Green       | Matches git convention          |
| Lines removed (-N)           | Red         | Matches git convention          |
| Promotion (off-peak)         | Bold yellow | Active promotion                |
| Promotion (peak)             | Yellow      | Countdown to off-peak           |
| Promotion days remaining     | Dim         | Days until promotion ends       |

## Technical Details

The statusline command:

- Reads session information from stdin (provided by Claude Code hooks)
- Identifies the active 5-hour billing block
- Calculates real-time burn rates and projections
- Outputs a single line suitable for status bar display
- **Uses offline mode by default** for instant response times without network dependencies
- Can be configured to use online mode with `--no-offline` for latest pricing data

## Beta Notice

This feature is currently in **beta**. More customization options and features are coming soon:

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

- **Single cost modes** (`auto`, `ccusage`, `cc`): `$0.23 session`
- **Both mode**: `($0.25 cc / $0.23 ccusage) session`

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

- `off` (default): No visual indicators, only colored cost/hr in cost section
- `emoji`: Add emoji indicators
- `text`: Add text status in parentheses (Normal/Moderate/High)
- `emoji-text`: Combine both emoji and text indicators

**Status thresholds:**

- Normal (green): < 2,000 tokens/min
- Moderate (yellow): 2,000-5,000 tokens/min
- High (red): > 5,000 tokens/min

### Promotion Display

The statusline shows active Claude usage promotions (e.g., 2x off-peak capacity). By default (`--promotion-display auto`), it shows:

- **Off-peak hours**: `⚡2x 12d` — promotion active, with days remaining
- **Peak hours**: `⚡2x in 2h15m 12d` — countdown to when off-peak starts

**Promotion display modes (`--promotion-display`):**

- `auto` (default): Always show promotion when active, with countdown during peak hours
- `active-only`: Only show during off-peak hours (no countdown)
- `off`: Disable promotion display entirely

```bash
# Show countdown during peak (default)
bun x ccusage statusline --promotion-display auto

# Only show when off-peak is active
bun x ccusage statusline --promotion-display active-only

# Disable promotions
bun x ccusage statusline --no-show-promotions
```

### Session Activity

The statusline can display session duration and lines changed from Claude Code hook data.

**Session duration** shows how long the current session has been active (e.g., `45m`, `2h15m`).

**Lines changed** shows lines added and removed during the session in git-style format (e.g., `+23 -5`).

Both are enabled by default. To disable:

```bash
bun x ccusage statusline --no-show-session-duration --no-show-lines-changed
```

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
