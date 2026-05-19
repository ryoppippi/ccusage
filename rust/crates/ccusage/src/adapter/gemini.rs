use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Map, Value};

use crate::{
    adapter::opencode,
    calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, WeekDay},
    collect_files_with_extension, filter_loaded_entries_by_date, format_date_tz,
    non_empty_json_string, parse_tz, print_json_or_jq, print_usage_table, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    LoadedEntry, PricingMap, Result, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

const GEMINI_DATA_DIR_ENV: &str = "GEMINI_DATA_DIR";
const DEFAULT_MODEL: &str = "unknown";
const PROVIDER_PREFIXES: [&str; 4] = ["google", "gemini", "vertex_ai", "openrouter/google"];

#[derive(Debug, Clone, Copy, Default)]
struct GeminiTokens {
    input: u64,
    output: u64,
    cached: u64,
    thoughts: u64,
    tool: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone)]
struct GeminiUsageEvent {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    message_id: Option<String>,
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
        "Gemini CLI Token Usage Report",
        opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    );
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
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Gemini, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(
    shared: &crate::cli::SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut events = Vec::new();
    for file in discover_log_files()? {
        if file.extension().and_then(|extension| extension.to_str()) == Some("jsonl") {
            events.extend(parse_jsonl_file(&file)?);
        } else {
            events.extend(parse_json_file(&file)?);
        }
    }
    events.sort_by_key(|event| event.timestamp);
    Ok(events
        .into_iter()
        .map(|event| event_to_loaded(event, tz.as_ref(), shared.mode, pricing))
        .collect())
}

fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(GEMINI_DATA_DIR_ENV) {
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
        let path = home.join(".gemini").join("tmp");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn discover_log_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for path in paths()? {
        collect_files_with_extension(&path, "json", &mut files);
        collect_files_with_extension(&path, "jsonl", &mut files);
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn parse_json_file(path: &Path) -> Result<Vec<GeminiUsageEvent>> {
    let fallback_timestamp = file_modified_timestamp(path);
    let content = fs::read_to_string(path)?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(Vec::new());
    };
    let Some(record) = value.as_object() else {
        return Ok(Vec::new());
    };
    let session_id = string_at(record, "sessionId")
        .or_else(|| string_at(record, "session_id"))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("unknown")
                .to_string()
        });
    let session_timestamp = timestamp_at(record, "startTime")
        .or_else(|| timestamp_at(record, "lastUpdated"))
        .unwrap_or(fallback_timestamp);
    if let Some(messages) = record.get("messages").and_then(Value::as_array) {
        return Ok(messages
            .iter()
            .filter_map(Value::as_object)
            .filter(|message| message.get("type").and_then(Value::as_str) == Some("gemini"))
            .filter_map(|message| parse_direct_event(message, None, &session_id, session_timestamp))
            .collect());
    }
    if record.get("type").and_then(Value::as_str) == Some("gemini") {
        return Ok(
            parse_direct_event(record, None, &session_id, fallback_timestamp)
                .into_iter()
                .collect(),
        );
    }
    let stats = record
        .get("stats")
        .or_else(|| record.get("result").and_then(|result| result.get("stats")));
    Ok(parse_stats_events(
        stats,
        string_at(record, "model").as_deref(),
        &session_id,
        timestamp_at(record, "timestamp").unwrap_or(fallback_timestamp),
    ))
}

fn parse_jsonl_file(path: &Path) -> Result<Vec<GeminiUsageEvent>> {
    let fallback_timestamp = file_modified_timestamp(path);
    let mut session_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut current_model = None::<String>;
    let mut events = Vec::new();
    let mut direct_event_indexes = HashMap::<String, usize>::new();
    let content = fs::read_to_string(path)?;
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        if let Some(value) =
            string_at(record, "sessionId").or_else(|| string_at(record, "session_id"))
        {
            session_id = value;
        }
        if let Some(model) = string_at(record, "model") {
            current_model = Some(model);
        }
        if record.get("type").and_then(Value::as_str) == Some("gemini") {
            let Some(event) = parse_direct_event(
                record,
                current_model.as_deref(),
                &session_id,
                fallback_timestamp,
            ) else {
                continue;
            };
            if let Some(id) = string_at(record, "id") {
                if let Some(index) = direct_event_indexes.get(&id).copied() {
                    events[index] = event;
                } else {
                    direct_event_indexes.insert(id, events.len());
                    events.push(event);
                }
            } else {
                events.push(event);
            }
            continue;
        }
        let stats = record
            .get("stats")
            .or_else(|| record.get("result").and_then(|result| result.get("stats")));
        if stats.is_some() {
            events.extend(parse_stats_events(
                stats,
                current_model.as_deref(),
                &session_id,
                timestamp_at(record, "timestamp").unwrap_or(fallback_timestamp),
            ));
        }
    }
    Ok(events)
}

