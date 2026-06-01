# Cowork Data Source

ccusage can read Cowork local agent session logs from Claude Desktop as a separate supported data source. Cowork stores Claude-compatible `.claude/projects/**/*.jsonl` data under Claude Desktop's local agent session directory, so ccusage reuses the Claude parser but reports Cowork as its own `cowork` source.

## Focused Views

```bash
# Daily Cowork usage
ccusage cowork daily

# Monthly Cowork usage
ccusage cowork monthly

# Cowork sessions
ccusage cowork session
```

Most users can start with unified reports such as `ccusage daily`. Add the `cowork` namespace when you want to inspect Claude Desktop Cowork usage separately from Claude Code.

## Data Source

ccusage discovers Cowork data from Claude Desktop's local agent mode sessions:

| Source | Default path |
| ------ | ------------ |
| Cowork | `~/Library/Application Support/Claude/local-agent-mode-sessions` |

The expected session layout is:

```text
local-agent-mode-sessions/
`-- <workspace-id>/
    `-- <session-id>/
        `-- local_<id>/
            `-- .claude/
                `-- projects/
                    `-- <project>/
                        `-- <session>.jsonl
```

Cowork is intentionally separate from Claude Code in unified reports. If the same model or message IDs appear in both sources, ccusage keeps them under separate `claude` and `cowork` agent rows.

## Report Views

| Focused view              | Description                    | See also                                |
| ------------------------- | ------------------------------ | --------------------------------------- |
| `ccusage cowork daily`    | Aggregate usage by date        | [Daily Usage](/guide/daily-reports)     |
| `ccusage cowork monthly`  | Aggregate usage by month       | [Monthly Usage](/guide/monthly-reports) |
| `ccusage cowork session`  | Group usage by Cowork session  | [Session Usage](/guide/session-reports) |

Cowork does not expose a focused weekly command. Use `ccusage weekly` to include Cowork in the unified weekly report.

## Environment Variables

| Variable             | Description |
| -------------------- | ----------- |
| `COWORK_CONFIG_DIR`  | Override Cowork data discovery |
| `LOG_LEVEL`          | Adjust verbosity (0 silent ... 5 trace) |

### Custom Cowork Paths

Set `COWORK_CONFIG_DIR` when Cowork logs live outside the default Claude Desktop path:

```bash
export COWORK_CONFIG_DIR="/path/to/local-agent-mode-sessions"
ccusage cowork daily
```

The variable accepts comma-separated entries. Each entry can be:

- a `local-agent-mode-sessions` root;
- a concrete `.claude` config directory;
- a `projects` directory inside a `.claude` config directory.

```bash
export COWORK_CONFIG_DIR="/path/to/local-agent-mode-sessions,/backup/cowork/.claude,/archive/cowork/.claude/projects"
ccusage cowork monthly
```

## Troubleshooting

::: details No Cowork usage data found
Check whether Claude Desktop has created local agent sessions under `~/Library/Application Support/Claude/local-agent-mode-sessions`. If your data lives elsewhere, set `COWORK_CONFIG_DIR` to the session root, the nested `.claude` directory, or the nested `projects` directory.
:::
