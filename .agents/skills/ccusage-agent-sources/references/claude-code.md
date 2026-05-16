# Claude Code Source

Default data directories:

- `~/.config/claude/projects/`
- `~/.claude/projects/`

`CLAUDE_CONFIG_DIR` can specify one path or comma-separated multiple paths. Data from valid directories is combined.

File shape:

```text
projects/{project}/{sessionId}/{file}.jsonl
```

The term `session` has two meanings in this codebase:

- Session report grouping uses project directories.
- Session reports derive `sessionId` from the session directory name.
- True Claude Code session ID may also appear in each JSONL entry's `sessionId` field.

Malformed JSONL lines are skipped during parsing.
