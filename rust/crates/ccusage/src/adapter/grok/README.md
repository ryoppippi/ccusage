# Grok Build Adapter

The Grok Build adapter reads local session state from:

```text
${GROK_HOME:-~/.grok}/sessions/<encoded-cwd>/<session-id>/
```

For each session, `signals.json` is the usage source and `summary.json` supplies
metadata such as the session id, model, project path, and last activity time.

Grok Build currently records context token totals rather than a stable
input/output/cache usage breakdown in these session files. ccusage therefore
reports the recorded context total as `totalTokens` and leaves
`inputTokens`, `outputTokens`, cache tokens, and `totalCost` at zero for this
adapter. When Grok exposes per-request token usage in persisted session files,
the parser should move that data into the standard token fields and enable cost
calculation.
