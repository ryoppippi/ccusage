---
name: ccusage-development
description: Guides ccusage monorepo development. Use when editing packages, docs, shared configuration, bundled CLI packaging, dependencies, exports, or validation commands.
---

# ccusage Development

## Repository Shape

This is a monorepo. Check the nearest package-specific `CLAUDE.md` before editing a package:

- `apps/ccusage/CLAUDE.md` - main Claude Code usage CLI and library
- `docs/CLAUDE.md` - VitePress documentation site

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

This repo supports both the Nix/direnv environment and the ordinary `package.json` + `pnpm` workflow. Do not assume contributors use Nix. Prefer `pnpm` commands when they are sufficient.

When Nix-specific tools or environment variables matter, use the activated `direnv` environment; `direnv exec . <command>` is preferred for non-interactive one-offs.

Tools are managed by `flake.nix` and `package.json`. Use `comma` or `nix run` for one-off investigation when appropriate, but add recurring project tools to the repo instead:

- Add system/dev-shell CLIs to `flake.nix`, and include the matching `flake.lock` update in the same commit.
- Add JavaScript/TypeScript tools and scripts to `package.json`, and include the matching lockfile update in the same commit.
- Keep each tool addition independently revertable; do not commit a lockfile update without the manifest change that explains it.

## Code Style

- For Rust CLI work, use the `ccusage-rust` skill before editing `rust/crates/**`,
  native packaging behavior, or Rust pricing embedding. Use
  `ccusage-rust-profile` for Rust performance work.
- Keep Rust modules small and responsibility-focused. Prefer `pub(crate)` over
  broader visibility, avoid unnecessary `String` cloning in hot paths, and put
  unit tests beside the module they exercise.
- For TypeScript package/tooling code, use the `ccusage-typescript` skill and
  `typescript-style` before editing. Keep `satisfies` and `as const satisfies`
  guidance there instead of mixing TypeScript details into Rust workflow rules.
- Only export constants, functions, and types used by other modules.
- Keep internal-only files and helpers private where possible.
- Dependency additions go in `devDependencies` for bundled/private packages.

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

Use `ccusage-rust-profile` for native CLI performance optimization, Rust
profiling, hyperfine A/B comparisons, and branch-vs-main profiling. Use
`bun-cpu-profile` for TypeScript launcher, benchmark, or packaging scripts.

Use the `cmux-debug` skill when validating terminal rendering, responsive tables, long-running CLI output, or output that depends on real terminal geometry.

## Commit and PR Names

Use the `commit` skill for commit structure, Conventional Commits, scope selection, and detailed commit message requirements.

Use the `create-pr` skill after opening a PR or pushing follow-up commits so AI and human review comments are requested, inspected, answered, and incorporated through small revertible commits.
