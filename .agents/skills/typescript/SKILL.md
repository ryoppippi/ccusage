---
name: typescript
description: Guides ccusage TypeScript and JavaScript work. Use before reading or editing .ts, .tsx, .js, or .jsx files, including package launchers, Node tests, schemas, mocks, and typed fixtures.
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
- Node test coverage for TypeScript package/tooling behavior.
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
- Do not use dynamic imports.
- Keep exports limited to values used outside the module.

## Node Tests

Use `testing` and read `testing/references/node-test.md` for ccusage-specific
Node test patterns. Prefer Rust tests for production CLI runtime behavior.

## Package Scripts

Use `profile` for TypeScript launcher, benchmark, packaging script, or native
CLI performance work.

There is no TypeScript similarity skill in this repo. Use `ast-grep` or `rg` for
TypeScript duplication checks unless a dedicated similarity-ts workflow is
reintroduced.

## Validation

Run focused checks during iteration, then the normal root workflow before
finishing:

```sh
just test-node
just fmt
just typecheck
just test
```
