use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    apply_total_token_fallback, calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, SharedArgs, WeekDay},
    collect_files_with_extension, filter_loaded_entries_by_date, format_date_tz,
    format_rfc3339_millis, json_value_u64, parse_ts_timestamp, parse_tz, print_json_or_jq,
    print_usage_table, sort_summaries, summarize_by_key, summarize_summaries_by_bucket,
    totals_json, wants_json, BucketKind, LoadedEntry, PricingMap, Result, TokenUsageRaw,
    UsageEntry, UsageMessage, UsageSummary,
};

const DROID_SESSIONS_DIR_ENV: &str = "DROID_SESSIONS_DIR";

#[derive(Clone)]
struct DroidEntry {
    timestamp: crate::TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    provider: String,
    usage: TokenUsageRaw,
    reasoning_tokens: u64,
}

#[derive(Default)]
struct DroidTokenUsage {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    thinking_tokens: u64,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
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
        "Droid Token Usage Report",
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
    json!({
        rows_key(kind): rows_json,
        "totals": totals_json(rows),
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

pub(crate) fn load_entries(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Droid, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut files = discover_settings_files()?;
    files.sort();
    let mut parsed = Vec::new();
    for file in files {
        if let Some(entry) = load_settings_file(&file)? {
            parsed.push(entry);
        }
    }
    parsed.sort_by_key(|entry| entry.timestamp);
    let mut seen_sessions = HashSet::new();
    let mut entries = Vec::new();
    for entry in parsed.into_iter().rev() {
        if !seen_sessions.insert(entry.session_id.clone()) {
            continue;
        }
        entries.push(to_loaded_entry(entry, tz.as_ref(), pricing));
    }
    Ok(entries)
}

fn discover_settings_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for root in droid_session_paths()? {
        collect_files_with_extension(&root, "json", &mut files);
    }
    Ok(files
        .into_iter()
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".settings.json"))
        })
        .collect())
}

fn droid_session_paths() -> Result<Vec<PathBuf>> {
    let raw_paths = if let Ok(paths) = env::var(DROID_SESSIONS_DIR_ENV) {
        paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        let home =
            crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
        vec![home.join(".factory").join("sessions")]
    };
    let mut seen = HashSet::new();
    Ok(raw_paths
        .into_iter()
        .filter(|path| path.is_dir())
        .filter(|path| seen.insert(path.clone()))
        .collect())
}

fn load_settings_file(path: &Path) -> Result<Option<DroidEntry>> {
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(None);
    };
    let Some(settings) = value.as_object() else {
        return Ok(None);
    };
    let Some(usage) = parse_token_usage(settings.get("tokenUsage")) else {
        return Ok(None);
    };
    let provider = normalize_droid_provider(string_field(settings, "providerLock").as_deref());
    let model = if let Some(model) = string_field(settings, "model") {
        normalize_droid_model_name(&model)
    } else {
        extract_model_from_sidecar_jsonl(path)?
            .unwrap_or_else(|| default_model_from_provider(&provider).to_string())
    };
    let model = if model.is_empty() {
        default_model_from_provider(&provider).to_string()
    } else {
        model
    };
    let provider = if provider == "unknown" {
        infer_droid_provider_from_model(&model).to_string()
    } else {
        provider
    };
    let Some((timestamp, timestamp_text)) = settings_timestamp(settings, path) else {
        return Ok(None);
    };
    let session_id = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".settings.json"))
        .unwrap_or("unknown")
        .to_string();
    Ok(Some(DroidEntry {
        timestamp,
        timestamp_text,
        session_id,
        model,
        provider,
        usage: TokenUsageRaw {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_input_tokens: usage.cache_creation_tokens,
            cache_read_input_tokens: usage.cache_read_tokens,
            speed: None,
        },
        reasoning_tokens: usage.thinking_tokens,
    }))
}

