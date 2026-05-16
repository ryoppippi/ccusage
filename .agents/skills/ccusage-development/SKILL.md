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

Agent apps are still bundled runtime payloads. Treat runtime libraries as bundled assets: add dependencies to each app's `devDependencies` unless the user explicitly asks otherwise.

## Common Commands

Use root commands unless a narrower package command is more appropriate:

```sh
pnpm run test
pnpm run format
pnpm typecheck
pnpm run build
pnpm run prerelease
```

Useful main CLI commands:

```sh
pnpm run start daily
pnpm run start monthly
pnpm run start session
pnpm run start blocks
pnpm run start statusline
pnpm run start daily --json
pnpm run start daily --mode auto
pnpm run start blocks --active
pnpm run start blocks --recent
pnpm run start blocks --token-limit max
```

`LOG_LEVEL` controls logging verbosity from `0` silent through `5` trace.

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
- Dependency additions go in `devDependencies` unless explicitly requested otherwise.

## Post-Change Workflow

After code changes, run these in parallel:

```sh
pnpm run format
pnpm typecheck
pnpm run test
```

For package-local work, run the narrower package scripts during iteration when they are faster, then run the root workflow before finishing.

## Commit and PR Names

Use the `commit` skill for commit structure, Conventional Commits, scope selection, and detailed commit message requirements.

Use the `pr-ai-review-workflow` skill after opening a PR or pushing follow-up commits so AI and human review comments are requested, inspected, answered, and incorporated through small revertable commits.