fn parse_direct_event(
    record: &Map<String, Value>,
    model_hint: Option<&str>,
    session_id: &str,
    fallback_timestamp: TimestampMs,
) -> Option<GeminiUsageEvent> {
    let tokens = parse_tokens(record.get("tokens"))?;
    build_event(
        string_at(record, "model").as_deref().or(model_hint),
        session_id,
        timestamp_at(record, "timestamp")
            .or_else(|| timestamp_at(record, "created_at"))
            .unwrap_or(fallback_timestamp),
        tokens,
        normalize_session_input,
        string_at(record, "id"),
    )
}

fn parse_stats_events(
    stats: Option<&Value>,
    model_hint: Option<&str>,
    session_id: &str,
    timestamp: TimestampMs,
) -> Vec<GeminiUsageEvent> {
    let Some(stats) = stats.and_then(Value::as_object) else {
        return Vec::new();
    };
    if let Some(models) = stats.get("models").and_then(Value::as_object) {
        let events = models
            .iter()
            .filter_map(|(model, data)| {
                let data = data.as_object()?;
                let tokens = parse_tokens(data.get("tokens"))?;
                build_event(
                    Some(model),
                    session_id,
                    timestamp,
                    tokens,
                    subtract_cached_overlap_tokens,
                    None,
                )
            })
            .collect::<Vec<_>>();
        if !events.is_empty() {
            return events;
        }
    }
    let Some(tokens) = parse_tokens(Some(&Value::Object(stats.clone()))) else {
        return Vec::new();
    };
    build_event(
        model_hint.or(Some(DEFAULT_MODEL)),
        session_id,
        timestamp,
        tokens,
        subtract_cached_overlap_tokens,
        None,
    )
    .into_iter()
    .collect()
}

fn build_event(
    model: Option<&str>,
    session_id: &str,
    timestamp: TimestampMs,
    tokens: GeminiTokens,
    normalize_input: fn(GeminiTokens) -> (u64, u64),
    message_id: Option<String>,
) -> Option<GeminiUsageEvent> {
    let model = model.filter(|model| !model.trim().is_empty())?;
    let (input_without_cache, cache_read_tokens) = normalize_input(tokens);
    let input_tokens = input_without_cache + tokens.tool;
    let total_tokens = tokens
        .total
        .unwrap_or(input_tokens + tokens.output + cache_read_tokens + tokens.thoughts);
    if input_tokens == 0 && tokens.output == 0 && cache_read_tokens == 0 && tokens.thoughts == 0 {
        return None;
    }
    Some(GeminiUsageEvent {
        timestamp,
        timestamp_text: crate::format_rfc3339_millis(timestamp),
        session_id: session_id.to_string(),
        model: model.to_string(),
        input_tokens,
        output_tokens: tokens.output,
        cache_read_tokens,
        reasoning_tokens: tokens.thoughts,
        total_tokens,
        message_id,
    })
}

fn parse_tokens(value: Option<&Value>) -> Option<GeminiTokens> {
    let record = value?.as_object()?;
    Some(GeminiTokens {
        input: token_number(
            record,
            &["input", "prompt", "input_tokens", "prompt_tokens"],
        ),
        output: token_number(
            record,
            &["output", "candidates", "output_tokens", "candidates_tokens"],
        ),
        cached: token_number(record, &["cached", "cached_tokens"]),
        thoughts: token_number(
            record,
            &[
                "thoughts",
                "reasoning",
                "thoughts_tokens",
                "reasoning_tokens",
            ],
        ),
        tool: token_number(record, &["tool", "tool_tokens"]),
        total: value_u64(record.get("total")),
    })
}

fn token_number(record: &Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value_u64(record.get(*key)))
        .unwrap_or(0)
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.max(0.0).trunc() as u64)
}

fn subtract_cached_overlap_tokens(tokens: GeminiTokens) -> (u64, u64) {
    let cache_read = tokens.cached;
    let cached_portion = tokens.input.min(cache_read);
    (tokens.input.saturating_sub(cached_portion), cache_read)
}

fn normalize_session_input(tokens: GeminiTokens) -> (u64, u64) {
    let inclusive_total = tokens.input + tokens.output + tokens.thoughts + tokens.tool;
    let exclusive_total = inclusive_total + tokens.cached;
    if tokens.cached > 0
        && tokens.total == Some(inclusive_total)
        && tokens.total != Some(exclusive_total)
    {
        return subtract_cached_overlap_tokens(tokens);
    }
    (tokens.input, tokens.cached)
}

