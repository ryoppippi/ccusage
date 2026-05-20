mod parser;
mod paths;

use serde_json::{json, Value};

use crate::{
    cli::{AgentCommandArgs, AgentReportKind, SharedArgs, WeekDay},
    filter_loaded_entries_by_date, print_json_or_jq, print_usage_table, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    DateFilter, LoadedEntry, Result, SessionAccumulator,
};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let mut entries = load_entries(&args.shared)?;
    let mut rows = if args.kind == AgentReportKind::Session {
        summarize_entries(&entries, args.kind)?
    } else {
        filter_loaded_entries_by_date(&mut entries, &args.shared);
        summarize_entries(&entries, args.kind)?
    };
    if args.kind == AgentReportKind::Session {
        filter_session_summaries(&mut rows, &args.shared);
    }
    sort_summaries(&mut rows, &args.shared.order, |row| {
        super::opencode::summary_period(row)
    });
    if wants_json(&args.shared) {
        return print_json_or_jq(
            report_from_rows(&rows, args.kind),
            args.shared.jq.as_deref(),
        );
    }
    print_usage_table(
        "Qwen Token Usage Report",
        super::opencode::first_column(args.kind),
        &rows,
        &args.shared,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn load_entries(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Qwen, shared.json, || {
        parser::load_entries(shared)
    })
}

pub(crate) fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| super::opencode::agent_summary_json(row, kind, kind == AgentReportKind::Session))
        .collect::<Vec<_>>();
    json!({
        rows_key(kind): rows_json,
        "totals": if rows.is_empty() { Value::Null } else { totals_json(rows) },
    })
}

pub(crate) fn summarize_entries(
    entries: &[LoadedEntry],
    kind: AgentReportKind,
) -> Result<Vec<crate::UsageSummary>> {
    match kind {
        AgentReportKind::Daily => summarize_by_key(
            entries,
            |entry| entry.date.clone(),
            |date| (date.to_string(), None),
        ),
        AgentReportKind::Monthly => {
            let daily = summarize_entries(entries, AgentReportKind::Daily)?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Monthly,
                WeekDay::Sunday,
            ))
        }
        AgentReportKind::Session => {
            let mut groups = std::collections::BTreeMap::<String, SessionAccumulator>::new();
            for entry in entries {
                groups
                    .entry(entry.session_id.to_string())
                    .or_default()
                    .add_entry(entry);
            }
            groups
                .into_values()
                .map(|group| group.into_summary(None))
                .collect()
        }
        AgentReportKind::Weekly => Ok(Vec::new()),
    }
}

fn rows_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "daily",
        AgentReportKind::Weekly => "weekly",
        AgentReportKind::Monthly => "monthly",
        AgentReportKind::Session => "sessions",
    }
}

fn filter_session_summaries(rows: &mut Vec<crate::UsageSummary>, shared: &SharedArgs) {
    let date_filter = DateFilter::new(shared.since.as_deref(), shared.until.as_deref());
    if !date_filter.is_empty() {
        rows.retain(|row| {
            let date = row
                .last_activity
                .as_deref()
                .unwrap_or_default()
                .replace('-', "");
            date_filter.contains_compact_date(&date)
        });
    }
}

pub(crate) fn has_data() -> bool {
    paths::discover_chat_files().is_ok_and(|files| !files.is_empty())
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        ffi::OsString,
        fs,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use serde_json::json;

    use super::*;
    use crate::cli::{CostMode, SharedArgs};
    use crate::UsageSummary;

    static QWEN_DATA_DIR_LOCK: Mutex<()> = Mutex::new(());

    struct QwenDataDirGuard {
        previous: Option<OsString>,
    }

    impl QwenDataDirGuard {
        fn set(path: &Path) -> Self {
            let previous = env::var_os("QWEN_DATA_DIR");
            env::set_var("QWEN_DATA_DIR", path);
            Self { previous }
        }
    }

    impl Drop for QwenDataDirGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                env::set_var("QWEN_DATA_DIR", previous);
            } else {
                env::remove_var("QWEN_DATA_DIR");
            }
        }
    }

    fn temp_qwen_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-qwen-{name}-{nanos}"));
        path
    }

    #[test]
    fn loads_qwen_jsonl_usage_entries() {
        let qwen_dir = temp_qwen_dir("entries");
        let chat_dir = qwen_dir.join("projects/myProject/chats");
        fs::create_dir_all(&chat_dir).unwrap();
        fs::write(
            chat_dir.join("chat-a.jsonl"),
            [
                r#"{"type":"user","text":"hello"}"#,
                r#"{"type":"assistant","model":"qwen3-coder-plus","timestamp":"2026-02-23T14:24:56.857Z","sessionId":"session-json","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"thoughtsTokenCount":10,"cachedContentTokenCount":5}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let _lock = QWEN_DATA_DIR_LOCK.lock().unwrap();
        let _guard = QwenDataDirGuard::set(&qwen_dir);
        let entries = load_entries(&shared).unwrap();
        fs::remove_dir_all(&qwen_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-02-23");
        assert_eq!(entries[0].session_id.as_ref(), "session-json");
        assert_eq!(entries[0].project_path.as_ref(), "myProject");
        assert_eq!(entries[0].model.as_deref(), Some("qwen3-coder-plus"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 5);
        assert_eq!(entries[0].extra_total_tokens, 10);
    }

    #[test]
    fn builds_qwen_daily_json_report_with_reasoning_in_total() {
        let qwen_dir = temp_qwen_dir("report");
        let chat_dir = qwen_dir.join("projects/myProject/chats");
        fs::create_dir_all(&chat_dir).unwrap();
        fs::write(
            chat_dir.join("chat-a.jsonl"),
            r#"{"type":"assistant","model":"qwen3-coder-plus","timestamp":"2026-02-23T14:24:56.857Z","sessionId":"session-json","usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":50,"thoughtsTokenCount":10,"cachedContentTokenCount":5}}"#,
        )
        .unwrap();

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let _lock = QWEN_DATA_DIR_LOCK.lock().unwrap();
        let _guard = QwenDataDirGuard::set(&qwen_dir);
        let entries = load_entries(&shared).unwrap();
        let rows = summarize_entries(&entries, AgentReportKind::Daily).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Daily);
        fs::remove_dir_all(&qwen_dir).unwrap();

        assert_eq!(report["daily"][0]["date"], "2026-02-23");
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["cacheReadTokens"], 5);
        assert_eq!(report["daily"][0]["totalTokens"], 165);
        assert_eq!(
            report["daily"][0]["modelsUsed"],
            json!(["qwen3-coder-plus"])
        );
    }

    #[test]
    fn filters_session_summaries_with_iso_date_bounds() {
        let mut rows = vec![
            usage_summary("before", "2026-02-22"),
            usage_summary("inside", "2026-02-23"),
            usage_summary("after", "2026-02-24"),
        ];
        let shared = SharedArgs {
            since: Some("2026-02-23".to_string()),
            until: Some("2026-02-23".to_string()),
            ..SharedArgs::default()
        };

        filter_session_summaries(&mut rows, &shared);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id.as_deref(), Some("inside"));
    }

    fn usage_summary(session_id: &str, last_activity: &str) -> UsageSummary {
        UsageSummary {
            date: None,
            month: None,
            week: None,
            session_id: Some(session_id.to_string()),
            project_path: None,
            last_activity: Some(last_activity.to_string()),
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            extra_total_tokens: 0,
            total_cost: 0.0,
            credits: None,
            message_count: None,
            models_used: Vec::new(),
            model_breakdowns: Vec::new(),
            project: None,
            versions: None,
        }
    }
}
