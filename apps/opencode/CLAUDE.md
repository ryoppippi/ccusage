# OpenCode CLI Notes

## Log Sources

- OpenCode session usage is recorded under `${OPENCODE_DATA_DIR:-~/.local/share/opencode}/storage/message/` (the CLI resolves `OPENCODE_DATA_DIR` and falls back to `~/.local/share/opencode`).
- Each message is stored as an individual JSON file (not JSONL like Claude or Codex).
- Message structure includes `tokens.input`, `tokens.output`, `tokens.cache.read`, and `tokens.cache.write`.

## Token Fields

- `input`: total input tokens sent to the model.
- `output`: output tokens (completion text).
- `cache.read`: cached portion of the input (prompt-caching).
- `cache.write`: cache creation tokens.
- Pre-calculated `cost` field may be present in OpenCode messages.

## Cost Calculation

- OpenCode messages may include pre-calculated `cost` field in USD.
- When `cost` is not present, costs should be calculated using model pricing data.
- Token mapping:
  - `inputTokens` ← `tokens.input`
  - `outputTokens` ← `tokens.output`
  - `cacheReadInputTokens` ← `tokens.cache.read`
  - `cacheCreationInputTokens` ← `tokens.cache.write`

## CLI Usage

- Treat OpenCode as a sibling to `apps/ccusage` and `apps/codex`.
- Reuse shared packages (`@ccusage/terminal`, `@ccusage/internal`) wherever possible.
- OpenCode is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies`.
- Entry point uses Gunshi framework.
- Data discovery relies on `OPENCODE_DATA_DIR` environment variable.
- Default path: `~/.local/share/opencode`.

## Testing Notes

- Tests rely on `fs-fixture` with `using` to ensure cleanup.
- All vitest blocks live alongside implementation files via `if (import.meta.vitest != null)`.
- Vitest globals are enabled - use `describe`, `it`, `expect` directly without imports.
