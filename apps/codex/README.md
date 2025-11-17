<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.svg" alt="ccusage logo" width="256" height="256">
    <h1>@ccusage/codex</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@ccusage/codex"><img src="https://socket.dev/api/badge/npm/package/@ccusage/codex" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@ccusage/codex"><img src="https://img.shields.io/npm/v/@ccusage/codex?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@ccusage/codex%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dt/@ccusage/codex" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@ccusage/codex"><img src="https://packagephobia.com/badge?p=@ccusage/codex" alt="install size" /></a>
    <a href="https://deepwiki.com/ryoppippi/ccusage"><img src="https://img.shields.io/badge/DeepWiki-ryoppippi%2Fccusage-blue.svg?logo=data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACwAAAAyCAYAAAAnWDnqAAAAAXNSR0IArs4c6QAAA05JREFUaEPtmUtyEzEQhtWTQyQLHNak2AB7ZnyXZMEjXMGeK/AIi+QuHrMnbChYY7MIh8g01fJoopFb0uhhEqqcbWTp06/uv1saEDv4O3n3dV60RfP947Mm9/SQc0ICFQgzfc4CYZoTPAswgSJCCUJUnAAoRHOAUOcATwbmVLWdGoH//PB8mnKqScAhsD0kYP3j/Yt5LPQe2KvcXmGvRHcDnpxfL2zOYJ1mFwrryWTz0advv1Ut4CJgf5uhDuDj5eUcAUoahrdY/56ebRWeraTjMt/00Sh3UDtjgHtQNHwcRGOC98BJEAEymycmYcWwOprTgcB6VZ5JK5TAJ+fXGLBm3FDAmn6oPPjR4rKCAoJCal2eAiQp2x0vxTPB3ALO2CRkwmDy5WohzBDwSEFKRwPbknEggCPB/imwrycgxX2NzoMCHhPkDwqYMr9tRcP5qNrMZHkVnOjRMWwLCcr8ohBVb1OMjxLwGCvjTikrsBOiA6fNyCrm8V1rP93iVPpwaE+gO0SsWmPiXB+jikdf6SizrT5qKasx5j8ABbHpFTx+vFXp9EnYQmLx02h1QTTrl6eDqxLnGjporxl3NL3agEvXdT0WmEost648sQOYAeJS9Q7bfUVoMGnjo4AZdUMQku50McDcMWcBPvr0SzbTAFDfvJqwLzgxwATnCgnp4wDl6Aa+Ax283gghmj+vj7feE2KBBRMW3FzOpLOADl0Isb5587h/U4gGvkt5v60Z1VLG8BhYjbzRwyQZemwAd6cCR5/XFWLYZRIMpX39AR0tjaGGiGzLVyhse5C9RKC6ai42ppWPKiBagOvaYk8lO7DajerabOZP46Lby5wKjw1HCRx7p9sVMOWGzb/vA1hwiWc6jm3MvQDTogQkiqIhJV0nBQBTU+3okKCFDy9WwferkHjtxib7t3xIUQtHxnIwtx4mpg26/HfwVNVDb4oI9RHmx5WGelRVlrtiw43zboCLaxv46AZeB3IlTkwouebTr1y2NjSpHz68WNFjHvupy3q8TFn3Hos2IAk4Ju5dCo8B3wP7VPr/FGaKiG+T+v+TQqIrOqMTL1VdWV1DdmcbO8KXBz6esmYWYKPwDL5b5FA1a0hwapHiom0r/cKaoqr+27/XcrS5UwSMbQAAAABJRU5ErkJggg==" alt="DeepWiki"></a>
</p>

<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/codex-cli.jpeg" alt="Codex CLI usage screenshot" width="640">
</div>

> Analyze <a href="https://github.com/openai/codex">OpenAI Codex CLI</a> usage logs with the same reporting experience as <code>ccusage</code>.

> ⚠️ <strong>Beta:</strong> The Codex CLI support is experimental. Expect breaking changes until the upstream Codex tooling stabilizes.

## Quick Start

```bash
# Recommended - always include @latest
npx @ccusage/codex@latest --help
bunx @ccusage/codex@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/codex
pnpx @ccusage/codex

# Using deno (with security flags)
deno run -E -R=$HOME/.codex/ -S=homedir -N='raw.githubusercontent.com:443' npm:@ccusage/codex@latest --help
```

> ⚠️ **Critical for bunx users**: Bun 1.2.x's bunx prioritizes binaries matching the package name suffix when given a scoped package. For `@ccusage/codex`, it looks for a `codex` binary in PATH first. If you have an existing `codex` command installed (e.g., GitHub Copilot's codex), that will be executed instead. **Always use `bunx @ccusage/codex@latest` with the version tag** to force bunx to fetch and run the correct package.

### Recommended: Shell Alias

Since `npx @ccusage/codex@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias ccusage-codex='bunx @ccusage/codex@latest'
# fish:     alias ccusage-codex 'bunx @ccusage/codex@latest'

# Then simply run:
ccusage-codex daily
ccusage-codex monthly --json
```

> 💡 The CLI looks for Codex session JSONL files under `CODEX_HOME` (defaults to `~/.codex`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @ccusage/codex@latest daily

# Date range filtering
npx @ccusage/codex@latest daily --since 20250911 --until 20250917

# JSON output for scripting
npx @ccusage/codex@latest daily --json

# Monthly usage grouped by month
npx @ccusage/codex@latest monthly

# Monthly JSON report for integrations
npx @ccusage/codex@latest monthly --json

# Session-level detailed report
npx @ccusage/codex@latest sessions
```

Useful environment variables:

- `CODEX_HOME` – override the root directory that contains Codex session folders
- `LOG_LEVEL` – controla consola log verbosity (0 silent … 5 trace)

ℹ️ The CLI now relies on the model metadata recorded in each `turn_context`. Sessions emitted during early September 2025 that lack this metadata are skipped to avoid mispricing. Newer builds of the Codex CLI restore the model field, and aliases such as `gpt-5-codex` automatically resolve to the correct LiteLLM pricing entry.
📦 For legacy JSONL files that never emitted `turn_context` metadata, the CLI falls back to treating the tokens as `gpt-5` so that usage still appears in reports (pricing is therefore approximate for those sessions). In JSON output you will also see `"isFallback": true` on those model entries.

## Features

- 📊 Responsive terminal tables shared with the `ccusage` CLI
- 💵 Offline-first pricing cache with automatic LiteLLM refresh when needed
- 🤖 Per-model token and cost aggregation, including cached token accounting
- 📅 Daily and monthly rollups with identical CLI options
- 📄 JSON output for further processing or scripting

## Documentation

For detailed guides and examples, visit **[ccusage.com/guide/codex](https://ccusage.com/guide/codex/)**.

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
