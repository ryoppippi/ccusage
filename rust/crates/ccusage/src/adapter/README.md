# Agent Adapters

This directory contains runtime agent source implementations for the native
`ccusage` CLI.

Each agent adapter owns source-specific log discovery, parsing, token mapping,
model mapping, source metadata, and source-specific pricing behavior. Shared
report rendering, date handling, progress, pricing fetcher lifecycle, file
walking, dedupe, and aggregation should stay in common ccusage modules when the
source data allows it.

Use one subdirectory per agent. The usual shape is:

- `mod.rs` - public adapter surface and command wiring.
- `paths.rs` - environment variables, default directories, and path discovery.
- `parser.rs` - raw record parsing and token/model mapping.
- `loader.rs` - file walking, SQLite reads, dedupe, and date filtering entry points.
- `report.rs` - JSON/table row shaping when agent-specific.
- `types.rs` - source-local types when they are not shared outside the adapter.

Use `apps/ccusage/src` only for the remaining npm launcher, package scripts,
schema artifacts, and benchmarks. Do not add new TypeScript runtime adapter
logic unless the work is explicitly scoped to the package layer.

Treat "same foundation as Claude" as more than shared file walking. JSONL
adapters should use shared scanning helpers when stable row markers exist, and
high-volume paths should avoid returning large intermediate object vectors when
worker-side aggregation or typed transfer payloads can preserve the same output.

When several adapters expose the same raw-log shape, prefer a small shared Rust
helper over duplicating period/session aggregation. Keep highly specialized
loaders such as Codex parsing separate when their file format or pricing
semantics require it.

Agent-specific source notes live in each adapter's `README.md` when the source
has non-obvious paths, record shapes, token semantics, model fallback behavior,
or command differences.
