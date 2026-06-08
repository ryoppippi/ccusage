---
name: typescript
description: Guides ccusage TypeScript and JavaScript work. Use before reading or editing .ts, .tsx, .js, or .jsx files, including package launchers, Vitest tests, Bun scripts, schemas, mocks, and typed fixtures.
paths:
  - '**/*.ts'
  - '**/*.tsx'
  - '**/*.js'
  - '**/*.jsx'
globs: '*.ts,*.tsx,*.js,*.jsx'
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

Read `references/style.md` before editing TypeScript or JavaScript. In this
repo:

- Prefer `satisfies` and `as const satisfies` for typed literals, mocks, config objects, and table-driven cases.
- Avoid unsafe `as` assertions and especially `as any`.
- Use `.ts` extensions for local imports.
- Use Node path utilities for file paths.
- Use `logger.ts` instead of `console.log` in package code.
- Do not use dynamic imports, especially in Vitest blocks.
- Keep exports limited to values used outside the module.

## Vitest

Use `testing` and read `testing/references/vitest.md` for ccusage-specific
Vitest patterns. Prefer Rust tests for production CLI runtime behavior.

## Bun And Package Scripts

Use `bun-api-reference` before changing Bun runtime APIs such as `Bun.$`,
`Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.argv`, `Bun.stdout`,
`Bun.stderr`, or `Bun.stringWidth()`.

Use `profile` for TypeScript launcher, benchmark, packaging script, or native
CLI performance work.

There is no TypeScript similarity skill in this repo. Use `ast-grep` or `rg` for
TypeScript duplication checks unless a dedicated similarity-ts workflow is
reintroduced.

## Validation

Run focused checks during iteration, then the normal root workflow before
finishing:

```sh
just test-vitest
just fmt
just typecheck
just test
```
