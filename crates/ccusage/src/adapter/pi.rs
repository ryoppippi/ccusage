use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    cli::AgentCommandArgs, cli::AgentReportKind, cli::SharedArgs, cli::WeekDay,
    collect_files_with_extension, filter_loaded_entries_by_date, format_date_tz, json_value_u64,
    non_empty_json_string, parse_tz, print_json_or_jq, print_usage_table, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    LoadedEntry, Result, TokenUsageRaw, UsageEntry, UsageMessage,
};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let mut entries = load_entries(&args.shared, args.pi_path.as_deref())?;
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
        "pi-agent Token Usage Report",
        super::opencode::first_column(args.kind),
        &rows,
        &args.shared,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = if kind == AgentReportKind::Session {
        rows.iter()
            .map(crate::session_summary_json)
            .collect::<Vec<_>>()
    } else {
        rows.iter().map(crate::summary_json).collect::<Vec<_>>()
    };
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
            let daily = summarize_by_key(
                entries,
                |entry| entry.date.clone(),
                |date| (date.to_string(), None),
            )?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Monthly,
                WeekDay::Sunday,
            ))
        }
        AgentReportKind::Session => summarize_by_key(
            entries,
            |entry| entry.session_id.to_string(),
            |session_id| (session_id.to_string(), None),
        )
        .map(|mut rows| {
            for row in &mut rows {
                row.session_id = row.date.take();
            }
            rows
        }),
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

pub(crate) fn load_entries(
    shared: &SharedArgs,
    custom_path: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for path in paths(custom_path)? {
        let mut files = Vec::new();
        collect_files_with_extension(&path, "jsonl", &mut files);
        for file in files {
            for entry in read_session_file(&file, tz.as_ref())? {
                let id = entry_id(&entry);
                if seen.insert(id) {
                    entries.push(entry);
                }
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn paths(custom_path: Option<&str>) -> Result<Vec<PathBuf>> {
    if let Some(custom_path) = custom_path.filter(|path| !path.trim().is_empty()) {
        return Ok(existing_path_list(custom_path));
    }
    if let Ok(env_paths) = env::var("PI_AGENT_DIR") {
        if !env_paths.trim().is_empty() {
            return Ok(existing_path_list(&env_paths));
        }
    }

    let home = crate::home::home_dir()
        .ok_or_else(|| crate::cli_error("home directory is not set"))?;
    let path = home.join(".pi/agent/sessions");
    Ok(path.is_dir().then_some(path).into_iter().collect())
}

fn existing_path_list(raw: &str) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    raw.split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir() && seen.insert(path.clone()))
        .collect()
}

pub(crate) fn read_session_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
) -> Result<Vec<LoadedEntry>> {
    let content = fs::read_to_string(path)?;
    let project = extract_project(path);
    let session_id = extract_session_id(path);
    let mut entries = Vec::new();

    for line in content.lines() {
        if !line.contains("\"usage\"") || !line.contains("\"message\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !is_pi_message_usage(&value) {
            continue;
        }
        let Some(timestamp_text) = non_empty_json_string(value.get("timestamp")) else {
            continue;
        };
        let Some(timestamp) = crate::parse_ts_timestamp(&timestamp_text) else {
            continue;
        };
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(usage_value) = message.get("usage") else {
            continue;
        };
        let input = json_value_u64(usage_value.get("input"));
        let output = json_value_u64(usage_value.get("output"));
        let cache_read = json_value_u64(usage_value.get("cacheRead"));
        let cache_create = json_value_u64(usage_value.get("cacheWrite"));
        if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
            continue;
        }
        let model =
            non_empty_json_string(message.get("model")).map(|model| format!("[pi] {model}"));
        let cost = usage_value
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let data = UsageEntry {
            session_id: Some(session_id.clone()),
            timestamp: timestamp_text,
            version: None,
            message: UsageMessage {
                usage: TokenUsageRaw {
                    input_tokens: input,
                    output_tokens: output,
                    cache_creation_input_tokens: cache_create,
                    cache_read_input_tokens: cache_read,
                    speed: None,
                },
                model: model.clone(),
                id: None,
            },
            cost_usd: Some(cost),
            request_id: None,
            is_api_error_message: None,
        };
        entries.push(LoadedEntry {
            date: format_date_tz(timestamp, tz),
            timestamp,
            project: Arc::from(project.as_str()),
            session_id: Arc::from(session_id.as_str()),
            project_path: Arc::from(project.as_str()),
            cost,
            credits: None,
            model,
            data,
            usage_limit_reset_time: None,
        });
    }
    Ok(entries)
}

fn is_pi_message_usage(value: &Value) -> bool {
    let message_type = value.get("type").and_then(Value::as_str);
    if message_type.is_some_and(|message_type| message_type != "message") {
        return false;
    }
    let Some(message) = value.get("message") else {
        return false;
    };
    message.get("role").and_then(Value::as_str) == Some("assistant")
        && message.get("usage").is_some()
}

fn extract_session_id(path: &Path) -> String {
    let filename = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    filename
        .split_once('_')
        .map_or(filename, |(_, session)| session)
        .to_string()
}

fn extract_project(path: &Path) -> String {
    let mut previous_was_sessions = false;
    for component in path.components() {
        let segment = component.as_os_str().to_string_lossy();
        if previous_was_sessions {
            return segment.into_owned();
        }
        previous_was_sessions = segment == "sessions";
    }
    "unknown".to_string()
}

fn entry_id(entry: &LoadedEntry) -> String {
    [
        "pi",
        entry.project.as_ref(),
        entry.session_id.as_ref(),
        entry.data.timestamp.as_str(),
        entry.model.as_deref().unwrap_or_default(),
        &entry.data.message.usage.input_tokens.to_string(),
        &entry.data.message.usage.output_tokens.to_string(),
        &entry
            .data
            .message
            .usage
            .cache_creation_input_tokens
            .to_string(),
        &entry.data.message.usage.cache_read_input_tokens.to_string(),
        &entry.cost.to_string(),
    ]
    .join(":")
}
