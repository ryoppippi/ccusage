---
name: ccusage-testing
description: Guides ccusage Rust tests. Use when adding or fixing cargo tests, CLI snapshots, Claude model pricing, LiteLLM compatibility, or Rust fixture-backed parser and loader tests.
---

# ccusage Testing

Use the `tdd` skill for logic changes and general test readability rules,
including the guidance to avoid over-DRYing tests when duplication improves
clarity. This skill adds ccusage-specific Rust, fixture, model, and pricing
rules. Use `ccusage-typescript` for Vitest and TypeScript filesystem fixtures.

## Rust Tests

Use `direnv exec .` when the current shell does not already expose the Rust toolchain:

```sh
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace <test_name>
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace -- --ignored
```

For repo-wide validation, prefer the package script because it runs Vitest and Rust tests together:

```sh
direnv exec . pnpm run test
```

Put Rust unit tests near the module they exercise with `#[cfg(test)] mod tests`. When splitting a large module, move its tests with the code instead of leaving unrelated tests in `main.rs`.

Use fixture-backed Rust tests for parser, path discovery, SQLite loading, dedupe, aggregation, pricing, and CLI output parity. For TDD syntax and focused cargo test examples, read `../tdd/references/rust-examples.md`.

## Test Readability

- Avoid `try`/`catch` in tests for expected failures. Use `Result` tests, `matches!`, or explicit error assertions.
- Avoid `if` branches inside test bodies. Split behaviors into separate tests, use `rstest` cases when the crate is already available, iterate over explicit Rust case structs in one table-driven test, or add a small local macro for repeated assertions.
- Tests do not need to be DRY. Prefer repeated, explicit setup in each test when it makes the behavior easier to read.
- Do not hoist one-off values out of tests. Write literals and direct setup values inline in the test body when sharing them would make the behavior harder to read.

For concrete Rust examples, read `../tdd/references/rust-examples.md`.

## CLI Output Tests

Integration tests that exercise human-readable table output should use focused
golden output or explicit layout assertions so table layout and responsive
behavior stay reviewable for each affected agent/report combination.

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