fn parse_token_usage(value: Option<&Value>) -> Option<DroidTokenUsage> {
    let usage = value?.as_object()?;
    let raw_usage = TokenUsageRaw {
        input_tokens: json_value_u64(usage.get("inputTokens")),
        output_tokens: json_value_u64(usage.get("outputTokens")),
        cache_creation_input_tokens: json_value_u64(usage.get("cacheCreationTokens")),
        cache_read_input_tokens: json_value_u64(usage.get("cacheReadTokens")),
        speed: None,
    };
    let thinking_tokens = json_value_u64(usage.get("thinkingTokens"));
    let total_tokens = json_value_u64(usage.get("totalTokens"));
    let (raw_usage, thinking_tokens) =
        apply_total_token_fallback(raw_usage, thinking_tokens, total_tokens);
    let tokens = DroidTokenUsage {
        input_tokens: raw_usage.input_tokens,
        output_tokens: raw_usage.output_tokens,
        cache_creation_tokens: raw_usage.cache_creation_input_tokens,
        cache_read_tokens: raw_usage.cache_read_input_tokens,
        thinking_tokens,
    };
    (tokens.input_tokens
        + tokens.output_tokens
        + tokens.cache_creation_tokens
        + tokens.cache_read_tokens
        + tokens.thinking_tokens
        > 0)
    .then_some(tokens)
}

fn settings_timestamp(
    settings: &serde_json::Map<String, Value>,
    path: &Path,
) -> Option<(crate::TimestampMs, String)> {
    if let Some(timestamp_text) = string_field(settings, "providerLockTimestamp") {
        if let Some(timestamp) = parse_ts_timestamp(&timestamp_text) {
            return Some((timestamp, format_rfc3339_millis(timestamp)));
        }
    }
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis()
        .min(i64::MAX as u128) as i64;
    let timestamp = crate::TimestampMs::from_millis(millis);
    Some((timestamp, format_rfc3339_millis(timestamp)))
}

fn to_loaded_entry(
    entry: DroidEntry,
    tz: Option<&JiffTimeZone>,
    pricing: &PricingMap,
) -> LoadedEntry {
    let cost = calculate_droid_cost(&entry, pricing);
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text.clone(),
        version: None,
        message: UsageMessage {
            usage: entry.usage,
            model: Some(entry.model.clone()),
            id: Some(format!("droid:{}", entry.session_id)),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("droid"),
        session_id: Arc::from(entry.session_id.as_str()),
        project_path: Arc::from("Droid"),
        cost,
        credits: None,
        extra_total_tokens: entry.reasoning_tokens,
        model: Some(entry.model),
        usage_limit_reset_time: None,
        message_count: None,
        data,
    }
}

fn calculate_droid_cost(entry: &DroidEntry, pricing: &PricingMap) -> f64 {
    let usage = TokenUsageRaw {
        output_tokens: entry.usage.output_tokens + entry.reasoning_tokens,
        ..entry.usage
    };
    for candidate in droid_model_candidates(entry) {
        let cost = calculate_cost_for_usage(
            Some(&candidate),
            usage,
            None,
            CostMode::Calculate,
            Some(pricing),
        );
        if cost > 0.0 {
            return cost;
        }
    }
    0.0
}

fn droid_model_candidates(entry: &DroidEntry) -> Vec<String> {
    let mut candidates = vec![entry.model.clone()];
    for prefix in provider_prefixes(&entry.provider) {
        candidates.push(format!("{prefix}{}", entry.model));
    }
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

fn provider_prefixes(provider: &str) -> Vec<String> {
    match provider {
        "anthropic" => vec![
            "anthropic/".to_string(),
            "openrouter/anthropic/".to_string(),
        ],
        "openai" => vec!["openai/".to_string(), "openrouter/openai/".to_string()],
        "google" => vec![
            "google/".to_string(),
            "vertex_ai/".to_string(),
            "openrouter/google/".to_string(),
        ],
        "xai" => vec!["xai/".to_string(), "openrouter/x-ai/".to_string()],
        "unknown" => Vec::new(),
        provider => vec![format!("{provider}/"), format!("openrouter/{provider}/")],
    }
}

fn string_field(record: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    let value = record.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) fn normalize_droid_model_name(model: &str) -> String {
    let raw = model.strip_prefix("custom:").unwrap_or(model);
    let mut without_brackets = String::new();
    let mut bracket_depth = 0_u32;
    for ch in raw.chars() {
        match ch {
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            _ if bracket_depth == 0 => without_brackets.push(ch),
            _ => {}
        }
    }
    let lower = without_brackets
        .trim()
        .trim_end_matches('-')
        .to_ascii_lowercase();
    let mut normalized = String::new();
    let mut previous_dash = false;
    for ch in lower.chars() {
        let next = if ch == '.' || ch.is_whitespace() || ch == '-' {
            '-'
        } else {
            ch
        };
        if next == '-' {
            if !previous_dash {
                normalized.push('-');
                previous_dash = true;
            }
        } else {
            normalized.push(next);
            previous_dash = false;
        }
    }
    normalized.trim_matches('-').to_string()
}

fn normalize_droid_provider(value: Option<&str>) -> String {
    let Some(value) = value else {
        return "unknown".to_string();
    };
    let normalized = value.trim().to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "" => "unknown".to_string(),
        "claude" | "anthropic" => "anthropic".to_string(),
        "openai" => "openai".to_string(),
        "google" | "google_ai" | "gemini" | "vertex" | "vertex_ai" => "google".to_string(),
        "xai" | "x_ai" | "grok" => "xai".to_string(),
        value => value.to_string(),
    }
}

