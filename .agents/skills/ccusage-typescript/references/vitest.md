# ccusage Vitest Reference

Use this reference for TypeScript package launcher, schema artifact, benchmark
script, and docs/package tooling tests. Production CLI runtime behavior should
prefer Rust tests through `ccusage-testing`.

## In-Source Tests

- Tests live beside implementation in `if (import.meta.vitest != null)` blocks.
- Use Vitest globals directly: `describe`, `it`, `test`, `expect`, `vi`,
  `beforeEach`, and `assert`.
- Do not import Vitest globals.
- Do not use `await import()` or other dynamic imports in tests.
- Top-level `fs-fixture` imports in implementation files with in-source tests are
  allowed and preferred over dynamic imports.

## Fixtures And Environment

- Use `fs-fixture` with `createFixture()` for simulated filesystem trees.
- Use `vi.stubEnv()` instead of mutating `process.env` directly.
- Skipped local-data smoke tests are acceptable when real user log directories
  catch schema drift, but they must not fail on clean CI machines.

## Assertions

- Prefer behavior-focused tests over schema-shape tests unless schema
  normalization itself is the behavior.
- Avoid `try`/`catch` for expected failures. Use `expect(...).toThrow()`,
  `await expect(...).rejects`, or explicit Result failure assertions.
- Avoid `if` branches inside test bodies. Split behaviors into separate tests or
  use `it.each` for table-driven cases.
- Tests do not need to be DRY. Prefer repeated, explicit setup when duplication
  makes each behavior easier to read.
- Do not hoist one-off values out of tests.

For broader TDD examples and modifiers, read
`../../tdd/references/vitest-running-and-modifiers.md` and
`../../tdd/references/vitest-readability.md`.
