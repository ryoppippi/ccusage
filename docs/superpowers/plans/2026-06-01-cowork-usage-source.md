# Cowork Usage Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cowork as a separate `ccusage` agent source that reads Claude-compatible local agent session logs from Claude Desktop.

**Architecture:** Cowork gets its own adapter, CLI command, progress label, and all-agent source id. Runtime parsing and aggregation reuse Claude-compatible loader helpers so Claude Code and Cowork do not drift. Cowork owns only path discovery and command wiring.

**Tech Stack:** Rust 2021, `ccusage-cli`, `ccusage` native CLI, fixture-backed Rust tests, existing `pnpm` repository scripts.

---

## File Structure

- Modify `rust/crates/ccusage-cli/src/types.rs`: add `Command::Cowork`.
- Modify `rust/crates/ccusage-cli/src/parser.rs`: parse `ccusage cowork [daily|monthly|session]`.
- Modify `rust/crates/ccusage-cli/src/tests.rs`: parser snapshots and command parsing tests.
- Modify `rust/crates/ccusage/src/main.rs`: dispatch `Command::Cowork`.
- Modify `rust/crates/ccusage/src/progress.rs`: add `UsageLoadAgent::Cowork`.
- Modify `rust/crates/ccusage/src/adapter/mod.rs`: register `cowork`.
- Modify `rust/crates/ccusage/src/adapter/claude/mod.rs`: expose Claude-compatible loader helpers that accept explicit config paths.
- Modify `rust/crates/ccusage/src/adapter/claude/daily.rs`: expose daily summary helper that accepts explicit config paths.
- Modify `rust/crates/ccusage/src/adapter/claude/paths.rs`: make path normalization helpers reusable inside the adapter tree.
- Create `rust/crates/ccusage/src/adapter/cowork/mod.rs`: Cowork command runtime.
- Create `rust/crates/ccusage/src/adapter/cowork/paths.rs`: Cowork source discovery and env override handling.
- Create `rust/crates/ccusage/src/adapter/cowork/README.md`: source-specific notes.
- Modify `rust/crates/ccusage/src/adapter/all/loader.rs`: include Cowork in all-agent reports.
- Modify docs that list supported agents: `README.md`, `apps/ccusage/README.md`, and relevant `docs/guide/` pages found by `rg -n "Claude Code|Codex|OpenCode|supported|agent" README.md apps/ccusage/README.md docs/guide`.

---

### Task 1: Add CLI Parser Support

**Files:**

- Modify: `rust/crates/ccusage-cli/src/types.rs`
- Modify: `rust/crates/ccusage-cli/src/parser.rs`
- Modify: `rust/crates/ccusage-cli/src/tests.rs`

- [ ] **Step 1: Write failing parser tests**

Add these tests near the existing agent command tests in `rust/crates/ccusage-cli/src/tests.rs`:

```rust
#[test]
fn parses_cowork_default_command() {
    let cli = parse(["ccusage", "cowork"]);
    let Some(Command::Cowork(args)) = cli.command else {
        panic!("expected Cowork command");
    };
    assert_eq!(args.kind, AgentReportKind::Daily);
}

#[test]
fn parses_cowork_report_commands() {
    for (report, expected) in [
        ("daily", AgentReportKind::Daily),
        ("monthly", AgentReportKind::Monthly),
        ("session", AgentReportKind::Session),
    ] {
        let cli = parse(["ccusage", "cowork", report]);
        let Some(Command::Cowork(args)) = cli.command else {
            panic!("expected Cowork command for {report}");
        };
        assert_eq!(args.kind, expected);
    }
}

#[test]
fn rejects_unknown_cowork_report_command() {
    let error = parse_err(["ccusage", "cowork", "weekly"]);
    assert_eq!(error, "Unknown cowork command 'weekly'");
}
```

Also extend the existing command snapshot match:

```rust
Some(Command::Cowork(args)) => agent_command_snapshot("cowork", args),
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage-cli cowork -- --nocapture
```

Expected: FAIL because `Command::Cowork` does not exist.

- [ ] **Step 3: Add the Cowork command variant**

In `rust/crates/ccusage-cli/src/types.rs`, add:

```rust
Cowork(AgentCommandArgs),
```

