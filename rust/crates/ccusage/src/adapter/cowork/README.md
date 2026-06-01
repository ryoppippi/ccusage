# Cowork Adapter

The Cowork adapter reads Claude Desktop local agent mode sessions as a separate
`cowork` source.

Default discovery on macOS:

`~/Library/Application Support/Claude/local-agent-mode-sessions/**/local_*/.claude/projects/**/*.jsonl`

Cowork stores Claude-compatible usage JSONL records, so token parsing, model
mapping, cost calculation, and deduplication are shared with the Claude adapter.

Set `COWORK_CONFIG_DIR` to override discovery. The value is comma-separated and
each entry may be:

- a `local-agent-mode-sessions` directory;
- a concrete `.claude` config directory;
- a `projects` directory inside a `.claude` config directory.

Supported reports:

- `ccusage cowork`
- `ccusage cowork daily`
- `ccusage cowork monthly`
- `ccusage cowork session`
