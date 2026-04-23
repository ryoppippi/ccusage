# Copilot CLI Overview

The `@ccusage/copilot` package analyzes [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) session usage, tracking token counts and costs across both Claude and GPT models.

## What is Copilot CLI?

GitHub Copilot CLI is a terminal-based AI coding agent that supports multiple model providers (Anthropic Claude, OpenAI GPT). The `@ccusage/copilot` package reads the local session data to give you a clear view of your usage.

## Installation & Launch

```bash
# Recommended - always include @latest
npx @ccusage/copilot@latest --help
bunx @ccusage/copilot@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/copilot --help
pnpx @ccusage/copilot --help
```

::: warning ⚠️ Critical for bunx users
Bun's bunx prioritizes binaries matching the package name suffix when given a scoped package. **Always use `bunx @ccusage/copilot@latest` with the version tag** to force bunx to fetch and run the correct package.
:::

### Recommended: Shell Alias

Since `npx @ccusage/copilot@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias for convenience:

```bash
# bash/zsh: alias ccusage-copilot='bunx @ccusage/copilot@latest'
# fish:     alias ccusage-copilot 'bunx @ccusage/copilot@latest'

# Then simply run:
ccusage-copilot daily
ccusage-copilot monthly --json
```

::: tip
After adding the alias to your shell config file (`.bashrc`, `.zshrc`, or `config.fish`), restart your shell or run `source` on the config file to apply the changes.
:::

## Commands

### Daily Report

```bash
ccusage-copilot daily              # Table output
ccusage-copilot daily --json       # JSON output
ccusage-copilot daily --compact    # Compact table for narrow terminals
```

### Monthly Report

```bash
ccusage-copilot monthly
ccusage-copilot monthly --json
```

### Session Report

```bash
ccusage-copilot session            # Grouped by session with repository context
ccusage-copilot session --json
```

## Pricing Modes

Use `--mode` to control how costs are calculated:

```bash
ccusage-copilot daily --mode premium    # Default: premium request pricing
ccusage-copilot daily --mode api        # API-equivalent pricing
```

### Premium Mode (Default)

Calculates cost using GitHub Copilot's premium request system: `premiumRequestCost × $0.04` (overage rate). The `requests.cost` field from Copilot data already includes model multipliers (e.g., Opus 4.7 = 7.5×, Sonnet = 1×, Haiku = 0.33×).

### API Mode

Calculates the hypothetical cost if the same tokens were used through Anthropic/OpenAI APIs directly. Uses official pricing from LiteLLM's pricing database. Useful for understanding the value of your Copilot subscription.

::: info
JSON output always includes both `premiumCostUSD` and `apiCostUSD` regardless of selected mode.
:::

## Data Source

Copilot CLI stores session data at `~/.copilot/session-state/`. Each session directory contains an `events.jsonl` file with JSON Lines events. Usage data is extracted from:

- **`session.start`** — Session metadata (cwd, repository, branch, copilotVersion)
- **`session.shutdown`** — Per-model aggregated token metrics (inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, premium request counts)

## Additional Options

### Date Filtering

```bash
ccusage-copilot daily --since 2026-04-01 --until 2026-04-30
ccusage-copilot monthly --since 2026-04 --until 2026-04
```

Accepts `YYYY-MM`, `YYYY-MM-DD`, or `YYYYMMDD` format. For monthly reports, dates are filtered at day granularity before grouping by month.

### Timezone

```bash
ccusage-copilot daily --timezone America/New_York
ccusage-copilot daily -z Asia/Kolkata
```

Controls which calendar day/month events are grouped into. Defaults to your system timezone.

### Sort Order

```bash
ccusage-copilot daily --order desc    # Most recent first
ccusage-copilot session --order asc   # Oldest first (default)
```

### Model Breakdown

```bash
ccusage-copilot daily --breakdown --mode api
```

Shows per-model token and cost breakdown beneath each row.

### Offline Pricing

```bash
ccusage-copilot daily --mode api --offline
```

Uses build-time cached pricing data instead of fetching from LiteLLM.

### Color Control

```bash
ccusage-copilot daily --color        # Force colors
ccusage-copilot daily --no-color     # Disable colors
```

Colors are auto-detected by default. Also respects `FORCE_COLOR=1` and `NO_COLOR=1` environment variables.

## Supported Models

The package supports all models available in Copilot CLI:

- **Claude**: claude-haiku-4.5, claude-sonnet-4/4.5/4.6, claude-opus-4.5/4.6/4.6-1m/4.7
- **GPT**: gpt-5.1, gpt-5.2, gpt-5.4
- **Other**: goldeneye

Model names are automatically normalized for LiteLLM pricing lookup:
- Dot-to-dash conversion: `claude-opus-4.6` → `claude-opus-4-6`
- Variant suffix removal: `claude-opus-4.6-1m` → `claude-opus-4-6`

## Environment Variables

| Variable             | Description                            | Default      |
| -------------------- | -------------------------------------- | ------------ |
| `COPILOT_CONFIG_DIR` | Override Copilot data directory        | `~/.copilot` |
| `LOG_LEVEL`          | Logging verbosity (0=silent … 5=trace) | —            |