near the other agent command variants.

- [ ] **Step 4: Parse the cowork command**

In `rust/crates/ccusage-cli/src/parser.rs`, add this match arm next to the other standard agent commands:

```rust
"cowork" => parse_basic_agent_command(
    parser,
    shared,
    "cowork",
    STANDARD_AGENT_REPORTS,
    Command::Cowork,
),
```

- [ ] **Step 5: Run parser tests and verify they pass**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage-cli cowork -- --nocapture
```

Expected: PASS for Cowork parser tests.

- [ ] **Step 6: Commit CLI parser support**

Run:

```bash
git add rust/crates/ccusage-cli/src/types.rs rust/crates/ccusage-cli/src/parser.rs rust/crates/ccusage-cli/src/tests.rs
git diff --staged
git commit -m "feat(cowork): add CLI command parser"
```

---

### Task 2: Refactor Claude Loaders for Reuse

**Files:**

- Modify: `rust/crates/ccusage/src/adapter/claude/mod.rs`
- Modify: `rust/crates/ccusage/src/adapter/claude/daily.rs`
- Modify: `rust/crates/ccusage/src/adapter/claude/paths.rs`

- [ ] **Step 1: Add failing helper-level tests**

Add a test in `rust/crates/ccusage/src/main.rs` near the existing Claude loader tests:

```rust
#[test]
fn loads_claude_compatible_entries_from_explicit_config_paths() {
    let fixture = fs_fixture!({
        "config-a/projects/project-a/session-a.jsonl": r#"{"timestamp":"2025-01-10T10:00:00.000Z","message":{"id":"msg_a","model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":5}},"requestId":"req_a","costUSD":0.01}"#,
        "config-b/projects/project-b/session-b.jsonl": r#"{"timestamp":"2025-01-11T10:00:00.000Z","message":{"id":"msg_b","model":"claude-sonnet-4-20250514","usage":{"input_tokens":20,"output_tokens":30,"cache_creation_input_tokens":4,"cache_read_input_tokens":2}},"requestId":"req_b","costUSD":0.04}"#,
    });
    let shared = SharedArgs {
        mode: CostMode::Display,
        timezone: Some("UTC".to_string()),
        ..SharedArgs::default()
    };

    let entries = adapter::claude::load_entries_from_paths(
        &shared,
        &[fixture.path("config-a"), fixture.path("config-b")],
        None,
        "Test",
    )
    .unwrap();
    let daily = adapter::claude::load_daily_summaries_from_paths(
        &shared,
        &[fixture.path("config-a"), fixture.path("config-b")],
        None,
        false,
    )
    .unwrap();

    assert_eq!(entries.len(), 2);
    assert_eq!(daily.len(), 2);
    assert_eq!(entries[0].project.as_ref(), "project-a");
    assert_eq!(entries[1].project.as_ref(), "project-b");
}
```

- [ ] **Step 2: Run the targeted test and verify failure**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage loads_claude_compatible_entries_from_explicit_config_paths -- --nocapture
```

Expected: FAIL because `load_entries_from_paths` and `load_daily_summaries_from_paths` do not exist.

- [ ] **Step 3: Expose explicit-path loader helpers**

In `rust/crates/ccusage/src/adapter/claude/mod.rs`, keep `load_entries` unchanged externally, but route it through a new helper:

