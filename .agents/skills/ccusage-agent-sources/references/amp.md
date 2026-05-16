# Amp Source

Data source:

```text
${AMP_DATA_DIR:-~/.local/share/amp}/threads/
```

Each thread is a JSON file named `T-{uuid}.json`.

Usage comes from:

- `usageLedger.events[]` for token usage and credits.
- `messages[].usage` for cache creation/read breakdown.

Token fields:

- `inputTokens`
- `outputTokens`
- `cacheCreationInputTokens`
- `cacheReadInputTokens`
- `totalTokens`

Amp also reports `credits`; display credits alongside USD estimates when the command/report supports it.

Commands:

```sh
ccusage amp daily
ccusage amp monthly
ccusage amp session
ccusage amp daily --json
ccusage amp daily --compact
```