fn timestamp_at(record: &Map<String, Value>, key: &str) -> Option<TimestampMs> {
    timestamp_from_value(record.get(key)?)
}

fn timestamp_from_value(value: &Value) -> Option<TimestampMs> {
    let raw = value.as_str()?;
    crate::parse_ts_timestamp(raw)
}

fn string_at(record: &Map<String, Value>, key: &str) -> Option<String> {
    non_empty_json_string(record.get(key))
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

fn event_to_loaded(
    event: GeminiUsageEvent,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &PricingMap,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: event.cache_read_tokens,
        speed: None,
    };
    let cost_usage = TokenUsageRaw {
        output_tokens: event.output_tokens + event.reasoning_tokens,
        ..usage
    };
    let extra_total_tokens = event
        .total_tokens
        .saturating_sub(event.input_tokens + event.output_tokens + event.cache_read_tokens);
    let cost = calculate_gemini_cost(&event.model, cost_usage, mode, pricing);
    let data = UsageEntry {
        session_id: Some(event.session_id.clone()),
        timestamp: event.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(event.model.clone()),
            id: event.message_id,
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(event.timestamp, tz),
        timestamp: event.timestamp,
        project: Arc::from("gemini"),
        session_id: Arc::from(event.session_id),
        project_path: Arc::from("Gemini"),
        cost,
        extra_total_tokens,
        credits: None,
        model: Some(event.model),
        usage_limit_reset_time: None,
        data,
    }
}

fn calculate_gemini_cost(
    model: &str,
    usage: TokenUsageRaw,
    mode: CostMode,
    pricing: &PricingMap,
) -> f64 {
    match mode {
        CostMode::Display => 0.0,
        CostMode::Auto | CostMode::Calculate => {
            for candidate in model_candidates(model) {
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
    let mut candidates = vec![model.to_string()];
    candidates.extend(
        PROVIDER_PREFIXES
            .iter()
            .map(|prefix| format!("{prefix}/{model}")),
    );
    candidates.sort();
    candidates.dedup();
    candidates
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf, sync::Mutex};

    use super::*;

    static GEMINI_DATA_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn temp_gemini_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-gemini-{name}-{nanos}"));
        path
    }

    #[test]
    fn discovers_json_and_jsonl_logs() {
        let _guard = GEMINI_DATA_DIR_LOCK.lock().unwrap();
        let gemini_dir = temp_gemini_dir("discover");
        fs::create_dir_all(gemini_dir.join("chats")).unwrap();
        fs::write(gemini_dir.join("chats/a.json"), "{}").unwrap();
        fs::write(gemini_dir.join("chats/b.jsonl"), "{}\n").unwrap();
        fs::write(gemini_dir.join("chats/ignore.txt"), "no").unwrap();
        env::set_var(GEMINI_DATA_DIR_ENV, &gemini_dir);
        let files = discover_log_files().unwrap();
        env::remove_var(GEMINI_DATA_DIR_ENV);
        fs::remove_dir_all(&gemini_dir).unwrap();

        assert_eq!(
            files,
            vec![
                gemini_dir.join("chats/a.json"),
                gemini_dir.join("chats/b.jsonl")
            ]
        );
    }

    #[test]
    fn loads_jsonl_token_events_and_separates_cached_input() {
        let _guard = GEMINI_DATA_DIR_LOCK.lock().unwrap();
        let gemini_dir = temp_gemini_dir("jsonl");
        fs::create_dir_all(gemini_dir.join("project/chats")).unwrap();
        fs::write(
            gemini_dir.join("project/chats/session-a.jsonl"),
            [
                r#"{"sessionId":"session-a","projectHash":"project-a","startTime":"2026-05-17T11:07:00.000Z"}"#,
                r#"{"id":"msg-a","timestamp":"2026-05-17T11:07:32.000Z","type":"gemini","model":"gemini-3-flash-preview","tokens":{"input":15327,"output":23,"cached":11526,"thoughts":919,"tool":7,"total":16276}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        env::set_var(GEMINI_DATA_DIR_ENV, &gemini_dir);
        let shared = crate::cli::SharedArgs {
            timezone: Some("UTC".to_string()),
            ..crate::cli::SharedArgs::default()
        };
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();
        env::remove_var(GEMINI_DATA_DIR_ENV);
        fs::remove_dir_all(&gemini_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-05-17");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].model.as_deref(), Some("gemini-3-flash-preview"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 3_808);
        assert_eq!(entries[0].data.message.usage.output_tokens, 23);
        assert_eq!(
            entries[0].data.message.usage.cache_read_input_tokens,
            11_526
        );
        assert_eq!(entries[0].extra_total_tokens, 919);
    }
}