```rust
pub(crate) fn load_entries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    progress::track_usage_load(progress::UsageLoadAgent::Claude, shared.json, || {
        let paths = claude_paths()?;
        load_entries_from_paths(shared, &paths, project_filter, "Claude")
    })
}

pub(crate) fn load_entries_from_paths(
    shared: &SharedArgs,
    paths: &[PathBuf],
    project_filter: Option<&str>,
    debug_label: &str,
) -> Result<Vec<LoadedEntry>> {
    load_entries_inner(shared, paths, project_filter, debug_label)
}

fn load_entries_inner(
    shared: &SharedArgs,
    paths: &[PathBuf],
    project_filter: Option<&str>,
    debug_label: &str,
) -> Result<Vec<LoadedEntry>> {
    debug_log(
        shared,
        format!(
            "Scanning {debug_label} data directories: {}",
            paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );
    let files = usage_files(paths, project_filter);
    debug_log(shared, format!("Found {} JSONL usage files", files.len()));
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let pricing = if shared.mode == CostMode::Display {
        None
    } else {
        Some(PricingMap::load(shared.offline, log_level() != Some(0)))
    };
    let tz = parse_tz(shared.timezone.as_deref());
    let mode = shared.mode;
    let loaded_files = if shared.single_thread {
        files
            .iter()
            .map(|file| read_usage_file(file, tz.as_ref(), mode, pricing.as_ref()))
            .collect::<Vec<_>>()
    } else {
        read_usage_files_parallel(&files, tz.as_ref(), mode, pricing.as_ref())
    };
    let loaded_entry_count = loaded_files
        .iter()
        .map(|file| file.entries.len())
        .sum::<usize>();
    debug_log(
        shared,
        format!(
            "Loaded {loaded_entry_count} usage entries from {} JSONL files",
            loaded_files.len()
        ),
    );

    let mut deduped_indexes: FxHashMap<u64, SmallIndexVec> = FxHashMap::default();
    let mut deduped: Vec<LoadedEntry> =
        Vec::with_capacity(loaded_files.iter().map(|file| file.entries.len()).sum());
    for loaded_file in loaded_files {
        for entry in loaded_file.entries {
            if let Some(filter) = project_filter {
                if entry.project.as_ref() != filter {
                    continue;
                }
            }
            push_deduped_entry(entry, &mut deduped_indexes, &mut deduped);
        }
    }
    debug_log(
        shared,
        format!("Kept {} usage entries after deduplication", deduped.len()),
    );
    Ok(deduped)
}
```

Remove the old `let paths = claude_paths()?;` block from the previous `load_entries_inner` body so there is only one implementation.

- [ ] **Step 4: Expose explicit-path daily summary helper**

In `rust/crates/ccusage/src/adapter/claude/mod.rs`, change daily entry points to:

```rust
pub(crate) fn load_daily_summaries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    progress::track_usage_load(progress::UsageLoadAgent::Claude, shared.json, || {
        let paths = claude_paths()?;
        daily::load_daily_summaries_from_paths(shared, &paths, project_filter, group_by_project)
    })
}

pub(crate) fn load_daily_summaries_from_paths(
    shared: &SharedArgs,
    paths: &[PathBuf],
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    daily::load_daily_summaries_from_paths(shared, paths, project_filter, group_by_project)
}
```

In `rust/crates/ccusage/src/adapter/claude/daily.rs`, replace the top of the loader with:

```rust
pub(super) fn load_daily_summaries_from_paths(
    shared: &SharedArgs,
    paths: &[PathBuf],
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    let files = usage_files(paths, project_filter);
    if files.is_empty() {
        return Ok(Vec::new());
    }
    // keep the existing function body from pricing onward unchanged
}
```

Remove the direct `claude_paths()?` call from `daily.rs`. Remove the now-unused import of `claude_paths` from the `use super::paths::{...}` list.

- [ ] **Step 5: Make path normalization reusable**

In `rust/crates/ccusage/src/adapter/claude/paths.rs`, change:

```rust
fn normalize_claude_config_path(raw: &str) -> PathBuf
fn expand_home_path(raw: &str) -> PathBuf
```

to:

```rust
pub(crate) fn normalize_claude_config_path(raw: &str) -> PathBuf
pub(crate) fn expand_home_path(raw: &str) -> PathBuf
```

In `rust/crates/ccusage/src/adapter/claude/mod.rs`, add `normalize_claude_config_path` to the existing `pub(crate) use paths::{...}` list.

- [ ] **Step 6: Run the targeted test and verify it passes**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage loads_claude_compatible_entries_from_explicit_config_paths -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Run existing Claude loader tests**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage claude -- --nocapture
```

Expected: PASS. Existing Claude behavior must not change.

- [ ] **Step 8: Commit Claude loader refactor**

Run:

```bash
git add rust/crates/ccusage/src/adapter/claude/mod.rs rust/crates/ccusage/src/adapter/claude/daily.rs rust/crates/ccusage/src/adapter/claude/paths.rs rust/crates/ccusage/src/main.rs
git diff --staged
git commit -m "refactor(claude): share compatible usage loaders"
```

---

### Task 3: Add Cowork Path Discovery

**Files:**

- Create: `rust/crates/ccusage/src/adapter/cowork/paths.rs`
- Create: `rust/crates/ccusage/src/adapter/cowork/mod.rs`
- Modify: `rust/crates/ccusage/src/adapter/mod.rs`

- [ ] **Step 1: Create Cowork module shell and failing path tests**

Create `rust/crates/ccusage/src/adapter/cowork/mod.rs`:

```rust
mod paths;

