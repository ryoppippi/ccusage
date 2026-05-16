# Claude Code Source

Default data directories:

- `~/.config/claude/projects/`
- `~/.claude/projects/`

`CLAUDE_CONFIG_DIR` can specify one path or comma-separated multiple paths. Data from valid directories is combined.

File shape:

```text
projects/{project}/{sessionId}.jsonl
```

The term `session` has two meanings in this codebase:

- Session report grouping uses project directories.
- True Claude Code session ID is the JSONL `sessionId` field and filename.

Malformed JSONL lines are skipped during parsing.
