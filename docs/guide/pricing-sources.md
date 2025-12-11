# Pricing Data Sources

ccusage supports multiple pricing data sources for accurate cost calculations. You can choose between LiteLLM, models.dev, or use both sources combined.

## Quick Start

### Command Line

Use the `--pricing-source` or `-p` option to select your pricing data source:

```bash
# Default mode (auto-merge LiteLLM and models.dev)
ccusage daily

# Explicitly specify auto mode
ccusage daily --pricing-source auto
ccusage daily -p auto

# Use LiteLLM only
ccusage daily --pricing-source litellm
ccusage daily -p litellm

# Use models.dev only
ccusage daily --pricing-source modelsdev
ccusage daily -p modelsdev
```

### Configuration File

Configure defaults in `.ccusage/ccusage.json` or `~/.config/claude/ccusage.json`:

```json
{
  "defaults": {
    "pricingSource": "auto"
  },
  "commands": {
    "daily": {
      "pricingSource": "litellm"
    },
    "monthly": {
      "pricingSource": "modelsdev"
    }
  }
}
```

## Data Sources

### `auto` (Default)

- Merges pricing data from LiteLLM and models.dev
- LiteLLM data takes precedence when a model exists in both sources
- Provides the most comprehensive model coverage
- **Recommended for most users**

### `litellm`

- Uses LiteLLM pricing data only
- Source: [github.com/BerriAI/litellm](https://github.com/BerriAI/litellm)
- Best for maintaining consistency with official LiteLLM pricing
- Includes major AI providers (Anthropic, OpenAI, Google, etc.)

### `modelsdev`

- Uses models.dev pricing data only
- Source: [models.dev/api.json](https://models.dev/api.json)
- Includes additional providers (Moonshot AI, LucidQuery, etc.)
- Best for using non-mainstream or regional models

## Supported Commands

All commands that calculate costs support the `--pricing-source` option:

- `ccusage daily`
- `ccusage weekly`
- `ccusage monthly`
- `ccusage session`
- `ccusage blocks`
- `ccusage blocks --live`

## Configuration Priority

Settings are applied in this order (highest to lowest priority):

1. Command-line argument (`--pricing-source`)
2. Command-specific config in config file
3. `defaults` section in config file
4. Default value: `auto`

## Offline Mode

When using offline mode (`--offline`), the `--pricing-source` setting is ignored and only pre-cached Claude model pricing data is used.

```bash
# In offline mode, --pricing-source is ignored
ccusage daily --offline --pricing-source modelsdev
# Actual behavior: Uses pre-cached LiteLLM Claude data
```

## Technical Details

### Price Format Conversion

models.dev uses "per million tokens" pricing, which ccusage automatically converts to "per token":

```
models.dev:  $3 per million tokens
Converted:   $0.000003 per token
```

### Model Matching

Different data sources use different naming conventions:

- LiteLLM: `anthropic/claude-sonnet-4-20250514`
- models.dev: `claude-sonnet-4-5`

ccusage automatically handles model name matching and prefix normalization.

## Examples

### Comparing Costs Across Sources

```bash
# View costs using LiteLLM data
ccusage daily --pricing-source litellm

# View costs using models.dev data
ccusage daily --pricing-source modelsdev

# View costs using merged data (recommended)
ccusage daily --pricing-source auto
```

### Per-Command Source Configuration

```json
{
  "defaults": {
    "pricingSource": "auto"
  },
  "commands": {
    "blocks": {
      "pricingSource": "litellm",
      "live": true
    },
    "daily": {
      "pricingSource": "modelsdev"
    }
  }
}
```

## Troubleshooting

### Pricing Data Fetch Failures

If a data source fails to fetch, ccusage automatically falls back:

1. `auto` mode: If models.dev fails, still uses LiteLLM data
2. `litellm` mode: If LiteLLM fails, attempts to use offline cache
3. `modelsdev` mode: If models.dev fails, returns an error

### Viewing Logs

Use the `LOG_LEVEL` environment variable to see detailed pricing data loading logs:

```bash
LOG_LEVEL=3 ccusage daily --pricing-source auto
```

This will display:
```
ℹ Fetching latest model pricing from LiteLLM...
ℹ Loaded pricing for 150 models
ℹ Fetching pricing data from models.dev...
ℹ Loaded pricing for 200 models from models.dev
ℹ Merged pricing data: 300 total models (LiteLLM: 150, models.dev: 200)
```

## Related Documentation

- [CLI Options](/guide/cli-options) - All available command-line options
- [Configuration Files](/guide/config-files) - Configuration file format
- [Cost Modes](/guide/cost-modes) - Cost calculation modes
- [Environment Variables](/guide/environment-variables) - Environment configuration