#[cfg(test)]
pub(crate) use paths::cowork_paths_from_root;
```

Add to `rust/crates/ccusage/src/adapter/mod.rs`:

```rust
pub(crate) mod cowork;
```

Create `rust/crates/ccusage/src/adapter/cowork/paths.rs` with tests first:

```rust
use std::path::{Path, PathBuf};

use crate::Result;

pub(crate) fn cowork_paths() -> Result<Vec<PathBuf>> {
    Ok(Vec::new())
}

#[cfg(test)]
pub(crate) fn cowork_paths_from_root(_root: &Path) -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use ccusage_test_support::fs_fixture;

    use super::cowork_paths_from_root;

    #[test]
    fn discovers_local_agent_mode_claude_config_dirs() {
        let fixture = fs_fixture!({
            "workspace-a/session-a/local_111/.claude/projects/project-a/session-a.jsonl": "",
            "workspace-a/session-a/local_222/.claude/projects/project-b/session-b.jsonl": "",
            "workspace-a/session-a/not-local/.claude/projects/project-c/session-c.jsonl": "",
            "workspace-b/session-b/local_333/no-claude/projects/project-d/session-d.jsonl": "",
        });

        let paths = cowork_paths_from_root(fixture.root());

        assert_eq!(
            paths,
            vec![
                fixture.path("workspace-a/session-a/local_111/.claude"),
                fixture.path("workspace-a/session-a/local_222/.claude"),
            ]
        );
    }
}
```

- [ ] **Step 2: Run the path discovery test and verify failure**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage discovers_local_agent_mode_claude_config_dirs -- --nocapture
```

Expected: FAIL because discovery returns an empty vector.

- [ ] **Step 3: Implement recursive Cowork discovery**

Replace `cowork_paths_from_root` in `paths.rs` with:

```rust
pub(crate) fn cowork_paths() -> Result<Vec<PathBuf>> {
    if let Ok(env_paths) = std::env::var("COWORK_CONFIG_DIR") {
        return cowork_paths_from_env(&env_paths);
    }
    let home = crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
    Ok(cowork_paths_from_root(
        &home.join("Library/Application Support/Claude/local-agent-mode-sessions"),
    ))
}

fn cowork_paths_from_env(env_paths: &str) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = crate::fast::FxHashSet::default();
    for raw in env_paths
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = crate::adapter::claude::normalize_claude_config_path(raw);
        if path.join("projects").is_dir() {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
            continue;
        }
        for discovered in cowork_paths_from_root(&path) {
            if seen.insert(discovered.clone()) {
                paths.push(discovered);
            }
        }
    }
    if paths.is_empty() {
        return Err(crate::cli_error(format!(
            "No valid Cowork data directories found in COWORK_CONFIG_DIR. Expected each path to be a Cowork local-agent-mode-sessions directory, a .claude config directory containing 'projects/', or the 'projects/' directory itself: {env_paths}"
        )));
    }
    Ok(paths)
}

pub(crate) fn cowork_paths_from_root(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_cowork_paths(root, &mut paths);
    paths.sort_by_cached_key(|path| path.to_string_lossy().into_owned());
    paths
}

fn collect_cowork_paths(dir: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(std::result::Result::ok) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("local_"))
        {
            let config = path.join(".claude");
            if config.join("projects").is_dir() {
                paths.push(config);
            }
        }
        collect_cowork_paths(&path, paths);
    }
}
```

- [ ] **Step 4: Add env override tests**

Add these tests to `paths.rs`:

```rust
#[test]
fn accepts_direct_claude_and_projects_env_paths() {
    let fixture = fs_fixture!({
        "direct/.claude/projects/project-a/session-a.jsonl": "",
        "other/.claude/projects/project-b/session-b.jsonl": "",
    });

    let paths = super::cowork_paths_from_env(&format!(
        "{},{}",
        fixture.path("direct/.claude").display(),
        fixture.path("other/.claude/projects").display()
    ))
    .unwrap();

    assert_eq!(
        paths,
        vec![
            fixture.path("direct/.claude"),
            fixture.path("other/.claude"),
        ]
    );
}

#[test]
fn rejects_invalid_cowork_env_paths() {
    let fixture = fs_fixture!({
        "empty": "",
    });

    let error = super::cowork_paths_from_env(&fixture.path("empty").display().to_string())
        .unwrap_err()
        .to_string();

    assert!(error.contains("No valid Cowork data directories found in COWORK_CONFIG_DIR"));
}
```

- [ ] **Step 5: Run path tests and verify they pass**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage cowork::paths -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Commit Cowork path discovery**

Run:

```bash
git add rust/crates/ccusage/src/adapter/mod.rs rust/crates/ccusage/src/adapter/cowork/mod.rs rust/crates/ccusage/src/adapter/cowork/paths.rs rust/crates/ccusage/src/adapter/claude/mod.rs rust/crates/ccusage/src/adapter/claude/paths.rs
git diff --staged
git commit -m "feat(cowork): discover local agent sessions"
```

---

### Task 4: Add Cowork Runtime Adapter

**Files:**

- Modify: `rust/crates/ccusage/src/adapter/cowork/mod.rs`
- Modify: `rust/crates/ccusage/src/main.rs`
- Modify: `rust/crates/ccusage/src/progress.rs`

- [ ] **Step 1: Add failing Cowork loader/runtime tests**

Add this test module to `rust/crates/ccusage/src/adapter/cowork/mod.rs`:

```rust
use crate::{
    cli::{AgentReportKind, SharedArgs},
    Result, UsageSummary,
};

pub(crate) fn load_entries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<crate::LoadedEntry>> {
    crate::adapter::claude::load_entries_from_paths(
        shared,
        &paths::cowork_paths()?,
        project_filter,
        "Cowork",
    )
}

pub(crate) fn load_daily_summaries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    crate::adapter::claude::load_daily_summaries_from_paths(
        shared,
        &paths::cowork_paths()?,
        project_filter,
        group_by_project,
    )
}

#[cfg(test)]
mod tests {
    use std::{env, ffi::OsString, path::Path, sync::Mutex};

    use ccusage_test_support::fs_fixture;

    use super::*;
    use crate::cli::{CostMode, SharedArgs};

    static COWORK_CONFIG_DIR_LOCK: Mutex<()> = Mutex::new(());

    struct CoworkConfigDirGuard {
        previous: Option<OsString>,
    }

    impl CoworkConfigDirGuard {
        fn set(path: &Path) -> Self {
            let previous = env::var_os("COWORK_CONFIG_DIR");
            env::set_var("COWORK_CONFIG_DIR", path);
            Self { previous }
        }
    }

    impl Drop for CoworkConfigDirGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                env::set_var("COWORK_CONFIG_DIR", previous);
            } else {
                env::remove_var("COWORK_CONFIG_DIR");
            }
        }
    }

    #[test]
    fn loads_cowork_daily_summaries_from_local_agent_sessions() {
        let _lock = COWORK_CONFIG_DIR_LOCK.lock().unwrap();
        let fixture = fs_fixture!({
            "workspace/session/local_111/.claude/projects/project-a/session-a.jsonl": r#"{"timestamp":"2025-01-10T10:00:00.000Z","version":"2.1.142","sessionId":"session-a","message":{"id":"msg_a","model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":5}},"requestId":"req_a","costUSD":0.01}"#,
        });
        let _guard = CoworkConfigDirGuard::set(fixture.root());
        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };

        let rows = load_daily_summaries(&shared, None, false).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date.as_deref(), Some("2025-01-10"));
        assert_eq!(rows[0].input_tokens, 100);
        assert_eq!(rows[0].output_tokens, 25);
        assert_eq!(rows[0].cache_creation_tokens, 10);
        assert_eq!(rows[0].cache_read_tokens, 5);
    }

    #[test]
    fn loads_cowork_entries_with_session_and_project_metadata() {
        let _lock = COWORK_CONFIG_DIR_LOCK.lock().unwrap();
        let fixture = fs_fixture!({
            "workspace/session/local_111/.claude/projects/project-a/session-a.jsonl": r#"{"timestamp":"2025-01-10T10:00:00.000Z","version":"2.1.142","sessionId":"session-a","message":{"id":"msg_a","model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":5}},"requestId":"req_a","costUSD":0.01}"#,
        });
        let _guard = CoworkConfigDirGuard::set(fixture.root());
        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };

        let entries = load_entries(&shared, None).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].project.as_ref(), "project-a");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].project_path.as_ref(), "project-a");
    }
}
```

