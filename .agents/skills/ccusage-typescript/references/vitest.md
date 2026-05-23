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

Locate and read the local fs-fixture README before using less common options or
APIs:

```sh
fd -a README.md node_modules/.pnpm | rg "fs-fixture"
```

Prefer `await using` so cleanup is automatic:

```ts
import { createFixture } from 'fs-fixture';

await using fixture = await createFixture({
	'projects/example/session.jsonl': '{}\n',
});

const filePath = fixture.getPath('projects/example/session.jsonl');
```

Use object trees for small inline fixtures. Use template directory input when
many tests share the same larger fixture shape. Prefer `fixture.getPath(...)`
over manually joining against `fixture.path`, and use `fixture.writeFile()` or
`fixture.writeJson()` when a test needs to build data incrementally.

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
