---
name: testing
description: Guides ccusage Rust and Vitest tests. Use when adding or fixing cargo tests, CLI snapshots, Claude model pricing, LiteLLM compatibility, Vitest tests, or fixture-backed tests.
---

# ccusage Testing

Use the `tdd` skill for logic changes, Red-Green-Refactor workflow, focused
runner commands, Rust test syntax, and general test readability rules. This
skill owns ccusage-specific Rust and Vitest test rules: fixtures, adapter
coverage, pricing/model behavior, CLI output, schema artifacts, and package
tooling.

## Shared Rules

- Prefer behavior-focused tests over schema-shape tests unless schema
  normalization itself is the behavior.
- Avoid `try`/`catch` in tests for expected failures. Use native result,
  throwing, rejecting, or explicit failure assertions for the test framework.
- Avoid `if` branches inside test bodies. Split behaviors into separate tests or
  table-driven cases.
- Tests do not need to be DRY. Prefer repeated, explicit setup when duplication
  makes each behavior easier to read.
- Do not hoist one-off values out of tests when sharing them hides the behavior.
- Skipped local-data smoke tests are acceptable when real user log directories
  catch schema drift, but they must not fail on clean CI machines.

## Rust Tests

For repo-wide validation, prefer the package script because it runs Vitest and Rust tests together:

```sh
direnv exec . pnpm run test
```

Put Rust unit tests near the module they exercise with `#[cfg(test)] mod tests`.
When splitting a large module, move its tests with the code instead of leaving
unrelated tests in `main.rs`.

Read `references/rust.md` for fixture-backed parser, path discovery, SQLite
loading, dedupe, aggregation, pricing, CLI output parity, model, and readability
rules. For focused cargo commands, Red-Green-Refactor examples, Rust test
attributes, and syntax examples, read `../tdd/references/rust.md`.

## Vitest Tests

Read `references/vitest.md` for TypeScript package launcher, schema artifact,
benchmark script, docs/package tooling, and `fs-fixture` test rules.