- [ ] **Step 2: Run Cowork tests and verify failure**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage cowork -- --nocapture
```

Expected: FAIL until the module compiles with the shared Claude helper exports and progress label.

- [ ] **Step 3: Add Cowork progress label**

In `rust/crates/ccusage/src/progress.rs`, add:

```rust
Cowork,
```

to `UsageLoadAgent`, and add this match arm:

```rust
UsageLoadAgent::Cowork => "Cowork",
```

- [ ] **Step 4: Implement Cowork run function**

Replace `cowork/mod.rs` top-level runtime with:

```rust
mod paths;

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::{
    cli::{AgentCommandArgs, AgentReportKind, SharedArgs, WeekDay},
    print_json_or_jq, print_usage_table, sort_summaries, summarize_summaries_by_bucket,
    totals_json, wants_json, BucketKind, Result, SessionAccumulator, UsageSummary,
};

#[cfg(test)]
pub(crate) use paths::cowork_paths_from_root;

pub(crate) fn load_entries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<crate::LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Cowork, shared.json, || {
        crate::adapter::claude::load_entries_from_paths(
            shared,
            &paths::cowork_paths()?,
            project_filter,
            "Cowork",
        )
    })
}

pub(crate) fn load_daily_summaries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Cowork, shared.json, || {
        crate::adapter::claude::load_daily_summaries_from_paths(
            shared,
            &paths::cowork_paths()?,
            project_filter,
            group_by_project,
        )
    })
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let mut rows = load_summaries(&args.shared, args.kind)?;
    sort_summaries(&mut rows, &args.shared.order, |row| {
        crate::adapter::opencode::summary_period(row)
    });
    if wants_json(&args.shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), args.shared.jq.as_deref());
    }
    print_usage_table(
        "Cowork Token Usage Report",
        crate::adapter::opencode::first_column(args.kind),
        &rows,
        &args.shared,
        false,
        None,
    )?;
    Ok(())
}

fn load_summaries(shared: &SharedArgs, kind: AgentReportKind) -> Result<Vec<UsageSummary>> {
    match kind {
        AgentReportKind::Daily => {
            let mut rows = load_daily_summaries(shared, None, false)?;
            filter_daily_summaries_by_date(&mut rows, shared);
            Ok(rows)
        }
        AgentReportKind::Monthly => {
            let mut daily = load_daily_summaries(shared, None, false)?;
            filter_daily_summaries_by_date(&mut daily, shared);
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Monthly,
                WeekDay::Sunday,
            ))
        }
        AgentReportKind::Weekly => unreachable!("cowork parser does not expose weekly reports"),
        AgentReportKind::Session => {
            let entries = load_entries(shared, None)?;
            let mut rows = summarize_sessions(&entries, shared.timezone.as_deref())?;
            filter_session_summaries(&mut rows, shared);
            Ok(rows)
        }
    }
}

fn summarize_sessions(
    entries: &[crate::LoadedEntry],
    timezone: Option<&str>,
) -> Result<Vec<UsageSummary>> {
    let mut groups = BTreeMap::<(String, String), SessionAccumulator>::new();
    for entry in entries {
        groups
            .entry((entry.project_path.to_string(), entry.session_id.to_string()))
            .or_default()
            .add_entry(entry);
    }
    groups
        .into_values()
        .map(|group| group.into_summary(timezone))
        .collect()
}

