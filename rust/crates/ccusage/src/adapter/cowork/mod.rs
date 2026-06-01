mod paths;

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::{
    adapter::claude,
    cli::{AgentCommandArgs, AgentReportKind, SharedArgs, WeekDay},
    filter_and_sort_summaries, print_json_or_jq, print_usage_table, progress, sort_summaries,
    summarize_summaries_by_bucket, totals_json, wants_json, BucketKind, LoadedEntry, Result,
    SessionAccumulator, UsageSummary,
};

pub(crate) fn load_entries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    progress::track_usage_load(progress::UsageLoadAgent::Cowork, shared.json, || {
        claude::load_entries_from_paths(shared, &paths::cowork_paths()?, project_filter, "Cowork")
    })
}

pub(crate) fn load_daily_summaries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    progress::track_usage_load(progress::UsageLoadAgent::Cowork, shared.json, || {
        claude::load_daily_summaries_from_paths(
            shared,
            &paths::cowork_paths()?,
            project_filter,
            group_by_project,
        )
    })
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let rows = match args.kind {
        AgentReportKind::Daily => {
            let mut rows = load_daily_summaries(&shared, None, false)?;
            filter_and_sort_summaries(&mut rows, &shared, |row| {
                row.date.as_deref().unwrap_or_default()
            });
            rows
        }
        AgentReportKind::Monthly => {
            let mut daily = load_daily_summaries(&shared, None, false)?;
            filter_and_sort_summaries(&mut daily, &shared, |row| {
                row.date.as_deref().unwrap_or_default()
            });
            let mut monthly =
                summarize_summaries_by_bucket(&daily, BucketKind::Monthly, WeekDay::Sunday);
            sort_summaries(&mut monthly, &shared.order, |row| {
                row.month.as_deref().unwrap_or_default()
            });
            monthly
        }
        AgentReportKind::Session => {
            let entries = load_entries(&shared, None)?;
            let mut rows = summarize_sessions(&entries, shared.timezone.as_deref())?;
            filter_session_summaries(&mut rows, &shared);
            sort_summaries(&mut rows, &shared.order, |row| {
                super::opencode::summary_period(row)
            });
            rows
        }
        AgentReportKind::Weekly => unreachable!("Cowork weekly reports are not exposed by CLI"),
    };

    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }

    print_usage_table(
        "Cowork Token Usage Report",
        super::opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    )?;
    Ok(())
}

fn summarize_sessions(
    entries: &[LoadedEntry],
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

fn filter_session_summaries(rows: &mut Vec<UsageSummary>, shared: &SharedArgs) {
    if shared.since.is_none() && shared.until.is_none() {
        return;
    }
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

fn report_from_rows(rows: &[UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| super::opencode::agent_summary_json(row, kind, kind == AgentReportKind::Session))
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

#[cfg(test)]
mod tests {
    use std::{env, ffi::OsString, path::Path, sync::Mutex};

    use ccusage_test_support::fs_fixture;
    use serde_json::json;

    use super::*;
    use crate::cli::{AgentReportKind, CostMode, SharedArgs};

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

    #[test]
    fn builds_cowork_session_report_with_session_metadata() {
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
        let rows = summarize_sessions(&entries, shared.timezone.as_deref()).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Session);

        assert_eq!(report["sessions"][0]["sessionId"], "session-a");
        assert_eq!(report["sessions"][0]["projectPath"], "project-a");
        assert_eq!(report["sessions"][0]["lastActivity"], "2025-01-10");
        assert_eq!(
            report["sessions"][0]["modelsUsed"],
            json!(["claude-opus-4-6"])
        );
    }
}
