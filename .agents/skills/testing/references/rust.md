# Rust Tests

Use fixture-backed Rust tests for parser, path discovery, SQLite loading,
dedupe, aggregation, pricing, and CLI output parity. Prefer
`ccusage-test-support` for temporary filesystem setup instead of hand-rolled
`env::temp_dir()` paths.

## Filesystem Fixtures

Use the internal `ccusage-test-support` crate for Rust tests that need temporary
files or directories. The fixture owns an `assert_fs::TempDir`, so everything is
removed automatically when the fixture variable drops at the end of the test.

For small inline trees, prefer `fs_fixture!`:

```rust
use ccusage_test_support::fs_fixture;

let fixture = fs_fixture!({
    "projects/example/session.jsonl": "{}\n",
});

let file_path = fixture.path("projects/example/session.jsonl");
```

For incremental setup, use `Fixture` directly:

```rust
use ccusage_test_support::Fixture;

let fixture = Fixture::new();
fixture.create_dir_all("projects/example/session");
fixture.write_file("projects/example/session/chat.jsonl", "{}\n");
```

Keep the fixture variable alive for as long as paths under it are used. Do not
return or store only a `PathBuf` from a short inner scope, because dropping the
fixture removes the directory.

## Readability

For expected failures, use `Result` tests, `matches!`, or explicit error
assertions. For table-driven coverage, use `rstest` cases when the crate is
already available, explicit Rust case structs, or a small local macro for
repeated assertions. For concrete Rust examples, read
`../../tdd/references/rust.md`.

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