fn infer_droid_provider_from_model(model: &str) -> &'static str {
    if model.contains("claude")
        || model.contains("opus")
        || model.contains("sonnet")
        || model.contains("haiku")
    {
        "anthropic"
    } else if model.starts_with("gpt-")
        || model.contains("-gpt-")
        || model.contains("chatgpt")
        || model.starts_with('o') && model.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
    {
        "openai"
    } else if model.contains("gemini") {
        "google"
    } else if model.contains("grok") {
        "xai"
    } else {
        "unknown"
    }
}

fn default_model_from_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "claude-unknown",
        "openai" => "gpt-unknown",
        "google" => "gemini-unknown",
        "xai" => "grok-unknown",
        "unknown" => "unknown",
        _ => "unknown",
    }
}

fn extract_model_from_sidecar_jsonl(settings_path: &Path) -> Result<Option<String>> {
    let Some(file_name) = settings_path.file_name().and_then(|name| name.to_str()) else {
        return Ok(None);
    };
    let Some(prefix) = file_name.strip_suffix(".settings.json") else {
        return Ok(None);
    };
    let sidecar = settings_path.with_file_name(format!("{prefix}.jsonl"));
    let Ok(content) = fs::read_to_string(sidecar) else {
        return Ok(None);
    };
    for line in content.lines().take(500) {
        if let Some(model) = extract_droid_model_from_line(line) {
            return Ok(Some(model));
        }
    }
    Ok(None)
}

