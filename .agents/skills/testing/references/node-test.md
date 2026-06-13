# Node Tests

Use this reference for TypeScript package launcher, schema artifact, benchmark
script, and docs/package tooling tests. Production CLI runtime behavior should
prefer Rust tests through `references/rust.md`.

## Files

- Put TypeScript tests in `*.test.ts` files beside the code or owning tooling
  area.
- Import from `node:test` and `node:assert/strict`; do not rely on globals.
- Run the package/tooling tests with `just test-node`.
- Do not use `await import()` or other dynamic imports in tests.

## Fixtures And Environment

- Use built-in Node filesystem and temporary directory APIs for small package
  tooling fixtures.
- Prefer explicit setup in each test when it makes the behavior easier to read.
- Mutate `process.env` only with local save/restore around the test body.

## Assertions

- Avoid `try`/`catch` for expected failures. Use `assert.throws`,
  `assert.rejects`, or explicit Result failure assertions.
- Use table-driven loops outside the test body when several cases share the same
  assertion shape.

For broader TDD examples and modifiers, read
`../../tdd/references/node-test.md`.
