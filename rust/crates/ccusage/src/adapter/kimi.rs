use std::{
    collections::HashSet,
    env, fs,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    adapter::opencode,
    apply_total_token_fallback, calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, WeekDay},
    collect_files_with_extension, filter_loaded_entries_by_date, format_date_tz, json_value_u64,
    non_empty_json_string, parse_tz, print_json_or_jq, print_usage_table, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    LoadedEntry, PricingMap, Result, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

const KIMI_DATA_DIR_ENV: &str = "KIMI_DATA_DIR";
const KIMI_SESSIONS_DIR_NAME: &str = "sessions";
const KIMI_WIRE_FILE_NAME: &str = "wire.jsonl";
const DEFAULT_MODEL: &str = "kimi-for-coding";
const DEFAULT_PROVIDER: &str = "moonshot";

#[derive(Debug, Clone)]
struct KimiUsageEntry {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    message_id: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    extra_total_tokens: u64,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, |row| {
        opencode::summary_period(row)
    });
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    print_usage_table(
        "Kimi Token Usage Report",
        opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    )?;
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| opencode::agent_summary_json(row, kind, false))
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
    shared: &crate::cli::SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Kimi, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(
    shared: &crate::cli::SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for file in discover_wire_files()? {
        for entry in read_wire_file(&file)? {
            let key = kimi_entry_key(&entry);
            if seen.insert(key) {
                entries.push(kimi_entry_to_loaded(
                    entry,
                    tz.as_ref(),
                    shared.mode,
                    pricing,
                ));
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(KIMI_DATA_DIR_ENV) {
        for raw in env_paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            let path = PathBuf::from(raw);
            if path.is_dir() && seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        return Ok(paths);
    }

    if let Some(home) = crate::home::home_dir() {
        let path = home.join(".kimi");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn discover_wire_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for kimi_path in paths()? {
        let sessions_path = kimi_path.join(KIMI_SESSIONS_DIR_NAME);
        let mut candidates = Vec::new();
        collect_files_with_extension(&sessions_path, "jsonl", &mut candidates);
        files.extend(
            candidates
                .into_iter()
                .filter(|file| is_kimi_wire_file(&sessions_path, file)),
        );
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn is_kimi_wire_file(sessions_path: &Path, file_path: &Path) -> bool {
    if file_path.file_name().and_then(|name| name.to_str()) != Some(KIMI_WIRE_FILE_NAME) {
        return false;
    }
    let Ok(relative) = file_path.strip_prefix(sessions_path) else {
        return false;
    };
    relative
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
        == 3
}

fn read_wire_file(path: &Path) -> Result<Vec<KimiUsageEntry>> {
    let model = read_model_from_config(path);
    let fallback_timestamp = file_modified_timestamp(path);
    let content = fs::read_to_string(path)?;
    Ok(content
        .lines()
        .filter(|line| line.contains("\"StatusUpdate\"") && line.contains("\"token_usage\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| wire_line_to_entry(&value, path, &model, fallback_timestamp))
        .collect::<Vec<_>>())
}

fn read_model_from_config(file_path: &Path) -> String {
    let Some(root) = kimi_root_from_wire_path(file_path) else {
        return DEFAULT_MODEL.to_string();
    };
    let Ok(content) = fs::read_to_string(root.join("config.json")) else {
        return DEFAULT_MODEL.to_string();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return DEFAULT_MODEL.to_string();
    };
    non_empty_json_string(value.get("model")).unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

fn kimi_root_from_wire_path(file_path: &Path) -> Option<PathBuf> {
    file_path
        .parent()?
        .parent()?
        .parent()?
        .parent()
        .map(Path::to_path_buf)
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

fn wire_line_to_entry(
    value: &Value,
    file_path: &Path,
    model: &str,
    fallback_timestamp: TimestampMs,
) -> Option<KimiUsageEntry> {
    if value.get("type").and_then(Value::as_str) == Some("metadata") {
        return None;
    }
    let message = value.get("message")?;
    if message.get("type").and_then(Value::as_str) != Some("StatusUpdate") {
        return None;
    }
    let payload = message.get("payload")?;
    let token_usage = payload.get("token_usage")?;
    let input_tokens = json_value_u64(token_usage.get("input_other"));
    let output_tokens = json_value_u64(token_usage.get("output"));
    let cache_creation_tokens = json_value_u64(token_usage.get("input_cache_creation"));
    let cache_read_tokens = json_value_u64(token_usage.get("input_cache_read"));
    let total_tokens = json_value_u64(token_usage.get("total"));
    let usage = TokenUsageRaw {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: cache_creation_tokens,
        cache_read_input_tokens: cache_read_tokens,
        speed: None,
    };
    let (usage, extra_total_tokens) = apply_total_token_fallback(usage, 0, total_tokens);
    if crate::total_usage_tokens(usage) + extra_total_tokens == 0 {
        return None;
    }
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_f64)
        .and_then(timestamp_from_seconds)
        .unwrap_or(fallback_timestamp);
    Some(KimiUsageEntry {
        timestamp,
        timestamp_text: crate::format_rfc3339_millis(timestamp),
        session_id: extract_session_id(file_path),
        model: model.to_string(),
        message_id: non_empty_json_string(payload.get("message_id")),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        extra_total_tokens,
    })
}

fn timestamp_from_seconds(seconds: f64) -> Option<TimestampMs> {
    if !seconds.is_finite() {
        return None;
    }
    let millis = (seconds * 1000.0).trunc();
    if millis < i64::MIN as f64 || millis > i64::MAX as f64 {
        return None;
    }
    Some(TimestampMs::from_millis(millis as i64))
}

fn extract_session_id(file_path: &Path) -> String {
    file_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn kimi_entry_key(entry: &KimiUsageEntry) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}",
        entry.session_id,
        entry.message_id.as_deref().unwrap_or_default(),
        entry.timestamp_text,
        entry.model,
        entry.input_tokens,
        entry.output_tokens,
        entry.cache_creation_tokens,
        entry.cache_read_tokens,
        entry.extra_total_tokens
    )
}

fn kimi_entry_to_loaded(
    entry: KimiUsageEntry,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &PricingMap,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_tokens,
        cache_read_input_tokens: entry.cache_read_tokens,
        speed: None,
    };
    let cost = calculate_kimi_cost(&entry, mode, pricing, usage);
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(entry.model.clone()),
            id: entry.message_id.clone(),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("kimi"),
        session_id: Arc::from(entry.session_id),
        project_path: Arc::from("Kimi"),
        cost,
        extra_total_tokens: entry.extra_total_tokens,
        credits: None,
        message_count: None,
        model: Some(entry.model),
        usage_limit_reset_time: None,
        data,
    }
}

fn calculate_kimi_cost(
    entry: &KimiUsageEntry,
    mode: CostMode,
    pricing: &PricingMap,
    usage: TokenUsageRaw,
) -> f64 {
    match mode {
        CostMode::Display => 0.0,
        CostMode::Auto | CostMode::Calculate => {
            for candidate in model_candidates(&entry.model) {
                if pricing.find(&candidate).is_some() {
                    return calculate_cost_for_usage(
                        Some(&candidate),
                        usage,
                        None,
                        CostMode::Calculate,
                        Some(pricing),
                    );
                }
            }
            0.0
        }
    }
}

fn model_candidates(model: &str) -> Vec<String> {
    let mut candidates = vec![
        model.to_string(),
        format!("{DEFAULT_PROVIDER}/{model}"),
        format!("kimi/{model}"),
    ];
    candidates.sort();
    candidates.dedup();
    candidates
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf, sync::Mutex};

    use super::*;

    static KIMI_DATA_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn temp_kimi_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-kimi-{name}-{nanos}"));
        path
    }

    #[test]
    fn discovers_wire_jsonl_files_under_sessions_group_session() {
        let _guard = KIMI_DATA_DIR_LOCK.lock().unwrap();
        let kimi_dir = temp_kimi_dir("discover");
        fs::create_dir_all(kimi_dir.join("sessions/group/session")).unwrap();
        fs::create_dir_all(kimi_dir.join("sessions/nested/path/session")).unwrap();
        fs::write(kimi_dir.join("sessions/group/session/wire.jsonl"), "{}\n").unwrap();
        fs::write(kimi_dir.join("sessions/group/session/other.jsonl"), "{}\n").unwrap();
        fs::write(
            kimi_dir.join("sessions/nested/path/session/wire.jsonl"),
            "{}\n",
        )
        .unwrap();
        env::set_var(KIMI_DATA_DIR_ENV, &kimi_dir);
        let files = discover_wire_files().unwrap();
        env::remove_var(KIMI_DATA_DIR_ENV);
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert_eq!(
            files,
            vec![kimi_dir.join("sessions/group/session/wire.jsonl")]
        );
    }

    #[test]
    fn loads_status_update_token_usage_from_wire_files() {
        let _guard = KIMI_DATA_DIR_LOCK.lock().unwrap();
        let kimi_dir = temp_kimi_dir("wire");
        fs::create_dir_all(kimi_dir.join("sessions/group/session-a")).unwrap();
        fs::write(kimi_dir.join("config.json"), r#"{"model":"kimi-k2"}"#).unwrap();
        fs::write(
            kimi_dir.join("sessions/group/session-a/wire.jsonl"),
            [
                r#"{"type":"metadata","protocol_version":"1.3"}"#,
                r#"{"timestamp":1770983426.420942,"message":{"type":"TurnBegin","payload":{"user_input":"hello"}}}"#,
                r#"{"timestamp":1770983427.123,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":100,"output":50,"input_cache_read":10,"input_cache_creation":20},"message_id":"msg-1"}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        env::set_var(KIMI_DATA_DIR_ENV, &kimi_dir);
        let shared = crate::cli::SharedArgs {
            timezone: Some("UTC".to_string()),
            ..crate::cli::SharedArgs::default()
        };
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();
        env::remove_var(KIMI_DATA_DIR_ENV);
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-02-13");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].model.as_deref(), Some("kimi-k2"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
    }

    #[test]
    fn falls_back_to_total_tokens_when_kimi_parts_are_missing() {
        let kimi_dir = temp_kimi_dir("total");
        fs::create_dir_all(kimi_dir.join("sessions/group/session-a")).unwrap();
        fs::write(kimi_dir.join("config.json"), r#"{"model":"kimi-k2"}"#).unwrap();
        let file = kimi_dir.join("sessions/group/session-a/wire.jsonl");
        let value = serde_json::json!({
            "timestamp": 1770983427.123,
            "message": {
                "type": "StatusUpdate",
                "payload": {
                    "token_usage": {
                        "total": 432
                    }
                }
            }
        });

        let entry = wire_line_to_entry(&value, &file, "kimi-k2", TimestampMs::UNIX_EPOCH).unwrap();
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert_eq!(entry.output_tokens, 432);
        assert_eq!(entry.extra_total_tokens, 0);
    }

    #[test]
    fn skips_malformed_and_zero_token_wire_lines() {
        let _guard = KIMI_DATA_DIR_LOCK.lock().unwrap();
        let kimi_dir = temp_kimi_dir("zero");
        fs::create_dir_all(kimi_dir.join("sessions/group/session-a")).unwrap();
        fs::write(
            kimi_dir.join("sessions/group/session-a/wire.jsonl"),
            [
                "not json",
                r#"{"timestamp":1770983427,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":0,"output":0,"input_cache_read":0,"input_cache_creation":0}}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        env::set_var(KIMI_DATA_DIR_ENV, &kimi_dir);
        let entries = load_entries(
            &crate::cli::SharedArgs::default(),
            &PricingMap::load_embedded(),
        )
        .unwrap();
        env::remove_var(KIMI_DATA_DIR_ENV);
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert!(entries.is_empty());
    }
}
