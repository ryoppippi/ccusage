# CLAUDE.md

This file points agents at the right repo-local skills and keeps only the guidance that should always be visible.

## Skill Routing

Use these skills before working in this repository:

- `ccusage-development` - monorepo layout, bundled CLI packaging, commands, code style, dependency policy, and post-change checks.
- `ccusage-rust` - native Rust CLI implementation, parser/module layout, pricing embedding, and TypeScript parity checks.
- `ccusage-rust-profile` - native Rust CLI profiling, branch-vs-main speed comparisons, profile reading, and optimization validation.
- `ccusage-testing` - Rust cargo tests, CLI snapshots, Claude model names, and LiteLLM pricing test rules.
- `ccusage-typescript` - TypeScript package/tooling work, Vitest tests, Bun scripts, package launchers, schema tooling, and benchmark scripts.
- `fs-fixture` - disposable filesystem trees for tests with `createFixture()` and local README lookup.
- `ccusage-agent-sources` - agent adapter log locations, token mappings, cost rules, and CLI behavior.
- `ccusage-docs` - VitePress docs structure, screenshot placement, accessibility, and markdown linting conventions.
- `skill-creator` - repo-local skill creation, SKILL.md frontmatter, description trigger quality, and reference layout.
- `typescript-style` - required before reading or editing `.ts`, `.tsx`, `.js`, or `.jsx`; covers typing, `satisfies`, safe suppressions, and library-specific guidance for arkregex, byethrow, and Gunshi.
- `ast-grep` - structural code searches in Rust or TypeScript and AST-based migration verification with the dev-shell `ast-grep` CLI.
- `bun-api-reference` - local Bun runtime API docs and type references under `node_modules/bun-types`.
- `tdd` - Red-Green-Refactor workflow for logic changes.
- `bun-cpu-profile` - Bun/TypeScript profiling for package scripts; use `ccusage-rust-profile` for native CLI performance work.
- `reduce-similarities` - AST-based duplicate Rust code detection with similarity-rs; TypeScript duplication checks use `ccusage-typescript` and `ast-grep`.
- `cmux-debug` - terminal UI and responsive table verification in cmux.
- `create-pr` - single entry point for PR work, from branch creation through AI review requests, review-thread replies, and passing CI.
- `fix-ci` - diagnose and fix failing GitHub Actions checks with `gh`, then push small follow-up commits.

## Monorepo Packages

Check the nearest package-specific `CLAUDE.md` before editing package code:

- `apps/ccusage/CLAUDE.md` - main Claude Code usage CLI and library
- `docs/CLAUDE.md` - VitePress documentation site

## Always-On Reminders

- The canonical user-facing CLI is `ccusage` with agent subcommands such as `ccusage amp`, `ccusage codex`, `ccusage opencode`, and `ccusage pi`.
- Standalone agent wrapper packages have been removed. Do not add docs, tests, or features that promote `ccusage-amp`, `ccusage-codex`, `ccusage-opencode`, or `ccusage-pi`.
- Runtime libraries for bundled packages belong in `devDependencies` unless explicitly requested otherwise.
- Prefer tools provided by the Nix dev shell before falling back to ad hoc installs: `rg`, `fd`, `fzf`, `delta`, `dust`, `jq`, `gh`, `hyperfine`, `similarity`, `ast-grep`, `typos`, and `typos-lsp`. When a missing tool would be useful for repeated agent work in this repository, add it to `flake.nix`.
- The production CLI is Rust-first under `rust/crates/ccusage`. Put new runtime behavior there unless the work is specifically about npm packaging, generated schemas, docs tooling, or benchmark scripts.
- For Rust code, keep modules small, keep `pub(crate)` surfaces narrow, prefer fixture-backed parser/loader tests, and run cargo checks through the root package scripts when possible.
- TypeScript rules still apply to `.ts`, `.tsx`, `.js`, and `.jsx` package/tooling files. Use `ccusage-typescript` and `typescript-style` there, especially `satisfies` and `as const satisfies` for typed literals.
- For TypeScript package code, use `logger.ts` instead of `console.log`, use `.ts` extensions for local imports, avoid dynamic imports, and use Vitest globals without importing them.
- After code changes, run `pnpm run format`, `pnpm typecheck`, and `pnpm run test`.
- PR branches are squash-merged by default; prefer stacked, small, revertable follow-up commits over `git commit --amend` unless explicitly requested.
- Use US English for repository-facing GitHub communication, including issue comments, PR descriptions, review replies, triage notes, and bot-directed replies.
- Do what has been asked, nothing more. Do not proactively create documentation files unless explicitly requested.
