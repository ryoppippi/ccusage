<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/opencode</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@ccusage/opencode"><img src="https://socket.dev/api/badge/npm/package/@ccusage/opencode" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@ccusage/opencode"><img src="https://img.shields.io/npm/v/@ccusage/opencode?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@ccusage/opencode%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dt/@ccusage/opencode" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@ccusage/opencode"><img src="https://packagephobia.com/badge?p=@ccusage/opencode" alt="install size" /></a>
    <a href="https://deepwiki.com/ryoppippi/ccusage"><img src="https://img.shields.io/badge/DeepWiki-ryoppippi%2Fccusage-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki"></a>
</p>

> Analyze [OpenCode](https://github.com/AnishDe12020/opencode) (Claude Code fork) usage logs with the same reporting experience as <code>ccusage</code>.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/opencode@latest --help
bunx @ccusage/opencode@latest --help

# Alternative package runners
pnpm dlx @ccusage/opencode
pnpx @ccusage/opencode

# Using deno (with security flags)
deno run -E -R=$HOME/.local/share/opencode/ -S=homedir -N='raw.githubusercontent.com:443' npm:@ccusage/opencode@latest --help
```

### Recommended: Shell Alias

Since `npx @ccusage/opencode@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias ccusage-opencode='bunx @ccusage/opencode@latest'
# fish:     alias ccusage-opencode 'bunx @ccusage/opencode@latest'

# Then simply run:
ccusage-opencode daily
ccusage-opencode monthly --json
```

> 💡 The CLI looks for OpenCode usage data under `OPENCODE_DATA_DIR` (defaults to `~/.local/share/opencode`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @ccusage/opencode@latest daily

# Weekly usage grouped by ISO week
npx @ccusage/opencode@latest weekly

# Monthly usage grouped by month
npx @ccusage/opencode@latest monthly

# Session-level detailed report
npx @ccusage/opencode@latest session

# JSON output for scripting
npx @ccusage/opencode@latest daily --json

# Compact mode for screenshots/sharing
npx @ccusage/opencode@latest daily --compact
```

Useful environment variables:

- `OPENCODE_DATA_DIR` – override the OpenCode data directory (defaults to `~/.local/share/opencode`)
- `LOG_LEVEL` – control consola log verbosity (0 silent … 5 trace)

## Features

- 📊 **Daily Reports**: View token usage and costs aggregated by date
- 📅 **Weekly Reports**: View usage grouped by ISO week (YYYY-Www)
- 🗓️ **Monthly Reports**: View usage aggregated by month (YYYY-MM)
- 💬 **Session Reports**: View usage grouped by conversation sessions
- 📈 **Responsive Tables**: Automatic layout adjustment for terminal width
- 🤖 **Model Tracking**: See which Claude models you're using (Opus, Sonnet, Haiku, etc.)
- 💵 **Accurate Cost Calculation**: Uses LiteLLM pricing database to calculate costs from token data
- 🔄 **Cache Token Support**: Tracks and displays cache creation and cache read tokens separately
- 📄 **JSON Output**: Export data in structured JSON format with `--json`
- 📱 **Compact Mode**: Use `--compact` flag for narrow terminals, perfect for screenshots

## Cost Calculation

OpenCode stores `cost: 0` in message files, so this CLI calculates accurate costs from token usage data using the LiteLLM pricing database.

**Supported models**:
- ✅ Claude models (opus-4-5, haiku-4-5, sonnet-4-5, etc.) - Accurate pricing from LiteLLM
- ⚠️ Non-Claude models (grok-code, gpt-5.1-codex-max, glm-4.6) - May show $0.00 if not in LiteLLM database

## Data Location

OpenCode stores usage data in:
- **Messages**: `~/.local/share/opencode/storage/message/{sessionID}/msg_{messageID}.json`
- **Sessions**: `~/.local/share/opencode/storage/session/{projectHash}/{sessionID}.json`

Each message file contains token counts (`input`, `output`, `cache.read`, `cache.write`) and model information.

## Documentation

For detailed guides and examples, visit **[ccusage.com](https://ccusage.com/)**.

## Sponsors

### Featured Sponsor

Check out [ccusage: The Claude Code cost scorecard that went viral](https://www.youtube.com/watch?v=Ak6qpQ5qdgk)

<p align="center">
    <a href="https://www.youtube.com/watch?v=Ak6qpQ5qdgk">
        <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/ccusage_thumbnail.png" alt="ccusage: The Claude Code cost scorecard that went viral" width="600">
    </a>
</p>

<p align="center">
    <a href="https://github.com/sponsors/ryoppippi">
        <img src="https://cdn.jsdelivr.net/gh/ryoppippi/sponsors@main/sponsors.svg">
    </a>
</p>

## License

MIT © [@ryoppippi](https://github.com/ryoppippi)
