use std::{
    env, fs,
    path::PathBuf,
    sync::Arc,
};

use serde_json::Value;

use crate::{
    cli::{AgentReportKind, SharedArgs, WeekDay},
    filter_loaded_entries_by_date, format_date_tz, format_rfc3339_millis, parse_ts_timestamp,
    parse_tz, print_json_or_jq, print_usage_table, sort_summaries, summarize_by_key,
    summarize_summaries_by_bucket, totals_json, wants_json, BucketKind, LoadedEntry, PricingMap,
    Result, TokenUsageRaw, UsageEntry, UsageMessage, UsageSummary, SessionAccumulator,
};

const ANTIGRAVITY_DATA_DIR_ENV: &str = "ANTIGRAVITY_DATA_DIR";
const DEFAULT_ANTIGRAVITY_MODEL: &str = "gemini-3.5-flash";

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AntigravityHistoryLine {
    conversation_id: Option<String>,
    display: Option<String>,
    timestamp: Option<u64>,
    workspace: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct AntigravityTranscriptStep {
    source: Option<String>,
    #[serde(rename = "type")]
    step_type: Option<String>,
    created_at: Option<String>,
}

pub(crate) fn run(args: crate::cli::AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(
        &mut rows,
        &shared.order,
        crate::adapter::opencode::summary_period,
    );
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    print_usage_table(
        "Antigravity CLI Token Usage Report",
        crate::adapter::opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| crate::adapter::opencode::agent_summary_json(row, kind, false))
        .collect::<Vec<_>>();
    serde_json::json!({
        rows_key(kind): rows_json,
        "totals": if rows.is_empty() { Value::Null } else { totals_json(rows) },
    })
}

pub(crate) fn summarize_entries(
    entries: &[LoadedEntry],
    kind: AgentReportKind,
) -> Result<Vec<UsageSummary>> {
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

pub(crate) fn load_entries(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Antigravity, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(shared: &SharedArgs, _pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let Some(data_dir) = antigravity_data_dir() else {
        return Ok(Vec::new());
    };
    let history_path = data_dir.join("history.jsonl");
    if !history_path.is_file() {
        return Ok(Vec::new());
    };
    let history_content = match fs::read_to_string(&history_path) {
        Ok(c) => c,
        Err(_) => return Ok(Vec::new()),
    };

    let mut entries = Vec::new();
    for line in history_content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(history_line) = serde_json::from_str::<AntigravityHistoryLine>(line) else {
            continue;
        };
        let Some(conversation_id) = &history_line.conversation_id else {
            continue;
        };
        let transcript_path = data_dir
            .join("brain")
            .join(conversation_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        if !transcript_path.is_file() {
            continue;
        }
        let transcript_content = match fs::read_to_string(&transcript_path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let mut steps = Vec::new();
        for step_line in transcript_content.lines() {
            if step_line.trim().is_empty() {
                continue;
            }
            if let Ok(step) = serde_json::from_str::<AntigravityTranscriptStep>(step_line) {
                steps.push(step);
            }
        }

        let first_ts = history_line
            .timestamp
            .map(|t| crate::TimestampMs::from_millis(t as i64))
            .unwrap_or(crate::TimestampMs::UNIX_EPOCH);

        for step in steps {
            if step.source.as_deref() == Some("MODEL")
                && step.step_type.as_deref() == Some("PLANNER_RESPONSE")
            {
                let step_ts = step
                    .created_at
                    .as_deref()
                    .and_then(parse_ts_timestamp)
                    .unwrap_or(first_ts);
                let step_ts_text = format_rfc3339_millis(step_ts);
                let project_path: Arc<str> = Arc::from(
                    history_line
                        .workspace
                        .as_deref()
                        .unwrap_or("Unknown Project"),
                );
                let project = Arc::from(
                    std::path::Path::new(project_path.as_ref())
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("Unknown Project"),
                );

                let data = UsageEntry {
                    session_id: Some(conversation_id.clone()),
                    timestamp: step_ts_text.clone(),
                    version: None,
                    message: UsageMessage {
                        usage: TokenUsageRaw::default(),
                        model: Some(DEFAULT_ANTIGRAVITY_MODEL.to_string()),
                        id: Some(format!("antigravity:{}", conversation_id)),
                    },
                    cost_usd: None,
                    request_id: None,
                    is_api_error_message: None,
                };

                entries.push(LoadedEntry {
                    date: format_date_tz(step_ts, tz.as_ref()),
                    timestamp: step_ts,
                    project,
                    session_id: Arc::from(conversation_id.as_str()),
                    project_path,
                    cost: 0.0,
                    credits: None,
                    extra_total_tokens: 0,
                    model: Some(DEFAULT_ANTIGRAVITY_MODEL.to_string()),
                    usage_limit_reset_time: None,
                    message_count: None,
                    data,
                });
            }
        }
    }

    Ok(entries)
}

fn antigravity_data_dir() -> Option<PathBuf> {
    if let Ok(paths) = env::var(ANTIGRAVITY_DATA_DIR_ENV) {
        return Some(PathBuf::from(paths));
    }
    crate::home::home_dir().map(|home| home.join(".gemini").join("antigravity-cli"))
}