fn filter_daily_summaries_by_date(rows: &mut Vec<UsageSummary>, shared: &SharedArgs) {
    if shared.since.is_none() && shared.until.is_none() {
        return;
    }
    rows.retain(|row| {
        let date = row.date.as_deref().unwrap_or_default().replace('-', "");
        shared.since.as_ref().is_none_or(|since| &date >= since)
            && shared.until.as_ref().is_none_or(|until| &date <= until)
    });
}

fn filter_session_summaries(rows: &mut Vec<UsageSummary>, shared: &SharedArgs) {
    if shared.since.is_some() || shared.until.is_some() {
        rows.retain(|row| {
            let date = row
                .last_activity
                .as_deref()
                .unwrap_or_default()
                .replace('-', "");
            shared.since.as_ref().is_none_or(|since| &date >= since)
                && shared.until.as_ref().is_none_or(|until| &date <= until)
        });
    }
}

fn report_from_rows(rows: &[UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| {
            crate::adapter::opencode::agent_summary_json(
                row,
                kind,
                kind == AgentReportKind::Session,
            )
        })
        .collect::<Vec<_>>();
    json!({
        rows_key(kind): rows_json,
        "totals": totals_json(rows),
    })
}

fn rows_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "daily",
        AgentReportKind::Weekly => "weekly",
        AgentReportKind::Monthly => "monthly",
        AgentReportKind::Session => "sessions",
    }
}
```

- [ ] **Step 5: Dispatch Cowork from main**

In `rust/crates/ccusage/src/main.rs`, add:

```rust
Some(Command::Cowork(args)) => adapter::cowork::run(args),
```

near other agent command dispatch arms.

- [ ] **Step 6: Run Cowork runtime tests**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage cowork -- --nocapture
```

Expected: PASS.

- [ ] **Step 7: Commit Cowork runtime adapter**

Run:

```bash
git add rust/crates/ccusage/src/adapter/cowork rust/crates/ccusage/src/adapter/mod.rs rust/crates/ccusage/src/main.rs rust/crates/ccusage/src/progress.rs
git diff --staged
git commit -m "feat(cowork): add usage report adapter"
```

---

### Task 5: Add Cowork to All-Agent Reports

**Files:**

- Modify: `rust/crates/ccusage/src/adapter/all/loader.rs`
- Modify: `rust/crates/ccusage/src/adapter/all/tests.rs`

- [ ] **Step 1: Add failing all-agent aggregation test**

Add this unit test to `rust/crates/ccusage/src/adapter/all/tests.rs`:

```rust
#[test]
fn aggregates_claude_and_cowork_as_separate_agents() {
    let rows = aggregate_rows(
        vec![
            AllRow {
                period: "2025-01-10".to_string(),
                agent: "claude",
                models_used: vec!["claude-opus-4-6".to_string()],
                input_tokens: 100,
                output_tokens: 10,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 110,
                total_cost: 0.01,
                metadata: None,
                metadata_agents: Some(vec!["claude"]),
                agent_breakdowns: None,
                model_breakdowns: Vec::new(),
            },
            AllRow {
                period: "2025-01-10".to_string(),
                agent: "cowork",
                models_used: vec!["claude-opus-4-6".to_string()],
                input_tokens: 200,
                output_tokens: 20,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 220,
                total_cost: 0.02,
                metadata: None,
                metadata_agents: Some(vec!["cowork"]),
                agent_breakdowns: None,
                model_breakdowns: Vec::new(),
            },
        ],
        AgentReportKind::Daily,
    );

    assert_eq!(rows.len(), 1);
    let breakdowns = rows[0].agent_breakdowns.as_ref().unwrap();
    assert_eq!(breakdowns.len(), 2);
    assert_eq!(breakdowns[0].agent, "claude");
    assert_eq!(breakdowns[1].agent, "cowork");
    assert_eq!(rows[0].metadata_agents.as_ref().unwrap(), &vec!["claude", "cowork"]);
}
```

