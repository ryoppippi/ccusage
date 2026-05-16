# CLAUDE.md

This file points agents at the right repo-local skills and keeps only the guidance that should always be visible.

## Skill Routing

Use these skills before working in this repository:

- `ccusage-development` - monorepo layout, bundled CLI packaging, commands, code style, dependency policy, and post-change checks.
- `ccusage-testing` - in-source Vitest patterns, fixtures, snapshots, Claude model names, and LiteLLM pricing test rules.
- `fs-fixture` - disposable filesystem trees for tests with `createFixture()` and local README lookup.
- `ccusage-agent-sources` - Claude Code, Codex, OpenCode, Amp, and pi-agent log locations, token mappings, cost rules, and CLI behavior.
- `ccusage-docs` - VitePress docs structure, screenshot placement, accessibility, and markdown linting conventions.
- `typescript-style` - TypeScript typing with `satisfies`, `as const satisfies`, and safer type suppressions.
- `byethrow` - `@praha/byethrow` Result-based error handling.
- `use-gunshi-cli` - Gunshi command definitions and CLI conventions.
- `bun-api-reference` - local Bun runtime API docs and type references under `node_modules/bun-types`.
- `tdd` - Red-Green-Refactor workflow for logic changes.
- `bun-cpu-profile` - Bun CPU profiling and branch-vs-main performance comparisons.
- `reduce-similarities` - AST-based duplicate TypeScript/JavaScript detection with similarity-ts.
- `cmux-debug` - terminal UI and responsive table verification in cmux.
- `pr-ai-review-workflow` - PR review loops with `gh`: request AI/code reviewers, wait for comments, reply to inline review comments, and push small follow-up commits.
- `fix-ci` - diagnose and fix failing GitHub Actions checks with `gh`, then push small follow-up commits.

## Monorepo Packages

Check the nearest package-specific `CLAUDE.md` before editing package code:

- `apps/ccusage/CLAUDE.md` - main Claude Code usage CLI and library
- `apps/codex/CLAUDE.md` - Codex usage tracking CLI
- `apps/opencode/CLAUDE.md` - OpenCode usage tracking CLI
- `apps/amp/CLAUDE.md` - Amp usage tracking CLI
- `apps/pi/CLAUDE.md` - pi-agent usage tracking CLI
- `docs/CLAUDE.md` - VitePress documentation site

## Always-On Reminders

- The canonical user-facing CLI is `ccusage` with agent subcommands such as `ccusage amp`, `ccusage codex`, `ccusage opencode`, and `ccusage pi`.
- Standalone agent binaries such as `ccusage-amp`, `ccusage-codex`, `ccusage-opencode`, and `ccusage-pi` are deprecated compatibility wrappers. Do not add new docs, tests, or features that promote them as the primary interface.
- Agent apps are still bundled runtime payloads. Put runtime libraries in each app's `devDependencies` unless explicitly requested otherwise. Deprecated wrapper packages may keep install-time dependencies such as `ccusage` in `dependencies`.
- Prefer tools provided by the Nix dev shell before falling back to ad hoc installs: `rg`, `fd`, `fzf`, `delta`, `dust`, `jq`, `gh`, `hyperfine`, `similarity`, `typos`, and `typos-lsp`. When a missing tool would be useful for repeated agent work in this repository, add it to `flake.nix`.
- Use `logger.ts` instead of `console.log`.
- Use `.ts` extensions for local imports.
- Do not use dynamic imports anywhere, especially in Vitest blocks.
- Vitest globals are enabled; use `describe`, `it`, `expect`, and `vi` without importing them.
- After code changes, run `pnpm run format`, `pnpm typecheck`, and `pnpm run test`.
- PR branches are squash-merged by default; prefer stacked, small, revertable follow-up commits over `git commit --amend` unless explicitly requested.
- Do what has been asked, nothing more. Do not proactively create documentation files unless explicitly requested.
