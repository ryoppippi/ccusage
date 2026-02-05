# Kimi CLI Notes

## Log Sources

- Kimi session usage is recorded under `${KIMI_SHARE_DIR:-~/.kimi}/sessions/` (the CLI resolves `KIMI_SHARE_DIR` and falls back to `~/.kimi`).
- Each session directory contains a `wire.jsonl` file with JSON Lines format.
- Each line in `wire.jsonl` is a JSON object with `timestamp`, `message.type`, and `message.payload`.
- We parse messages where `message.type === "StatusUpdate"` and extract `message.payload.token_usage`.

## Work Directory Mapping

Kimi CLI uses MD5 hashes to name session directories:

- For local mode: `{md5(work_dir)}`
- For kaos mode: `{kaos}_{md5(work_dir)}`

The mapping from hashes to original paths is stored in `kimi.json`:

```json
{
	"work_dirs": [
		{ "path": "/home/user/project", "kaos": "local" },
		{ "path": "/remote/project", "kaos": "remote-kaos-id" }
	]
}
```

The `computeWorkDirBasename()` function in `data-loader.ts` computes the same hash algorithm Kimi uses, allowing us to map session directories back to their original work directories.

## Token Fields

Kimi's `token_usage` object contains these fields:

- `input_other`: Input tokens not from cache (cache miss)
- `input_cache_read`: Tokens read from prompt cache
- `input_cache_creation`: Tokens used to create/update cache
- `output`: Output/completion tokens

Mapping to our internal format:

| Kimi Field             | Internal Field          | Calculation                                   |
| ---------------------- | ----------------------- | --------------------------------------------- |
| `input_other`          | `inputTokens`           | Part of total input                           |
| `input_cache_read`     | `cachedInputTokens`     | Also added to `inputTokens`                   |
| `input_cache_creation` | (part of input)         | Added to `inputTokens`                        |
| `output`               | `outputTokens`          | Direct mapping                                |
| `ContentPart.think`    | `reasoningOutputTokens` | Estimated from think content (~4 chars/token) |

```
inputTokens = input_other + input_cache_read + input_cache_creation
cachedInputTokens = input_cache_read
outputTokens = output
reasoningOutputTokens = estimated from think content
totalTokens = inputTokens + outputTokens
```

**Reasoning Token Extraction:**

While Kimi CLI does not report reasoning token counts in the `token_usage` object, it does include thinking content in `ContentPart` messages with `type: 'think'`. We extract this content and estimate token counts using a ~4 characters-per-token heuristic.

The extraction works by processing the wire file in a single pass:

1. When a `ContentPart` with `type: 'think'` is encountered, its content is added to a session buffer
2. When a `StatusUpdate` is encountered, any accumulated thinking content since the last StatusUpdate is converted to tokens and attributed to that event
3. The reasoning tokens are capped at the total output tokens for that event to ensure consistency

This approach ensures that thinking content is properly attributed to the correct API call, giving accurate per-session and per-day reasoning token counts.

## Model Detection

Kimi CLI does not include model metadata in each message. We detect the model using this priority:

1. `KIMI_MODEL_NAME` environment variable
2. `default_model` from `config.toml` in the share directory
3. Fallback to `"unknown"` with `isFallbackModel: true`

The `config.toml` format:

```toml
default_model = "kimi-code/kimi-for-coding"
```

## Cost Calculation

Since Kimi CLI does not provide pre-calculated costs in the log files, we use hardcoded pricing for known models:

| Model                  | Input $/M | Cached $/M | Output $/M |
| ---------------------- | --------- | ---------- | ---------- |
| kimi-k2.5              | $0.60     | $0.10      | $3.00      |
| kimi-for-coding        | $0.60     | $0.10      | $3.00      |
| kimi-code              | $0.60     | $0.10      | $3.00      |
| kimi-k2-0905-preview   | $0.60     | $0.15      | $2.50      |
| kimi-k2-0711-preview   | $0.60     | $0.15      | $2.50      |
| kimi-k2-turbo-preview  | $1.15     | $0.15      | $8.00      |
| kimi-k2-thinking       | $0.60     | $0.15      | $2.50      |
| kimi-k2-thinking-turbo | $1.15     | $0.15      | $8.00      |

For unknown models, we return zero pricing and emit a warning (once per unknown model). This ensures usage data is still visible even when pricing is unavailable.

Model name normalization handles scoped names like `kimi-code/kimi-for-coding` by extracting the last segment.

## Message Deduplication

Kimi CLI may emit duplicate `StatusUpdate` messages for the same turn. We deduplicate using `message_id` from the payload:

```typescript
const dedupeKey = `${sessionId}:${messageId}`;
if (seenMessageIds.has(dedupeKey)) {
	continue; // Skip duplicate
}
```

## Session ID Format

Session IDs are constructed as:

```
{work_directory_path}/{session_file_id}
```

Where:

- `work_directory_path` is the resolved path from `kimi.json` (or the hash if not found)
- `session_file_id` is the name of the session directory (e.g., `2025-01-01-abc123`)

This format allows session reports to show both the directory and session file separately.

## CLI Usage

- Treat Kimi as a sibling to `apps/ccusage` and `apps/codex`.
- Reuse shared packages (`@ccusage/terminal`, `@ccusage/internal`) wherever possible.
- Kimi is packaged as a bundled CLI. Keep every runtime dependency in `devDependencies`.
- Entry point uses Gunshi framework with `daily` as the default command.
- Data discovery relies on `KIMI_SHARE_DIR` environment variable (defaults to `~/.kimi`).

## Testing Notes

- Tests rely on `fs-fixture` with `using` to ensure cleanup.
- Tests verify token field mapping from Kimi's wire format.
- Tests verify work directory hash mapping and deduplication logic.
- Tests verify pricing lookup for known models and fallback for unknown models.
- All vitest blocks live alongside implementation files via `if (import.meta.vitest != null)`.
- Vitest globals are enabled - use `describe`, `it`, `expect` directly without imports.

## Known Limitations

1. **Reasoning tokens are estimated**: Kimi CLI reports reasoning content in `ContentPart` messages but not token counts. We estimate tokens using a ~4 chars/token heuristic, which may differ from actual tokenization.
2. **No pre-calculated costs**: Unlike OpenCode, Kimi doesn't provide cost metadata, so we rely on hardcoded pricing.
3. **Single model per session**: Model detection relies on config.toml, not per-message metadata.
4. **No weekly command**: Implemented (unlike other apps).
