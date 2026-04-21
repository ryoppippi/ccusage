# Codebuff CLI Notes

## Log Sources

- Codebuff persists chat history under `${CODEBUFF_DATA_DIR:-~/.config/manicode}`.
- The product was previously called **Manicode**, so on disk the directory is still `manicode`. Dev and staging channels live under `manicode-dev` and `manicode-staging`; the loader walks all three when present.
- Layout per channel:
  - `projects/<projectBasename>/chats/<chatId>/chat-messages.json` – serialized `ChatMessage[]`.
  - `projects/<projectBasename>/chats/<chatId>/run-state.json` – SDK `RunState` snapshot (used to recover the real `cwd`).
- `chatId` is the chat's ISO timestamp with `:` substituted by `-` so it's filesystem-safe (e.g. `2025-12-14T10-00-00.000Z`).

## Token / Credit Extraction

Codebuff routes calls through several upstream providers, so usage can live in any of these spots on an assistant `ChatMessage`:

1. `metadata.usage` – direct assistant-side usage numbers.
2. `metadata.codebuff.usage` – Codebuff-specific usage payload.
3. `metadata.runState.sessionState.mainAgentState.messageHistory[*].providerOptions` – when the SDK stashed the RunState after completion, the most recent `role === 'assistant'` entry carries OpenRouter-shaped usage under `providerOptions.usage` (snake_case keys) or `providerOptions.codebuff.usage`.

Both camelCase and snake_case shapes are accepted (`inputTokens`/`input_tokens`/`promptTokens`, etc.).

Credits live directly on `message.credits` and are surfaced alongside the USD cost estimate.

## Cost Calculation

- Pricing is pulled from LiteLLM's public JSON (`model_prices_and_context_window.json`) via `@ccusage/internal/pricing`.
- Codebuff supports multiple providers; the pre-fetched dataset retains models that start with: `claude-`, `anthropic/`, `gpt-`, `o1`/`o3`/`o4`, `openai/`, `azure/`, `gemini-`, `google/`, `grok-`, `xai/`, `mistral*/`, `deepseek/`, `qwen/`, `openrouter/`.
- Unknown models fall back to zero-cost pricing and surface a warning.

## CLI Usage

- Entry point uses Gunshi with subcommands: `daily`, `monthly`, `session`.
- Default command when no subcommand is given: `daily`.
- Add `--json` for structured JSON output; `--compact` forces compact table mode.

## Environment Variables

- `CODEBUFF_DATA_DIR` – override for the Codebuff base directory. Point it at a single channel root such as `~/.config/manicode-dev`.
- `LOG_LEVEL` – control logging verbosity (0=silent … 5=trace).

## Testing Notes

- Tests rely on `fs-fixture` with `using` to ensure cleanup.
- Vitest blocks live alongside implementation files via `if (import.meta.vitest != null)`.
- Vitest globals are enabled – use `describe`, `it`, `expect` directly without imports.
- **CRITICAL**: NEVER use `await import()` dynamic imports anywhere, especially in test blocks.

## Data Structure (example)

```json
[
	{
		"variant": "user",
		"content": "Add a readme for Codebuff support",
		"timestamp": "2025-12-14T09:59:58.000Z"
	},
	{
		"variant": "ai",
		"content": "Sure, here is the readme",
		"timestamp": "2025-12-14T10:00:00.000Z",
		"credits": 1.25,
		"metadata": {
			"model": "claude-sonnet-4-20250514",
			"usage": {
				"inputTokens": 500,
				"outputTokens": 200,
				"cacheCreationInputTokens": 300,
				"cacheReadInputTokens": 100
			}
		}
	}
]
```
