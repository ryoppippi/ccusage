---
name: development
description: Guides ccusage monorepo development. Use when editing packages, docs, shared configuration, bundled CLI packaging, dependencies, exports, or validation commands.
---

# ccusage Development

## Repository Shape

This is a monorepo. Check the nearest package-specific `AGENTS.md` before editing a package:

- `apps/ccusage/AGENTS.md` - main Claude Code usage CLI and library
- `docs/AGENTS.md` - VitePress documentation site

The production CLI implementation is Rust-first under `rust/crates/ccusage`.
The `apps/ccusage` package now mainly provides npm metadata, a TypeScript bin
launcher, generated schema artifacts, benchmarks, and release packaging.

The canonical user-facing command is `ccusage` with agent subcommands:

```sh
ccusage daily
ccusage codex daily
ccusage opencode daily
ccusage amp daily
ccusage pi daily
```

Standalone agent wrapper packages have been removed. Prefer `ccusage <agent> ...` in docs, tests, examples, and new behavior, and do not reintroduce wrapper commands such as `ccusage-codex`, `ccusage-opencode`, `ccusage-amp`, or `ccusage-pi`.

Agent implementations live in the Rust CLI unless the work is specifically about
the remaining TypeScript package surface. Treat package runtime libraries as
bundled assets: add dependencies to each package's `devDependencies` unless the
user explicitly asks otherwise.

## Common Commands

Use root commands unless a narrower package command is more appropriate. Read `references/commands.md` for root and main CLI command examples.

`LOG_LEVEL` controls logging verbosity from `0` silent through `5` trace.

## Environment and Tooling

Read `references/environment-and-validation.md` for direnv, tool management,
generated skill target rules, and post-change checks.

## Code Style

- For Rust CLI work, use the `rust` skill before editing `rust/crates/**`,
  native packaging behavior, or Rust pricing embedding. Use
  `profile` for Rust performance work.
- Keep Rust modules small and responsibility-focused. Prefer `pub(crate)` over
  broader visibility, avoid unnecessary `String` cloning in hot paths, and put
  unit tests beside the module they exercise.
- For TypeScript package/tooling code, use the `typescript` skill before
  editing. Keep `satisfies` and `as const satisfies` guidance there instead of
  mixing TypeScript details into Rust workflow rules.
- Only export constants, functions, and types used by other modules.
- Keep internal-only files and helpers private where possible.
- Dependency additions go in `devDependencies` for bundled/private packages.

## Post-Change Workflow

Read `references/environment-and-validation.md` for formatting, typecheck, and
test commands.

## Performance and CLI Output

Use `profile` for native CLI performance optimization, Rust profiling,
hyperfine A/B comparisons, branch-vs-main profiling, TypeScript launchers,
benchmarks, and packaging scripts.

Use the `cmux-debug` skill when validating terminal rendering, responsive tables, long-running CLI output, or output that depends on real terminal geometry.

## Commit and PR Names

Use the `commit` skill for commit structure, Conventional Commits, scope selection, and detailed commit message requirements.

Use the `create-pr` skill after opening a PR or pushing follow-up commits so AI and human review comments are requested, inspected, answered, and incorporated through small revertible commits.
