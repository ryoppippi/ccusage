<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/copilot</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@ccusage/copilot"><img src="https://socket.dev/api/badge/npm/package/@ccusage/copilot" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@ccusage/copilot"><img src="https://img.shields.io/npm/v/@ccusage/copilot?color=yellow" alt="npm version" /></a>
    <a href="https://packagephobia.com/result?p=@ccusage/copilot"><img src="https://packagephobia.com/badge?p=@ccusage/copilot" alt="install size" /></a>
    <a href="https://deepwiki.com/ryoppippi/ccusage"><img src="https://img.shields.io/badge/DeepWiki-ryoppippi%2Fccusage-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki"></a>
</p>

> Analyze [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) usage logs with the same reporting experience as `ccusage`.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/copilot@latest --help
bunx @ccusage/copilot@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/copilot
pnpx @ccusage/copilot
```

### Recommended: Shell Alias

Since `npx @ccusage/copilot@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias ccusage-copilot='bunx @ccusage/copilot@latest'
# fish:     alias ccusage-copilot 'bunx @ccusage/copilot@latest'

# Then simply run:
ccusage-copilot daily
ccusage-copilot monthly --json
```

## Usage

```bash
# Daily usage report (default command)
ccusage-copilot daily

# Monthly summary
ccusage-copilot monthly

# Per-session breakdown
ccusage-copilot session

# JSON output
ccusage-copilot daily --json

# Compact table for narrow terminals
ccusage-copilot daily --compact

# Filter by date range
ccusage-copilot daily --since 2026-04-01 --until 2026-04-30

# Reverse sort order
ccusage-copilot daily --order desc

# Show per-model breakdown
ccusage-copilot daily --breakdown --mode api

# Use specific timezone
ccusage-copilot daily --timezone America/New_York

# Use cached pricing (offline)
ccusage-copilot daily --mode api --offline
```

## Pricing Modes

Use `--mode` to control how costs are calculated:

```bash
# Premium request pricing (default) — what you actually pay on Copilot
ccusage-copilot daily --mode premium

# API-equivalent pricing — what it would cost at Anthropic/OpenAI API rates
ccusage-copilot daily --mode api
```

- **`premium`** (default): Uses GitHub Copilot's premium request counts × $0.04 (overage rate). The `requests.cost` field already includes model multipliers.
- **`api`**: Calculates hypothetical costs using official Anthropic/OpenAI API rates via LiteLLM. Useful for understanding the value of your Copilot subscription.

JSON output always includes both `premiumCostUSD` and `apiCostUSD` regardless of selected mode.

## Data Source

Copilot CLI stores session data at:

```text
~/.copilot/
  session-state/
    {sessionId}/              # UUID directory per session
      events.jsonl            # JSON Lines event stream
      workspace.yaml          # session metadata
```

## Environment Variables

- `COPILOT_CONFIG_DIR` — override the base Copilot directory (default: `~/.copilot`)
- `LOG_LEVEL` — control logging verbosity (0=silent … 5=trace)

## Related

Part of the [ccusage](https://github.com/ryoppippi/ccusage) family:

- [`ccusage`](https://www.npmjs.com/package/ccusage) — Claude Code usage
- [`@ccusage/codex`](https://www.npmjs.com/package/@ccusage/codex) — OpenAI Codex usage
- [`@ccusage/opencode`](https://www.npmjs.com/package/@ccusage/opencode) — OpenCode usage
- [`@ccusage/pi`](https://www.npmjs.com/package/@ccusage/pi) — Pi-agent usage
- [`@ccusage/amp`](https://www.npmjs.com/package/@ccusage/amp) — Amp usage
- [`@ccusage/copilot`](https://www.npmjs.com/package/@ccusage/copilot) — GitHub Copilot CLI usage
