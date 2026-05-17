---
name: ccusage-testing
description: Write or update ccusage tests using in-source Vitest blocks, fs-fixture data, snapshots for CLI table output, Claude model pricing expectations, and LiteLLM compatibility. Use when adding tests, fixing test failures, or changing usage aggregation and cost behavior.
---

# ccusage Testing

Use the `tdd` skill for logic changes and general test readability rules, including the guidance to avoid over-DRYing tests when duplication improves clarity. Use the `fs-fixture` skill when creating filesystem fixtures. This skill adds ccusage-specific Vitest, fixture, model, and pricing rules.

## Vitest Pattern

- Tests live beside implementation in `if (import.meta.vitest != null)` blocks.
- Use Vitest globals directly: `describe`, `it`, `expect`, `vi`, `assert`.
- Do not import Vitest globals.
- Do not use `await import()` or other dynamic imports anywhere, especially in tests.
- Use `fs-fixture` with `createFixture()` for simulated agent data directories; read the `fs-fixture` skill for API details and README location.
- Top-level `fs-fixture` imports in implementation files with in-source tests are allowed and preferred over dynamic imports.
- Use `vi.stubEnv()` instead of mutating `process.env` directly.
- Prefer testing parser, path resolution, loading, aggregation, pricing, and CLI output behavior over schema-shape tests. Valibot schema declarations usually do not need direct tests unless there is non-trivial normalization logic around them.
- If schema validation is already exercised through parser or loader tests with realistic log files, do not add separate schema-only tests. Add schema-adjacent tests only when the behavior is not visible through the public loader contract, such as legacy field compatibility or important invalid-record filtering.
- Path discovery helpers such as `getCodexSessionsPath()` or `getPiAgentPaths()` are real logic. Test explicit path arguments, environment variable paths with `vi.stubEnv()`, missing directories, and default-path fallback when feasible.
- It is acceptable to add explicitly skipped local-data smoke tests such as `it.skipIf(!hasLocalData)(...)` for real user log directories. These must not fail on clean CI machines.

Utility functions should include concise JSDoc describing their purpose and focused in-source tests for their behavior.

## Test Readability

- Avoid `try`/`catch` in tests for expected failures. Use `expect(...).toThrow()`, `await expect(...).rejects`, or explicit Result failure assertions.
- Avoid `if` branches inside test bodies. Split behaviors into separate tests or use `it.each` for table-driven cases.
- Do not over-DRY tests. Keep repeated setup inline when it makes the behavior easier to read.

For concrete good and bad examples, read `../tdd/references/vitest-examples.md`.

## CLI Output Tests

Integration tests that exercise human-readable table output must use file snapshots with `toMatchFileSnapshot`. This keeps table layout and responsive behavior reviewable for each affected agent/report combination.

Prefer JSON assertions for structured behavior and snapshot assertions for terminal layout.

## Claude Models

Use current Claude 4 model names in tests:

```text
claude-sonnet-4-20250514
claude-opus-4-20250514
```

The preferred naming pattern is `claude-{model-type}-{generation}-{date}`. Use compatibility or alias forms such as `claude-4-sonnet-*` only when the test explicitly covers pricing lookup, alias handling, or legacy compatibility behavior.

When model coverage matters, include both Sonnet and Opus. Avoid outdated Claude 3 model names unless the test specifically covers legacy input.

## LiteLLM Pricing

Cost calculations require exact model-name matches against LiteLLM pricing data. If adding model tests:

1. Verify the model exists in LiteLLM's pricing data.
2. Use exact model names from the pricing database.
3. Prefer offline/stubbed pricing loaders where the package already has that pattern.

Pricing-related test failures may mean the external model database changed or a model name is unsupported.
