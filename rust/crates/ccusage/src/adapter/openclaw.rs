use std::{
    collections::HashSet,
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Map, Value};

use crate::{
    apply_total_token_fallback,
    cli::{AgentCommandArgs, AgentReportKind, WeekDay},
    filter_loaded_entries_by_date, format_date_tz, json_value_u64, non_empty_json_string, parse_tz,
    print_json_or_jq, print_usage_table, sort_summaries, summarize_by_key,
    summarize_summaries_by_bucket, totals_json, wants_json, BucketKind, LoadedEntry, Result,
    SessionAccumulator, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

const OPENCLAW_DIR_ENV: &str = "OPENCLAW_DIR";

#[derive(Debug, Clone)]
struct OpenClawEntry {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    provider: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
    cost: f64,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let mut entries = load_entries(&args.shared, args.open_claw_path.as_deref())?;
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
        "OpenClaw Token Usage Report",
        super::opencode::first_column(args.kind),
        &rows,
        &args.shared,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| super::opencode::agent_summary_json(row, kind, kind == AgentReportKind::Session))
        .collect::<Vec<_>>();
    json!({
        rows_key(kind): rows_json,
        "totals": totals_json(rows),
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

pub(crate) fn load_entries(
    shared: &crate::cli::SharedArgs,
    custom_path: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(
        crate::progress::UsageLoadAgent::OpenClaw,
        shared.json,
        || load_entries_inner(shared, custom_path),
    )
}

fn load_entries_inner(
    shared: &crate::cli::SharedArgs,
    custom_path: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for root in paths(custom_path) {
        for file in collect_session_files(&root)? {
            for entry in parse_session_file(&file, tz.as_ref())? {
                if seen.insert(entry_id(&entry)) {
                    entries.push(entry);
                }
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn paths(custom_path: Option<&str>) -> Vec<PathBuf> {
    if let Some(custom_path) = custom_path.filter(|path| !path.trim().is_empty()) {
        return existing_path_list(custom_path);
    }
    if let Ok(env_paths) = env::var(OPENCLAW_DIR_ENV) {
        if !env_paths.trim().is_empty() {
            return existing_path_list(&env_paths);
        }
    }
    let Some(home) = crate::home::home_dir() else {
        return Vec::new();
    };
    [
        home.join(".openclaw"),
        home.join(".clawdbot"),
        home.join(".moltbot"),
        home.join(".moldbot"),
    ]
    .into_iter()
    .filter(|path| path.is_dir())
    .collect()
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

fn collect_session_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_session_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_session_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_session_files_inner(&path, files)?;
            continue;
        }
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(is_openclaw_session_file)
        {
            files.push(path);
        }
    }
    Ok(())
}

fn is_openclaw_session_file(name: &str) -> bool {
    let Some(index) = name.find(".jsonl") else {
        return false;
    };
    let suffix = &name[index..];
    suffix == ".jsonl"
        || suffix.starts_with(".jsonl.deleted.")
        || suffix.starts_with(".jsonl.reset.")
}

fn parse_session_file(path: &Path, tz: Option<&JiffTimeZone>) -> Result<Vec<LoadedEntry>> {
    let session_id = extract_session_id(path);
    let fallback_timestamp = file_modified_timestamp(path);
    let input = fs::File::open(path)?;
    let reader = BufReader::new(input);
    let mut current_model = None::<String>;
    let mut current_provider = None::<String>;
    let mut entries = Vec::new();
    for line in reader.lines().map_while(std::result::Result::ok) {
        if !line.contains("\"model_change\"")
            && !line.contains("\"model-snapshot\"")
            && !line.contains("\"usage\"")
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        if is_model_change(record) {
            let source = record
                .get("data")
                .and_then(Value::as_object)
                .unwrap_or(record);
            if let Some(model) = non_empty_json_string(source.get("modelId"))
                .or_else(|| non_empty_json_string(source.get("model")))
            {
                current_model = Some(model);
            }
            if let Some(provider) = non_empty_json_string(source.get("provider")) {
                current_provider = Some(provider);
            }
            continue;
        }
        if let Some(entry) = parse_message_entry(
            record,
            &session_id,
            current_model.as_deref(),
            current_provider.as_deref(),
            fallback_timestamp,
        ) {
            entries.push(openclaw_entry_to_loaded(entry, tz));
        }
    }
    Ok(entries)
}

fn is_model_change(record: &Map<String, Value>) -> bool {
    if record.get("type").and_then(Value::as_str) == Some("model_change") {
        return true;
    }
    record.get("type").and_then(Value::as_str) == Some("custom")
        && record.get("customType").and_then(Value::as_str) == Some("model-snapshot")
}

fn parse_message_entry(
    record: &Map<String, Value>,
    session_id: &str,
    current_model: Option<&str>,
    current_provider: Option<&str>,
    fallback_timestamp: TimestampMs,
) -> Option<OpenClawEntry> {
    if record.get("type").and_then(Value::as_str) != Some("message") {
        return None;
    }
    let message = record.get("message")?.as_object()?;
    if message.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let usage = message.get("usage")?.as_object()?;
    let input_tokens = json_value_u64(usage.get("input"));
    let output_tokens = json_value_u64(usage.get("output"));
    let cache_read_tokens = json_value_u64(usage.get("cacheRead"));
    let cache_creation_tokens = json_value_u64(usage.get("cacheWrite"));
    let total_tokens = json_value_u64(usage.get("totalTokens"));
    let raw_usage = TokenUsageRaw {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: cache_creation_tokens,
        cache_read_input_tokens: cache_read_tokens,
        speed: None,
    };
    let (raw_usage, extra_total_tokens) = apply_total_token_fallback(raw_usage, 0, total_tokens);
    if crate::total_usage_tokens(raw_usage) + extra_total_tokens == 0 {
        return None;
    }
    let total_tokens = total_tokens.max(crate::total_usage_tokens(raw_usage) + extra_total_tokens);
    let timestamp =
        timestamp_from_value(message.get("timestamp").or_else(|| record.get("timestamp")))
            .unwrap_or(fallback_timestamp);
    let model = non_empty_json_string(message.get("modelId"))
        .or_else(|| non_empty_json_string(message.get("model")))
        .or_else(|| current_model.map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string());
    let provider = non_empty_json_string(message.get("provider"))
        .or_else(|| current_provider.map(str::to_string));
    Some(OpenClawEntry {
        timestamp,
        timestamp_text: crate::format_rfc3339_millis(timestamp),
        session_id: session_id.to_string(),
        model: format!("[openclaw] {model}"),
        provider,
        input_tokens: raw_usage.input_tokens,
        output_tokens: raw_usage.output_tokens,
        cache_creation_tokens: raw_usage.cache_creation_input_tokens,
        cache_read_tokens: raw_usage.cache_read_input_tokens,
        total_tokens,
        cost: usage
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    })
}

fn openclaw_entry_to_loaded(entry: OpenClawEntry, tz: Option<&JiffTimeZone>) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_tokens,
        cache_read_input_tokens: entry.cache_read_tokens,
        speed: None,
    };
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text.clone(),
        version: entry.provider.clone(),
        message: UsageMessage {
            usage,
            model: Some(entry.model.clone()),
            id: None,
        },
        cost_usd: Some(entry.cost),
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("openclaw"),
        session_id: Arc::from(entry.session_id),
        project_path: Arc::from("OpenClaw"),
        cost: entry.cost,
        extra_total_tokens: entry.total_tokens.saturating_sub(
            entry.input_tokens
                + entry.output_tokens
                + entry.cache_creation_tokens
                + entry.cache_read_tokens,
        ),
        credits: None,
        message_count: None,
        model: Some(entry.model),
        data,
        usage_limit_reset_time: None,
    }
}

fn timestamp_from_value(value: Option<&Value>) -> Option<TimestampMs> {
    let value = value?;
    if let Some(raw) = value.as_i64() {
        return Some(TimestampMs::from_millis(raw));
    }
    crate::parse_ts_timestamp(value.as_str()?)
}

fn extract_session_id(path: &Path) -> String {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    let Some(index) = filename.find(".jsonl") else {
        return filename.to_string();
    };
    let stem = &filename[..index];
    if stem.is_empty() {
        filename.to_string()
    } else {
        stem.to_string()
    }
}

fn file_modified_timestamp(path: &Path) -> TimestampMs {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .map(TimestampMs::from_millis)
        .unwrap_or(TimestampMs::UNIX_EPOCH)
}

fn entry_id(entry: &LoadedEntry) -> String {
    let usage = entry.data.message.usage;
    [
        "openclaw".to_string(),
        entry.session_id.to_string(),
        entry.data.timestamp.clone(),
        entry.model.clone().unwrap_or_default(),
        usage.input_tokens.to_string(),
        usage.output_tokens.to_string(),
        usage.cache_creation_input_tokens.to_string(),
        usage.cache_read_input_tokens.to_string(),
        entry.extra_total_tokens.to_string(),
        entry.cost.to_string(),
    ]
    .join(":")
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf, sync::Mutex};

    use super::*;

    static OPENCLAW_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn temp_openclaw_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-openclaw-{name}-{nanos}"));
        path
    }

    #[test]
    fn detects_archived_session_files_as_openclaw_sessions() {
        assert!(is_openclaw_session_file("a.jsonl.deleted.1700000000000"));
        assert!(is_openclaw_session_file(
            "a.jsonl.reset.2026-03-20T06-34-44.520Z"
        ));
        assert!(!is_openclaw_session_file("a.json"));
    }

    #[test]
    fn loads_assistant_usage_and_uses_model_change_events() {
        let _guard = OPENCLAW_DIR_LOCK.lock().unwrap();
        let dir = temp_openclaw_dir("usage");
        fs::create_dir_all(dir.join("agents/main/sessions")).unwrap();
        fs::write(
            dir.join("agents/main/sessions/abc.jsonl"),
            [
                r#"{"type":"model_change","provider":"openai-codex","modelId":"gpt-5.2"}"#,
                r#"{"type":"message","message":{"role":"assistant","usage":{"input":1660,"output":55,"cacheRead":108928,"cost":{"total":0.02}},"timestamp":1769753935279}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let shared = crate::cli::SharedArgs {
            timezone: Some("UTC".to_string()),
            ..crate::cli::SharedArgs::default()
        };
        let entries = load_entries(&shared, Some(dir.to_str().unwrap())).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-30");
        assert_eq!(entries[0].session_id.as_ref(), "abc");
        assert_eq!(entries[0].model.as_deref(), Some("[openclaw] gpt-5.2"));
        assert_eq!(entries[0].data.version.as_deref(), Some("openai-codex"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 1660);
        assert_eq!(entries[0].data.message.usage.output_tokens, 55);
        assert_eq!(
            entries[0].data.message.usage.cache_read_input_tokens,
            108_928
        );
        assert_eq!(entries[0].extra_total_tokens, 0);
        assert!((entries[0].cost - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn deduplicates_repeated_openclaw_records() {
        let _guard = OPENCLAW_DIR_LOCK.lock().unwrap();
        let dir = temp_openclaw_dir("dedupe");
        fs::create_dir_all(dir.join("agents/main/sessions")).unwrap();
        let line = r#"{"type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":1,"output":1,"totalTokens":2},"timestamp":1769753935279}}"#;
        fs::write(
            dir.join("agents/main/sessions/session.jsonl"),
            format!("{line}\n{line}\n"),
        )
        .unwrap();
        let entries = load_entries(
            &crate::cli::SharedArgs::default(),
            Some(dir.to_str().unwrap()),
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
    }

    #[test]
    fn falls_back_to_total_tokens_when_openclaw_parts_are_missing() {
        let record = serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "model": "gpt-5.2",
                "usage": {
                    "totalTokens": 222
                }
            }
        });
        let entry = parse_message_entry(
            record.as_object().unwrap(),
            "session-a",
            None,
            None,
            TimestampMs::UNIX_EPOCH,
        )
        .unwrap();

        assert_eq!(entry.output_tokens, 222);
        assert_eq!(entry.total_tokens, 222);
    }
}