fn extract_droid_model_from_line(line: &str) -> Option<String> {
    let tail = line.split_once("Model:")?.1;
    let raw = tail
        .split(['"', '\\', '['])
        .next()
        .unwrap_or_default()
        .trim();
    if raw.is_empty() {
        return None;
    }
    let normalized = normalize_droid_model_name(raw);
    (!normalized.is_empty()).then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("ccusage-droid-{name}-{nanos}"))
    }

    #[test]
    fn normalizes_droid_model_names() {
        assert_eq!(
            normalize_droid_model_name("custom:Claude-Opus-4.5-Thinking-[Anthropic]-0"),
            "claude-opus-4-5-thinking-0"
        );
        assert_eq!(
            normalize_droid_model_name("Claude-Sonnet-4-[Anthropic]"),
            "claude-sonnet-4"
        );
        assert_eq!(
            normalize_droid_model_name("gemini-2.5-pro"),
            "gemini-2-5-pro"
        );
    }

    #[test]
    fn falls_back_to_total_tokens_when_droid_parts_are_missing() {
        let usage = parse_token_usage(Some(&serde_json::json!({
            "totalTokens": 456
        })))
        .unwrap();

        assert_eq!(usage.output_tokens, 456);
        assert_eq!(usage.thinking_tokens, 0);
    }

    #[test]
    fn loads_usage_from_droid_settings_files() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("settings");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("session-a.settings.json"),
            r#"{
                "model": "Claude-Sonnet-4-[Anthropic]",
                "providerLock": "anthropic",
                "providerLockTimestamp": "2026-05-01T01:02:03.000Z",
                "tokenUsage": {
                    "inputTokens": 100,
                    "outputTokens": 50,
                    "cacheCreationTokens": 20,
                    "cacheReadTokens": 10,
                    "thinkingTokens": 5
                }
            }"#,
        )
        .unwrap();
        fs::write(
            dir.join("zero.settings.json"),
            r#"{"model":"gpt-5","tokenUsage":{"inputTokens":0}}"#,
        )
        .unwrap();
        env::set_var(DROID_SESSIONS_DIR_ENV, &dir);

        let pricing = PricingMap::load_embedded();
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, &pricing).unwrap();
        env::remove_var(DROID_SESSIONS_DIR_ENV);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-05-01");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].model.as_deref(), Some("claude-sonnet-4"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
        assert_eq!(entries[0].extra_total_tokens, 5);
    }

    #[test]
    fn falls_back_to_sidecar_jsonl_model() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("sidecar");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("session-b.settings.json"),
            r#"{
                "providerLock": "anthropic",
                "providerLockTimestamp": "2026-05-02T01:02:03.000Z",
                "tokenUsage": {"inputTokens": 10, "outputTokens": 20}
            }"#,
        )
        .unwrap();
        fs::write(
            dir.join("session-b.jsonl"),
            r#"{"content":"Model: Claude Opus 4.5 Thinking [Anthropic]"}"#,
        )
        .unwrap();
        env::set_var(DROID_SESSIONS_DIR_ENV, &dir);

        let pricing = PricingMap::load_embedded();
        let entries = load_entries(&SharedArgs::default(), &pricing).unwrap();
        env::remove_var(DROID_SESSIONS_DIR_ENV);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].data.message.model.as_deref(),
            Some("claude-opus-4-5-thinking")
        );
    }

    #[test]
    fn keeps_latest_snapshot_for_duplicate_session_ids() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("dedupe-latest");
        let archive_dir = dir.join("archive");
        fs::create_dir_all(&archive_dir).unwrap();
        fs::write(
            archive_dir.join("session-c.settings.json"),
            r#"{
                "model": "gpt-5",
                "providerLock": "openai",
                "providerLockTimestamp": "2026-05-01T01:02:03.000Z",
                "tokenUsage": {"inputTokens": 10, "outputTokens": 20}
            }"#,
        )
        .unwrap();
        fs::write(
            dir.join("session-c.settings.json"),
            r#"{
                "model": "gpt-5",
                "providerLock": "openai",
                "providerLockTimestamp": "2026-05-02T01:02:03.000Z",
                "tokenUsage": {"inputTokens": 100, "outputTokens": 200}
            }"#,
        )
        .unwrap();
        env::set_var(DROID_SESSIONS_DIR_ENV, &dir);

        let pricing = PricingMap::load_embedded();
        let entries = load_entries(&SharedArgs::default(), &pricing).unwrap();
        env::remove_var(DROID_SESSIONS_DIR_ENV);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "session-c");
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 200);
    }

    #[test]
    fn report_total_includes_thinking_tokens() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("session-a".to_string()),
                timestamp: "2026-05-01T01:02:03.000Z".to_string(),
                version: None,
                message: UsageMessage {
                    usage: TokenUsageRaw {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 20,
                        cache_read_input_tokens: 10,
                        speed: None,
                    },
                    model: Some("claude-sonnet-4".to_string()),
                    id: Some("droid:session-a".to_string()),
                },
                cost_usd: None,
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: parse_ts_timestamp("2026-05-01T01:02:03.000Z").unwrap(),
            date: "2026-05-01".to_string(),
            project: Arc::from("droid"),
            session_id: Arc::from("session-a"),
            project_path: Arc::from("Droid"),
            cost: 0.0,
            credits: None,
            extra_total_tokens: 5,
            model: Some("claude-sonnet-4".to_string()),
            usage_limit_reset_time: None,
            message_count: None,
        };
        let rows = summarize_entries(&[entry], AgentReportKind::Daily).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["totalTokens"], json!(185));
        assert_eq!(report["totals"]["totalTokens"], json!(185));
    }
}
