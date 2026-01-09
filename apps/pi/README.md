<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/pi</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@ccusage/pi"><img src="https://socket.dev/api/badge/npm/package/@ccusage/pi" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@ccusage/pi"><img src="https://img.shields.io/npm/v/@ccusage/pi?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@ccusage/pi%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dt/@ccusage/pi" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@ccusage/pi"><img src="https://packagephobia.com/badge?p=@ccusage/pi" alt="install size" /></a>
    <a href="https://deepwiki.com/ryoppippi/ccusage"><img src="https://img.shields.io/badge/DeepWiki-ryoppippi%2Fccusage-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki"></a>
</p>

> Unified Claude Max usage tracking across Claude Code and [pi-agent](https://github.com/badlogic/pi-mono) with the same reporting experience as <code>ccusage</code>.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/pi@latest --help
bunx @ccusage/pi@latest --help

# Alternative package runners
pnpm dlx @ccusage/pi
pnpx @ccusage/pi
```

### Recommended: Shell Alias

Since `npx @ccusage/pi@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias ccusage-pi='bunx @ccusage/pi@latest'
# fish:     alias ccusage-pi 'bunx @ccusage/pi@latest'

# Then simply run:
ccusage-pi daily
ccusage-pi monthly --json
```

> 💡 The CLI combines data from Claude Code (`~/.claude/projects/` or `~/.config/claude/projects/`) and pi-agent (`~/.pi/agent/sessions/`).

## Common Commands

```bash
# Daily combined usage (Claude Code + pi-agent)
npx @ccusage/pi@latest daily

# Monthly combined usage
npx @ccusage/pi@latest monthly

# Session-based usage
npx @ccusage/pi@latest session

# JSON output for scripting
npx @ccusage/pi@latest daily --json

# Custom pi-agent path
npx @ccusage/pi@latest daily --pi-path /path/to/sessions

# Filter by date range
npx @ccusage/pi@latest daily --since 2025-12-01 --until 2025-12-19
```

Useful environment variables:

- `PI_AGENT_DIR` – override the pi-agent sessions directory (defaults to `~/.pi/agent/sessions`)
- `CLAUDE_CONFIG_DIR` – override the Claude Code data directory
- `LOG_LEVEL` – control log verbosity (0 silent … 5 trace)

## What is pi-agent?

[Pi-agent](https://github.com/badlogic/pi-mono) is an alternative Claude coding agent from [shittycodingagent.ai](https://shittycodingagent.ai). It stores usage data in a similar JSONL format to Claude Code but in a different directory structure.

## Features

- 📊 **Combined Reports**: Unified view of Claude Code and pi-agent usage
- 🏷️ **Source Labels**: Clear labels (`[cc]` for Claude Code, `[pi]` for pi-agent)
- 📅 **Daily/Monthly/Session Reports**: Same reporting options as ccusage
- 💵 **Accurate Cost Calculation**: Uses LiteLLM pricing database
- 📄 **JSON Output**: Export data in structured JSON format with `--json`

## Data Sources

This package combines usage data from:

| Source      | Directory                                             | Label  |
| ----------- | ----------------------------------------------------- | ------ |
| Claude Code | `~/.claude/projects/` or `~/.config/claude/projects/` | `[cc]` |
| Pi-agent    | `~/.pi/agent/sessions/`                               | `[pi]` |

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
