---
name: cmux-debug
description: Use cmux to run commands in an existing terminal surface, capture rendered output, inspect terminal geometry, and debug CLI visual regressions. Use when validating terminal UIs, responsive tables, long-running CLI commands, or pane output in cmux.
---

# cmux Debug

Use this skill when the user wants to debug or verify CLI output inside a cmux pane/surface instead of relying only on non-interactive stdout.

## Workflow

1. Confirm cmux is reachable and the capture API exists.
2. Identify the target workspace and surface.
3. Run the command in that surface.
4. Capture visible output and scrollback.
5. For responsive terminal UI bugs, capture terminal geometry from the same surface.

## Commands

Check availability:

```sh
cmux ping
cmux capabilities --json | jq '.methods'
```

Find targets:

```sh
cmux list-workspaces --json
cmux list-surfaces --workspace <workspace> --json
cmux list-pane-surfaces --workspace <workspace> --json
```

Read output:

```sh
cmux read-screen --workspace <workspace> --surface <surface> --lines 80
cmux capture-pane --workspace <workspace> --surface <surface> --scrollback --lines 120
```

Run a command and capture it:

```sh
cmux send --workspace <workspace> --surface <surface> "printf '\\033c'; cd <cwd>; <command>\n"
cmux capture-pane --workspace <workspace> --surface <surface> --scrollback --lines 120
```

Capture geometry with the command output:

```sh
cmux send --workspace <workspace> --surface <surface> "printf '\\033c'; stty size; printf 'COLUMNS=%s\n' \"\$COLUMNS\"; cd <cwd>; <command>\n"
cmux read-screen --workspace <workspace> --surface <surface> --lines 120
```

Use socket RPC when the CLI wrapper is not enough:

```sh
cmux rpc surface.read_text '{"workspace_id":"<workspace_uuid>","surface_id":"<surface_uuid>","scrollback":true,"lines":120}'
```

## Checks

- Use the same surface for command execution, `stty size`, `$COLUMNS`, and output capture.
- Prefer `capture-pane --scrollback` when the command output may exceed the visible viewport.
- For table layout bugs, verify that rendered width fits the captured terminal width and that important columns such as dates and totals are not truncated.
- If `read-screen` or `capture-pane` is unavailable, inspect `cmux capabilities --json` and fall back to `surface.read_text` via `cmux rpc`.
