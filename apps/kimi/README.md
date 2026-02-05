<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/kimi</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@ccusage/kimi"><img src="https://socket.dev/api/badge/npm/package/@ccusage/kimi" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@ccusage/kimi"><img src="https://img.shields.io/npm/v/@ccusage/kimi?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@ccusage/kimi%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dt/@ccusage/kimi" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@ccusage/kimi"><img src="https://packagephobia.com/badge?p=@ccusage/kimi" alt="install size" /></a>
    <a href="https://deepwiki.com/ryoppippi/ccusage"><img src="https://img.shields.io/badge/DeepWiki-ryoppippi%2Fccusage-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki"></a>
    <a href="https://github.com/hesreallyhim/awesome-claude-code"><img src="https://awesome.re/mentioned-badge.svg" alt="Mentioned in Awesome Claude Code" /></a>
</p>

> Analyze <a href="https://www.moonshot.cn/">Kimi CLI</a> usage logs with the same reporting experience as <code>ccusage</code>.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/kimi@latest --help
bunx @ccusage/kimi@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/kimi
pnpx @ccusage/kimi

# Using deno (with security flags)
deno run -E -R=$HOME/.kimi/ -S=homedir npm:@ccusage/kimi@latest --help
```

> ⚠️ **Critical for bunx users**: Bun 1.2.x's bunx prioritizes binaries matching the package name suffix when given a scoped package. For `@ccusage/kimi`, it looks for a `kimi` binary in PATH first. If you have an existing `kimi` command installed, that will be executed instead. **Always use `bunx @ccusage/kimi@latest` with the version tag** to force bunx to fetch and run the correct package.

### Recommended: Shell Alias

Since `npx @ccusage/kimi@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias ccusage-kimi='bunx @ccusage/kimi@latest'
# fish:     alias ccusage-kimi 'bunx @ccusage/kimi@latest'

# Then simply run:
ccusage-kimi daily
ccusage-kimi monthly --json
```

> 💡 The CLI looks for Kimi session files under `KIMI_SHARE_DIR` (defaults to `~/.kimi`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @ccusage/kimi@latest daily

# Date range filtering
npx @ccusage/kimi@latest daily --since 20250911 --until 20250917

# JSON output for scripting
npx @ccusage/kimi@latest daily --json

# Monthly usage grouped by month
npx @ccusage/kimi@latest monthly

# Monthly JSON report for integrations
npx @ccusage/kimi@latest monthly --json

# Session-level detailed report
npx @ccusage/kimi@latest session

# Weekly usage grouped by week (ISO week format)
npx @ccusage/kimi@latest weekly

# Weekly JSON report
npx @ccusage/kimi@latest weekly --json
```

Useful environment variables:

- `KIMI_SHARE_DIR` – override the root directory that contains Kimi session folders (default: `~/.kimi`)
- `KIMI_MODEL_NAME` – specify the model name when config.toml cannot be read
- `LOG_LEVEL` – control logging verbosity (0 silent … 5 trace)

## Token Field Mapping

Kimi CLI's `wire.jsonl` format uses these token fields:

| Kimi Field             | Mapped To          | Description                       |
| ---------------------- | ------------------ | --------------------------------- |
| `input_other`          | Input (non-cached) | Tokens sent to model (cache miss) |
| `input_cache_read`     | Cached Input       | Tokens read from cache            |
| `input_cache_creation` | Input (non-cached) | Tokens used to create cache       |
| `output`               | Output             | Completion tokens                 |

Cost calculation uses hardcoded pricing for known Kimi models. If the model cannot be determined from `config.toml` or `KIMI_MODEL_NAME`, it falls back to "unknown" with zero pricing (usage still appears in reports).

## Features

- 📊 Responsive terminal tables shared with the `ccusage` CLI
- 💵 Hardcoded pricing for Kimi K2.5 and related models
- 🤖 Per-model token and cost aggregation, including cached token accounting
- 📅 Daily and monthly rollups with identical CLI options
- 📄 JSON output for further processing or scripting
- 🔍 Session-level reporting with work directory mapping

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
