---
name: ccusage-typescript
description: Guides ccusage TypeScript package and tooling work. Use when editing apps/ccusage .ts/.js files, Vitest tests, Bun scripts, package launchers, schema tooling, or benchmark scripts.
paths:
  - 'apps/ccusage/**/*.ts'
  - 'apps/ccusage/**/*.js'
  - 'docs/**/*.ts'
  - 'scripts/**/*.ts'
globs: 'apps/ccusage/**/*.ts,apps/ccusage/**/*.js,docs/**/*.ts,scripts/**/*.ts'
---

# ccusage TypeScript

Use this skill for the remaining TypeScript and JavaScript package surface:

- `apps/ccusage/src/cli.ts` native binary launcher.
- `apps/ccusage/scripts/**` package, schema, benchmark, and native staging scripts.
- Vitest coverage for TypeScript package/tooling behavior.
- VitePress and root TypeScript configuration or scripts when the change is not docs-content-only.

Runtime CLI behavior belongs in Rust under `rust/crates/ccusage`. Do not add new
TypeScript adapter logic unless the user explicitly scopes work to the package
layer.

## Style

Use `typescript-style` for detailed TypeScript conventions. In this repo:

- Prefer `satisfies` and `as const satisfies` for typed literals, mocks, config objects, and table-driven cases.
- Avoid unsafe `as` assertions and especially `as any`.
- Use `.ts` extensions for local imports.
- Use Node path utilities for file paths.
- Use `logger.ts` instead of `console.log` in package code.
- Do not use dynamic imports, especially in Vitest blocks.
- Keep exports limited to values used outside the module.

## Vitest

Vitest remains relevant for the TypeScript package launcher, schema artifacts,
benchmark scripts, and docs/package tooling. Prefer Rust tests for production CLI
runtime behavior.

Read `references/vitest.md` for ccusage-specific Vitest patterns. Read
`../tdd/references/vitest-running-and-modifiers.md` for broader Vitest command
and modifier examples, and `../tdd/references/vitest-readability.md` for
behavior-focused assertion examples.

## Bun And Package Scripts

Use `bun-api-reference` before changing Bun runtime APIs such as `Bun.$`,
`Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.argv`, `Bun.stdout`,
`Bun.stderr`, or `Bun.stringWidth()`.

Use `bun-cpu-profile` for TypeScript launcher, benchmark, or packaging script
performance. Use `ccusage-rust-profile` for native CLI performance.

There is no TypeScript similarity skill in this repo. Use `ast-grep` or `rg` for
TypeScript duplication checks unless a dedicated similarity-ts workflow is
reintroduced.

## Validation

Run focused checks during iteration, then the normal root workflow before
finishing:

```sh
pnpm run test:vitest
pnpm run format
pnpm typecheck
pnpm run test
```
