---
name: ccusage-rust
description: Guides ccusage Rust implementation work. Use when editing rust/crates, native packaging, parser/module layout, pricing embedding, or Rust/TypeScript parity.
paths:
  - 'rust/**/*.rs'
  - 'rust/**/*.toml'
  - 'rust/**/build.rs'
globs: 'rust/**/*.rs,rust/**/*.toml,rust/**/build.rs'
---

# ccusage Rust

Use this skill for the native Rust CLI under `rust/crates/ccusage` and `rust/crates/ccusage-terminal`.

## Source Parity

Rust is the production implementation. Preserve existing Rust behavior unless
the user explicitly scopes a behavior change. Before implementing or refactoring
an agent, inspect the current Rust adapter and the agent source reference docs:

```sh
fd . rust/crates/ccusage/src/adapter/<agent>
sed -n '1,220p' .agents/skills/ccusage-agent-sources/references/<agent>.md
```

When porting behavior from the historical TypeScript implementation, first find
the relevant commit or tag that still contains `apps/ccusage/src/adapter`, then
compare against that source. Do not assume `origin/main` still contains the
TypeScript adapter.

Preserve report semantics, JSON fields, table columns, progress/spinner text, agent grouping, date filtering, `--offline`, `CLAUDE_CONFIG_DIR`, and source-specific environment variables.

## Module Layout

Do not keep growing `main.rs` or single large adapter files. Use these
responsibility boundaries where practical:

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

## Validation

Use the `ccusage-testing` skill for Rust test commands. Use
`ccusage-rust-profile` for performance work and branch-vs-main comparisons. For
parity work, compare against the current main branch, a previous release, or a
pinned historical TypeScript commit for a stable fixture window before changing
behavior.
