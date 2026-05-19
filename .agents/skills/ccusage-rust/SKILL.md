---
name: ccusage-rust
description: Guides ccusage Rust implementation work. Use when editing rust/crates, native packaging, Rust performance, parser/module layout, pricing embedding, or Rust/TypeScript parity.
paths:
  - 'rust/**/*.rs'
  - 'rust/**/*.toml'
  - 'rust/**/build.rs'
globs: 'rust/**/*.rs,rust/**/*.toml,rust/**/build.rs'
---

# ccusage Rust

Use this skill for the native Rust CLI under `rust/crates/ccusage` and `rust/crates/ccusage-terminal`.

## Source Parity

Rust must match the TypeScript implementation on `origin/main` unless the user explicitly scopes a behavior change. Before implementing or refactoring an agent, inspect the corresponding TypeScript adapter:

```sh
git ls-tree -r --name-only origin/main apps/ccusage/src/adapter
git show origin/main:apps/ccusage/src/adapter/<agent>/index.ts
git show origin/main:apps/ccusage/src/adapter/<agent>/parser.ts
git show origin/main:apps/ccusage/src/adapter/<agent>/paths.ts
```

Preserve report semantics, JSON fields, table columns, progress/spinner text, agent grouping, date filtering, `--offline`, `CLAUDE_CONFIG_DIR`, and source-specific environment variables.

## Module Layout

Do not keep growing `main.rs` or single large adapter files. Mirror the TypeScript responsibility boundaries where practical:

- `adapter/<agent>/mod.rs` - public adapter surface and command wiring.
- `adapter/<agent>/paths.rs` - environment variables, defaults, and path discovery.
- `adapter/<agent>/parser.rs` - raw record parsing and token/model mapping.
- `adapter/<agent>/loader.rs` - file walking, SQLite reads, dedupe, and date filtering entry points.
- `adapter/<agent>/report.rs` - JSON/table row shaping when agent-specific.
- shared modules stay in `types.rs`, `summary.rs`, `output.rs`, `pricing.rs`, `progress.rs`, and `date_utils.rs`.

Keep public `pub(crate)` surfaces narrow. Prefer moving tests with the code they exercise instead of leaving all Rust tests in `main.rs`.

When splitting large Rust modules or removing duplication, use the `reduce-similarities` skill, which runs `similarity-rs` for `.rs` files.

## Pricing Embedding

TypeScript uses build/macro-time pricing snapshots. Rust should not rely on a manually edited `claude-pricing.json` as the only embedded source.

When changing pricing:

- Prefer a `build.rs` step that fetches LiteLLM `model_prices_and_context_window.json` into `OUT_DIR`.
- Keep a checked-in fallback snapshot so offline builds and network failures still work.
- Load the generated build-time snapshot first, then fallback pricing, then runtime fetch when not `--offline`.
- Add tests for embedded/offline pricing and context limits.

## Performance

Read the local Rust Performance Book clone before non-trivial optimization:

```text
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/profiling.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/io.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/heap-allocations.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/parallelism.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/type-sizes.md
```

Profile before committing an optimization. Validate with end-to-end `hyperfine` and JSON/table parity, not only microbenchmarks.

For ccusage workloads, check:

- I/O count and buffering before CPU-only tweaks.
- Avoid unnecessary `String` allocation and cloning on hot paths; prefer borrowed `&str`, `Arc<str>`, or typed summaries where ownership is needed.
- Avoid returning large intermediate object vectors when worker-side aggregation or typed transfer payloads can preserve output.
- Use parallelism only when it improves end-to-end command time on real fixture shapes.
- Keep binary size visible when adding dependencies or enabling features.

## Validation

Use the `ccusage-testing` skill for Rust test commands. For perf or parity work, compare against `origin/main` TypeScript output for a stable fixture window before changing behavior.
