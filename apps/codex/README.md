<div align="center">
    <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/logo.svg" alt="better-ccusage logo" width="256" height="256">
    <h1>@better-ccusage/codex</h1>
</div>

<p align="center">
    <a href="https://socket.dev/api/npm/package/@better-ccusage/codex"><img src="https://socket.dev/api/badge/npm/package/@better-ccusage/codex" alt="Socket Badge" /></a>
    <a href="https://npmjs.com/package/@better-ccusage/codex"><img src="https://img.shields.io/npm/v/@better-ccusage/codex?color=yellow" alt="npm version" /></a>
    <a href="https://tanstack.com/stats/npm?packageGroups=%5B%7B%22packages%22:%5B%7B%22name%22:%22@better-ccusage/codex%22%7D%5D%7D%5D&range=30-days&transform=none&binType=daily&showDataMode=all&height=400"><img src="https://img.shields.io/npm/dy/@better-ccusage/codex" alt="NPM Downloads" /></a>
    <a href="https://packagephobia.com/result?p=@better-ccusage/codex"><img src="https://packagephobia.com/badge?p=@better-ccusage/codex" alt="install size" /></a>
    <a href="https://deepwiki.com/cobra91/better-ccusage"></a>
</p>

<div align="center">
  <img src="https://cdn.jsdelivr.net/gh/cobra91/better-ccusage@main/docs/public/codex-cli.jpeg" alt="Codex CLI usage screenshot" width="640">
</div>

> Analyze <a href="https://github.com/openai/codex">OpenAI Codex CLI</a> usage logs with the same reporting experience as <code>better-ccusage</code>.

> ⚠️ <strong>Beta:</strong> The Codex CLI support is experimental. Expect breaking changes until the upstream Codex tooling stabilizes.

## Quick Start

```bash
# Recommended - always include @latest
npx @better-ccusage/codex@latest --help
bunx @better-ccusage/codex@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @better-ccusage/codex
pnpx @better-ccusage/codex

# Using deno (with security flags)
deno run -E -R=$HOME/.codex/ -S=homedir -N='raw.githubusercontent.com:443' npm:@better-ccusage/codex@latest --help
```

> ⚠️ **Critical for bunx users**: Bun 1.2.x's bunx prioritizes binaries matching the package name suffix when given a scoped package. For `@better-ccusage/codex`, it looks for a `codex` binary in PATH first. If you have an existing `codex` command installed (e.g., GitHub Copilot's codex), that will be executed instead. **Always use `bunx @better-ccusage/codex@latest` with the version tag** to force bunx to fetch and run the correct package.

### Recommended: Shell Alias

Since `npx @better-ccusage/codex@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias:

```bash
# bash/zsh: alias better-ccusage-codex='bunx @better-ccusage/codex@latest'
# fish:     alias better-ccusage-codex 'bunx @better-ccusage/codex@latest'

# Then simply run:
better-ccusage-codex daily
better-ccusage-codex monthly --json
```

> 💡 The CLI looks for Codex session JSONL files under `CODEX_HOME` (defaults to `~/.codex`).

## Common Commands

```bash
# Daily usage grouped by date (default command)
npx @better-ccusage/codex@latest daily

# Date range filtering
npx @better-ccusage/codex@latest daily --since 20250911 --until 20250917

# JSON output for scripting
npx @better-ccusage/codex@latest daily --json

# Monthly usage grouped by month
npx @better-ccusage/codex@latest monthly

# Monthly JSON report for integrations
npx @better-ccusage/codex@latest monthly --json

# Session-level detailed report
npx @better-ccusage/codex@latest sessions
```

Useful environment variables:

- `CODEX_HOME` – override the root directory that contains Codex session folders
- `LOG_LEVEL` – controla consola log verbosity (0 silent … 5 trace)

ℹ️ The CLI now relies on the model metadata recorded in each `turn_context`. Sessions emitted during early September 2025 that lack this metadata are skipped to avoid mispricing. Newer builds of the Codex CLI restore the model field, and aliases such as `gpt-5-codex` automatically resolve to the correct pricing entry.
📦 For legacy JSONL files that never emitted `turn_context` metadata, the CLI falls back to treating the tokens as `gpt-5` so that usage still appears in reports (pricing is therefore approximate for those sessions). In JSON output you will also see `"isFallback": true` on those model entries.

## Features

- 📊 Responsive terminal tables shared with the `better-ccusage` CLI
- 💵 Offline-first pricing cache with automatic refresh when needed
- 🤖 Per-model token and cost aggregation, including cached token accounting
- 📅 Daily and monthly rollups with identical CLI options
- 📄 JSON output for further processing or scripting

## Documentation

For detailed guides and examples, visit **[better-ccusage.com/guide/codex](https://better-ccusage.com/guide/codex/)**.

## Sponsors

<p align="center">
    <a href="https://github.com/sponsors/cobra91">
        Cobra91
    </a>
</p>

## License

MIT © [@cobra91](https://github.com/cobra91)
