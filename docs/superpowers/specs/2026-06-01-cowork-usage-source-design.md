# Cowork Usage Source Design

Date: 2026-06-01

## Problem

Claude Desktop Cowork local agent sessions store Claude Code-compatible usage
JSONL files under:

`~/Library/Application Support/Claude/local-agent-mode-sessions/**/local_*/.claude/projects/**/*.jsonl`

The current `ccusage` Claude adapter reads normal Claude Code config
directories such as `~/.claude` and `$XDG_CONFIG_HOME/claude`, but it does not
discover Cowork local agent session directories. Users cannot view Cowork token
usage separately from Claude Code usage.

## Goal

Add Cowork as a separate agent source. Users should be able to run commands such
as:

- `ccusage cowork`
- `ccusage cowork daily`
- `ccusage cowork monthly`
- `ccusage cowork session`

All-agent reports should include Cowork as its own `cowork` agent when Cowork
usage files are present. Claude Code and Cowork usage must not be merged under
the same agent label.

## Non-Goals

- Do not change Claude Code default discovery.
- Do not estimate tokens from message text.
- Do not add a standalone package such as `ccusage-cowork`.
- Do not add Cowork blocks or statusline support.
- Do not duplicate Claude parsing logic when a small shared helper can preserve
  the same behavior.

## Data Source

The default Cowork root is the macOS Claude Desktop application support
directory:

`~/Library/Application Support/Claude/local-agent-mode-sessions`

Within that root, each usable source is a nested Claude config directory:

`<root>/<workspace-id>/<session-id>/local_<uuid>/.claude`

The adapter should accept an override environment variable:

`COWORK_CONFIG_DIR`

The override should accept comma-separated paths. Each path may be either:

- a `local-agent-mode-sessions` root to discover recursively;
- a concrete `.claude` config directory;
- a `projects` directory inside a `.claude` config directory.

Invalid override paths should return a clear CLI error, matching the existing
`CLAUDE_CONFIG_DIR` behavior.

## Architecture

Add a new Rust adapter under:

`rust/crates/ccusage/src/adapter/cowork/`

The adapter owns Cowork path discovery and command wiring, but it should reuse
the Claude JSONL parsing, dedupe, cost calculation, daily summaries, session
summaries, and project extraction semantics.

To avoid copy-paste, refactor the Claude adapter so its loaders can accept an
explicit list of Claude-compatible config directories:

- keep `claude::load_entries(...)` and `claude::load_daily_summaries(...)` as
  public Claude entry points using `claude_paths()`;
- add internal helper entry points that receive `Vec<PathBuf>` or `&[PathBuf]`;
- call those helpers from both `claude` and `cowork`.

Cowork should use its own progress label and all-agent source label:

- progress label: `Cowork`
- all-agent JSON/table agent id: `cowork`

## CLI Integration

Add a `Cowork(AgentCommandArgs)` variant to `ccusage-cli`.

Register `cowork` in the command parser using the standard agent reports:

- `daily`
- `monthly`
- `session`

Weekly support is excluded for the first patch because the standard Claude-like
agent command set in this repository does not expose weekly reports for most
agents.

Wire `Command::Cowork(args)` in `rust/crates/ccusage/src/main.rs` to
`adapter::cowork::run(args)`.

## All-Agent Reports

Add Cowork to `adapter/all/loader.rs` as a separate load spec. It should use the
same summary-row path as Claude, but with agent id `cowork`.

When both Claude Code and Cowork files exist, all-agent output should contain
two separate agent breakdowns:

- `claude`
- `cowork`

No dedupe should happen across agent boundaries. Identical message IDs in
Claude Code and Cowork are separate product sources for reporting purposes.

## Tests

Follow TDD for implementation.

Add tests covering:

- Cowork path discovery from a `local-agent-mode-sessions` fixture root.
- Normalization of direct `.claude` and `projects` override paths.
- A Cowork daily report fixture that reuses Claude-compatible JSONL usage.
- A Cowork session report fixture that preserves session and project metadata.
- Parser coverage for `ccusage cowork`, `ccusage cowork daily`,
  `ccusage cowork monthly`, and `ccusage cowork session`.
- All-agent aggregation where Claude and Cowork fixtures appear as separate
  agent rows.

Add a skipped local-data smoke test if the existing test style supports
developer-machine paths for schema drift checks.

## Documentation Impact

This is a user-facing source and command. Update supported-agent lists and
command examples in:

- root `README.md`;
- `apps/ccusage/README.md`;
- relevant docs guide pages and navigation if those pages list supported
  agents or subcommands.

Add a source-specific README under `rust/crates/ccusage/src/adapter/cowork/`
describing the default path, `COWORK_CONFIG_DIR`, and the fact that Cowork uses
Claude-compatible JSONL usage files.

## Verification

Before opening a PR, run the repository-required checks:

- `pnpm run format`
- `pnpm typecheck`
- `pnpm run test`

During implementation, run targeted Rust and CLI parser tests first, then the
full repository checks after the patch is complete.
