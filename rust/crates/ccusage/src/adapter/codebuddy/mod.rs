// CodeBuddy source adapter.
//
// Reads Tencent CodeBuddy Code session transcripts from
// ~/.codebuddy/projects/<dir-slug>/<uuid>.jsonl  (main sessions)
// ~/.codebuddy/projects/<dir-slug>/<uuid>/subagents/agent-*.jsonl  (subagents)

mod loader;
mod parser;
mod paths;
mod report;

use crate::{
    cli::AgentCommandArgs, filter_loaded_entries_by_date, print_json_or_jq, print_usage_table,
    sort_summaries, wants_json, Result,
};

pub(crate) use loader::load_entries;
pub(crate) use report::{report_from_rows, summarize_entries};

#[cfg(test)]
pub(super) static CODEBUDDY_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let mut entries = load_entries(&args.shared, args.codebuddy_path.as_deref())?;
    filter_loaded_entries_by_date(&mut entries, &args.shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
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
        "CodeBuddy Token Usage Report",
        super::opencode::first_column(args.kind),
        &rows,
        &args.shared,
        false,
        None,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::AgentReportKind;
    use crate::{LoadedEntry, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage};
    use std::sync::Arc;

    fn entry(
        date: &str,
        ts_ms: i64,
        sess: &str,
        input: u64,
        output: u64,
        cache_w: u64,
        cache_r: u64,
    ) -> LoadedEntry {
        let usage = TokenUsageRaw {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cache_w,
            cache_read_input_tokens: cache_r,
            speed: None,
        };
        LoadedEntry {
            data: UsageEntry {
                session_id: Some(sess.to_string()),
                timestamp: format!("{date}T00:00:00.000Z"),
                version: None,
                message: UsageMessage {
                    usage,
                    model: Some("[codebuddy] MaaS_Cl_Opus_4.7_20260416_cache".to_string()),
                    id: None,
                },
                cost_usd: Some(0.0),
                request_id: Some(format!("chatcmpl-{sess}-{ts_ms}")),
                is_api_error_message: None,
                is_sidechain: None,
            },
            timestamp: TimestampMs::from_millis(ts_ms),
            date: date.to_string(),
            project: Arc::from("/Users/example/proj"),
            session_id: Arc::from(sess),
            project_path: Arc::from("/Users/example/proj"),
            cost: 0.0,
            extra_total_tokens: 0,
            credits: None,
            message_count: None,
            model: Some("[codebuddy] MaaS_Cl_Opus_4.7_20260416_cache".to_string()),
            usage_limit_reset_time: None,
            missing_pricing_model: Some("codebuddy".to_string()),
        }
    }

    #[test]
    fn codebuddy_reports_for_periods_match_snapshot() {
        // Timestamps are UTC midnight on 2026-05-30 and 2026-05-31.
        // Computed via:
        //   date -u -j -f '%Y-%m-%d %H:%M:%S' '2026-05-30 00:00:00' +%s
        //     -> 1780099200  (* 1000 = 1_780_099_200_000)
        //   date -u -j -f '%Y-%m-%d %H:%M:%S' '2026-05-31 00:00:00' +%s
        //     -> 1780185600  (* 1000 = 1_780_185_600_000)
        let entries = vec![
            entry("2026-05-30", 1_780_099_200_000, "sess-A", 1000, 100, 800, 0),
            entry("2026-05-31", 1_780_185_600_000, "sess-A", 1500, 50, 0, 1400),
            entry("2026-05-31", 1_780_185_700_000, "sess-B", 200, 20, 150, 0),
        ];

        let kinds = [
            ("daily", AgentReportKind::Daily),
            ("monthly", AgentReportKind::Monthly),
            ("session", AgentReportKind::Session),
        ];
        let mut output = serde_json::Map::new();
        for (label, kind) in kinds {
            let rows = summarize_entries(&entries, kind).unwrap();
            let report = report_from_rows(&rows, kind);
            output.insert(label.to_string(), serde_json::to_value(&report).unwrap());
        }

        insta::assert_json_snapshot!(serde_json::Value::Object(output));
    }
}