- [ ] **Step 2: Run all-agent tests**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage adapter::all -- --nocapture
```

Expected: existing tests pass; new aggregation test should pass already because aggregation is label-based. If it fails because ordering differs, sort expectation to match current `agent_breakdowns.sort_by(|a, b| a.agent.cmp(b.agent))`.

- [ ] **Step 3: Wire Cowork into loader specs**

In `rust/crates/ccusage/src/adapter/all/loader.rs`, add `cowork` to the adapter imports:

```rust
cowork,
```

Add a new `AgentLoadSpec` after Claude:

```rust
AgentLoadSpec {
    index: 1,
    agent: "cowork",
    progress_agent: crate::progress::UsageLoadAgent::Cowork,
    load: Box::new(|| load_cowork_rows(load_kind, &loader_shared)),
},
```

Increment later `index` values by 1. Do not leave duplicate indexes.

Add:

```rust
fn load_cowork_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    if kind == AgentReportKind::Session {
        return load_session_capable_summary_agent_rows(
            "cowork",
            kind,
            shared,
            cowork::load_entries,
            summarize_entries,
        );
    }

    let mut summaries = cowork::load_daily_summaries(shared, None, false)?;
    let detected = !summaries.is_empty();
    filter_daily_summaries_by_date(&mut summaries, shared);
    Ok(AgentRows {
        rows: summary_rows("cowork", summaries),
        detected,
    })
}
```

- [ ] **Step 4: Run all-agent tests again**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage adapter::all -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit all-agent integration**

Run:

```bash
git add rust/crates/ccusage/src/adapter/all/loader.rs rust/crates/ccusage/src/adapter/all/tests.rs
git diff --staged
git commit -m "feat(cowork): include source in all-agent reports"
```

---

### Task 6: Add Source README and User-Facing Docs

**Files:**

- Create: `rust/crates/ccusage/src/adapter/cowork/README.md`
- Modify: `README.md`
- Modify: `apps/ccusage/README.md`
- Modify: matching `docs/guide/` files found by search

- [ ] **Step 1: Find docs that mention supported agents**

Run:

```bash
rg -n "Claude Code|Codex|OpenCode|Amp|supported agents|agent sources|ccusage (codex|opencode|amp|all)" README.md apps/ccusage/README.md docs/guide
```

Expected: list of docs that need Cowork added.

- [ ] **Step 2: Add Cowork adapter README**

Create `rust/crates/ccusage/src/adapter/cowork/README.md`:

```markdown
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
```

- [ ] **Step 3: Update public docs**

In each supported-agent list found in Step 1, add Cowork with wording matching the surrounding style:

```markdown
- Cowork (`ccusage cowork`) - Claude Desktop local agent mode usage
```

Where command examples are listed, add:

```bash
ccusage cowork daily
ccusage cowork monthly
ccusage cowork session
```

Do not add `ccusage cowork weekly`, blocks, or statusline examples.

- [ ] **Step 4: Run docs-related checks that do not need network**

Run:

```bash
pnpm run lint:oxfmt
```

Expected: PASS or formatting diffs reported. If formatting diffs are reported, run `pnpm run format` in Task 7.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add rust/crates/ccusage/src/adapter/cowork/README.md README.md apps/ccusage/README.md docs/guide
git diff --staged
git commit -m "docs(cowork): document usage source"
```

---

### Task 7: Final Verification and Cleanup

**Files:**

- No planned source edits unless verification exposes issues.

- [ ] **Step 1: Run formatter**

Run:

```bash
pnpm run format
```

Expected: completes successfully. If files change, inspect the diff.

- [ ] **Step 2: Run targeted Rust tests**

Run:

```bash
cargo test --manifest-path rust/Cargo.toml -p ccusage-cli cowork -- --nocapture
cargo test --manifest-path rust/Cargo.toml -p ccusage cowork -- --nocapture
cargo test --manifest-path rust/Cargo.toml -p ccusage adapter::all -- --nocapture
cargo test --manifest-path rust/Cargo.toml -p ccusage claude -- --nocapture
```

Expected: all PASS.

- [ ] **Step 3: Run repository-required checks**

Run:

```bash
pnpm typecheck
pnpm run test
```

Expected: all PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff
```

Expected: only intended formatting or final cleanup changes remain.

- [ ] **Step 5: Commit verification cleanup if needed**

If formatting or cleanup changed files, run:

```bash
git add .
git diff --staged
git commit -m "chore(cowork): apply formatting"
```

If no files changed, do not create an empty commit.

- [ ] **Step 6: Record final status**

Run:

```bash
git log --oneline --decorate -5
git status
```

Expected: branch `feat/cowork-usage-source` is clean and contains the Cowork commits.
