---
name: ccusage-development
description: Work in the ccusage monorepo with its unified ccusage command surface, bundled CLI packaging, pnpm commands, TypeScript style, exports, dependencies, and post-change validation workflow. Use when editing packages under apps/, packages/, docs/, or shared repository configuration.
---

# ccusage Development

## Repository Shape

This is a monorepo. Check the nearest package-specific `CLAUDE.md` before editing a package:

- `apps/ccusage/CLAUDE.md` - main Claude Code usage CLI and library
- `apps/codex/CLAUDE.md` - Codex usage tracking CLI
- `apps/opencode/CLAUDE.md` - OpenCode usage tracking CLI
- `apps/amp/CLAUDE.md` - Amp usage tracking CLI
- `apps/pi/CLAUDE.md` - pi-agent usage tracking CLI
- `docs/CLAUDE.md` - VitePress documentation site

The canonical user-facing command is `ccusage` with agent subcommands:

```sh
ccusage daily
ccusage codex daily
ccusage opencode daily
ccusage amp daily
ccusage pi daily
```

Standalone agent binaries such as `ccusage-codex`, `ccusage-opencode`, `ccusage-amp`, and `ccusage-pi` are deprecated compatibility wrappers. Keep backward compatibility where it already exists, but prefer `ccusage <agent> ...` in docs, tests, examples, and new behavior.

Agent apps are still bundled runtime payloads. Treat runtime libraries as bundled assets: add dependencies to each app's `devDependencies` unless the user explicitly asks otherwise. Deprecated wrapper packages are the exception: keep install-time dependencies such as `ccusage` in `dependencies` when the wrapper needs them after installation.

## Common Commands

Use root commands unless a narrower package command is more appropriate. Read `references/commands.md` for root and main CLI command examples.

`LOG_LEVEL` controls logging verbosity from `0` silent through `5` trace.

## Environment and Tooling

This repo supports both the Nix/direnv environment and the ordinary `package.json` + `pnpm` workflow. Do not assume contributors use Nix. Prefer `pnpm` commands when they are sufficient.

When Nix-specific tools or environment variables matter, use the activated `direnv` environment; `direnv exec . <command>` is preferred for non-interactive one-offs.

Tools are managed by `flake.nix` and `package.json`. Use `comma` or `nix run` for one-off investigation when appropriate, but add recurring project tools to the repo instead:

- Add system/dev-shell CLIs to `flake.nix`, and include the matching `flake.lock` update in the same commit.
- Add JavaScript/TypeScript tools and scripts to `package.json`, and include the matching lockfile update in the same commit.
- Keep each tool addition independently revertable; do not commit a lockfile update without the manifest change that explains it.

## Code Style

- Use TypeScript strict-mode patterns already present in the package.
- Prefer `satisfies` and `as const satisfies` over unsafe `as` assertions; use the `typescript-style` skill for details.
- Use `.ts` extensions for local imports.
- Use Node path utilities for file paths.
- Use `logger.ts` instead of `console.log`.
- Prefer `@praha/byethrow` Result patterns for functional error handling; use the `byethrow` skill for details.
- Use Gunshi for CLI commands; use the `use-gunshi-cli` skill for details.
- Only export constants, functions, and types used by other modules.
- Keep internal-only files and helpers private where possible.
- Dependency additions go in `devDependencies` for bundled/private packages, but keep install-time wrapper dependencies in `dependencies`.

## Post-Change Workflow

After code changes, run formatting first because it mutates files:

```sh
pnpm run format
```

Then run typecheck and tests. These may run in parallel if desired:

```sh
pnpm typecheck
pnpm run test
```

For package-local work, run the narrower package scripts during iteration when they are faster, then run the root workflow before finishing.

## Performance and CLI Output

Use the `bun-cpu-profile` skill for performance optimization, Bun CPU profiles, hyperfine A/B comparisons, and branch-vs-main profiling.

Use the `cmux-debug` skill when validating terminal rendering, responsive tables, long-running CLI output, or output that depends on real terminal geometry.

## Commit and PR Names

Use the `commit` skill for commit structure, Conventional Commits, scope selection, and detailed commit message requirements.

Use the `pr-ai-review-workflow` skill after opening a PR or pushing follow-up commits so AI and human review comments are requested, inspected, answered, and incorporated through small revertable commits.
