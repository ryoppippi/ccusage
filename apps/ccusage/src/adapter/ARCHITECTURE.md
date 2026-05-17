# Agent Adapter Architecture

Agent adapters live under `apps/ccusage/src/adapter/<agent>/` and put agent-specific log handling on top of the shared ccusage reporting foundation.

The shared foundation should own terminal rendering, JSON output shape, date formatting, progress reporting, worker gating, file walking primitives, pricing fetcher lifecycle, and common aggregation helpers. Adapter code should own only the differences forced by each coding agent's data source.

## Adapter Layers

Each adapter should be organized around these layers:

1. Detect source files

   Resolve explicit CLI paths, environment variables, and default locations. This layer answers whether the agent has usable data without parsing the full dataset. Adapters may have multiple roots, such as Claude's config directories, or multiple source kinds, such as OpenCode JSON files plus SQLite databases.

2. Load files

   Walk the source directory with shared file utilities. Use shared worker gating, file-size chunking, worker spawn, and indexed result restoration when there are enough files and the bundled runtime can safely launch workers. The discovered source type does not have to be a string path; it can be a tagged union such as `{ kind: "json"; path: string } | { kind: "sqlite"; path: string }`.

3. Parse records

   Convert source records into small normalized usage events. Prefer hot-path string extraction for large JSONL logs when the format is stable enough. Use schema validation where it protects compatibility or filters messy source data, but avoid Valibot on the hot path when it is only validating fields that parser logic already checks.

4. Aggregate rows

   Aggregate normalized usage events into `AgentUsageRow` by daily, monthly, or session period. Use shared helpers such as `defineAgentLogLoader()` when the adapter can aggregate in the parent process. If an agent needs worker-side aggregation for performance, keep the result shape compatible with `AgentUsageRow`.

5. Return to parent process

   Workers should return compact parsed events or pre-aggregated rows. Parent code is responsible for stable ordering, final cost totals, and integration with all-agent output.

## File Layout

Use small files under each adapter directory:

- `index.ts` - public adapter exports and high-level wiring.
- `paths.ts` - source directory resolution and environment variables.
- `parser.ts` or `loader.ts` - file walking, JSONL/JSON/DB parsing, and worker orchestration.
- `schema.ts` - validation schemas and small source-shape helpers.
- `pricing.ts` or `pricing-macro.ts` - model aliases, provider filters, and bundled pricing.
- `types.ts` - adapter-local types.

Do not put source logic outside the ccusage adapter directories. The standalone wrapper packages have been removed, and `apps/ccusage/src/adapter/<agent>/` is the implementation home.

When migrating an existing root-level implementation into an adapter, update internal import sites to point at `adapter/<agent>/...` directly. Avoid root-level re-export shims unless the path is part of the package's declared public exports or a dedicated bundled worker entry. `apps/ccusage/src/data-loader.ts` is such an entry: it keeps the optimized Claude loader in the separate `data-loader` chunk introduced by PR #984, while source logic stays under `adapter/claude/`.

## Definition Hooks

When an adapter fits the common lifecycle, define it with hooks equivalent to:

```ts
defineAgentAdapter({
	agent,
	detect,
	discover,
	parse,
	aggregate,
});
```

The generic `Source` type should represent the agent's actual source units. For example:

- Claude can discover `{ root: string; file: string }` across multiple Claude roots.
- Codex can discover JSONL file paths under `CODEX_HOME/sessions`.
- OpenCode can discover a tagged union for SQLite DB files and JSON message files.
- Amp can discover thread JSON files.
- pi-agent can discover JSONL files under one or more session roots.

Keep the lifecycle explicit even when an adapter needs a custom fast path. The shared hooks document where file discovery, worker launch, parsing, and aggregation happen.

## Optimization Baseline

Adapters should share the same optimized primitives instead of reimplementing file IO, worker fan-out, pricing fetch lifecycle, or terminal progress. The current baseline is:

- Claude: `collectFilesRecursive()`, shared JSONL byte marker scanning with `processJSONLFileByMarkers()`, worker parsing, columnar typed-array worker payloads, bounded non-worker fallback through `mapWithConcurrency()`, and the separate `data-loader` chunk introduced by PR #984.
- Codex: `hasFileRecursive()` for detection, `collectFilesRecursive()`, shared JSONL byte marker scanning with `processJSONLFileByMarkers()`, `collectIndexedFileWorkerResults()`, typed-array worker event payloads, shared pricing fetcher lifecycle, shared usage load progress, and `readTextFile()` for `config.toml`.
- OpenCode: `hasFileRecursive()` for JSON detection, `collectFilesRecursive()`, `readTextFile()` for legacy message JSON files, `collectIndexedFileWorkerResults()`, SQLite loading through `@ccusage/internal/sqlite`, shared pricing fetcher lifecycle, and shared usage load progress.
- Amp: `hasFileRecursive()` for detection, `collectFilesRecursive()`, `readTextFile()` for thread JSON files, `collectIndexedFileWorkerResults()`, bounded non-worker fallback through `mapWithConcurrency()`, shared pricing fetcher lifecycle, and shared usage load progress.
- pi-agent: `hasFileRecursive()` for detection, `collectFilesRecursive()`, shared JSONL byte marker scanning with `processJSONLFileByMarkers()`, `collectIndexedFileWorkerResults()`, bounded non-worker fallback through `mapWithConcurrency()`, and shared usage load progress.

When adding a new coding agent, start from this list before adding adapter-specific code. Use `hasFileRecursive()` for cheap source detection and `collectFilesRecursive()` for deterministic file discovery. JSONL adapters should use `processJSONLFileByMarkers()` when they can identify useful rows by stable marker strings, so they avoid decoding unrelated log lines. Use `processJSONLFileByLine()` only when every non-empty line must be inspected. Use `readTextFile()` for whole JSON, TOML, or other text files, and keep SQLite sources behind `@ccusage/internal/sqlite`. If an adapter needs deterministic worker result ordering, use `collectIndexedFileWorkerResults()`. If workers are disabled or unavailable, use `mapWithConcurrency()` instead of unbounded `Promise.all(files.map(...))`.

Worker results are part of the optimization baseline. Large JSONL adapters should not return large arrays of object records from workers when a compact payload is practical. Prefer typed arrays plus string tables and transfer their buffers, or aggregate rows in the worker when that preserves the report semantics. Whole-JSON and SQLite adapters do not automatically benefit from JSONL byte marker scanning, but they should still share worker gating, result ordering, pricing lifecycle, output formatting, and any compact payload or worker-side aggregation helpers that fit their source shape.

## Testing Policy

Tests should cover behavior at the layer where the logic lives:

- Path helpers: explicit paths, environment paths, missing paths, and default fallback.
- Parsers/loaders: realistic fixture files and ignored invalid records.
- Aggregators: date/month/session grouping, token totals, models, metadata, and cost.
- CLI output: JSON assertions for structure and snapshots for human-readable tables.
- Local smoke tests: use skipped tests for real user data directories when useful, so clean CI machines do not fail.
- Terminal validation: use cmux for table layout, progress, spinner, and responsive output changes.
- Performance: compare affected agents against main or the previous release tag, and verify JSON parity for the benchmark window.

Schema-only tests are usually lower value than loader tests with realistic logs. Add schema-adjacent tests only when the schema encodes compatibility or filtering behavior not otherwise visible through parser or loader tests.
