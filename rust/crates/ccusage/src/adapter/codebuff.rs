use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, SharedArgs, WeekDay},
    collect_files_with_extension, filter_loaded_entries_by_date, format_date_tz,
    format_rfc3339_millis, parse_ts_timestamp, parse_tz, print_json_or_jq, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    LoadedEntry, PricingMap, Result, TokenUsageRaw, UsageEntry, UsageMessage, UsageSummary,
};

const CODEBUFF_DATA_DIR_ENV: &str = "CODEBUFF_DATA_DIR";
const DEFAULT_CODEBUFF_MODEL: &str = "codebuff-unknown";
const CHANNELS: &[&str] = &["manicode", "manicode-dev", "manicode-staging"];

#[derive(Clone, Default)]
struct AssistantUsage {
    model: Option<String>,
    credits: f64,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_input_tokens: u64,
    cache_read_input_tokens: u64,
}

struct CodebuffEntry {
    timestamp: crate::TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    provider: String,
    credits: f64,
    usage: TokenUsageRaw,
    dedup_key: String,
}

struct CodebuffContext {
    chat_id: String,
    session_id: String,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, summary_period);
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    crate::adapter::amp::print_table(args.kind, &rows, &shared);
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| crate::adapter::opencode::agent_summary_json(row, kind, false))
        .collect::<Vec<_>>();
    serde_json::json!({
        rows_key(kind): rows_json,
        "totals": totals_json(rows),
    })
}

fn summary_period(row: &UsageSummary) -> &str {
    row.date
        .as_deref()
        .or(row.month.as_deref())
        .or(row.session_id.as_deref())
        .unwrap_or("")
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
    crate::progress::track_usage_load(
        crate::progress::UsageLoadAgent::Codebuff,
        shared.json,
        || load_entries_inner(shared, pricing),
    )
}

fn load_entries_inner(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut files = discover_chat_files()?;
    files.sort();
    let mut deduped = HashMap::<String, CodebuffEntry>::new();
    for file in files {
        for entry in load_chat_file(&file)? {
            deduped.insert(entry.dedup_key.clone(), entry);
        }
    }
    let mut entries = deduped
        .into_values()
        .map(|entry| to_loaded_entry(entry, tz.as_ref(), pricing))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn discover_chat_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for root in codebuff_project_roots()? {
        collect_files_with_extension(&root, "json", &mut files);
    }
    Ok(files
        .into_iter()
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name == "chat-messages.json")
        })
        .collect())
}

fn codebuff_project_roots() -> Result<Vec<PathBuf>> {
    let roots = if let Ok(paths) = env::var(CODEBUFF_DATA_DIR_ENV) {
        paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        let home =
            crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
        CHANNELS
            .iter()
            .map(|channel| home.join(".config").join(channel))
            .collect()
    };
    let mut seen = HashSet::new();
    let mut project_roots = Vec::new();
    for root in roots {
        let project_root = if root.file_name().is_some_and(|name| name == "projects") {
            root
        } else {
            root.join("projects")
        };
        if project_root.is_dir() && seen.insert(project_root.clone()) {
            project_roots.push(project_root);
        }
    }
    Ok(project_roots)
}

fn load_chat_file(path: &Path) -> Result<Vec<CodebuffEntry>> {
    let content = fs::read_to_string(path)?;
    let Ok(messages) = serde_json::from_str::<Value>(&content) else {
        return Ok(Vec::new());
    };
    let Some(messages) = messages.as_array() else {
        return Ok(Vec::new());
    };
    let context = derive_context(path);
    let chat_timestamp = parse_codebuff_chat_id_timestamp(&context.chat_id);
    let file_timestamp = file_modified_timestamp(path).unwrap_or(crate::TimestampMs::UNIX_EPOCH);
    let mut entries = Vec::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let Some(message) = message.as_object() else {
            continue;
        };
        if !is_assistant_message(message) {
            continue;
        }
        let usage = extract_assistant_usage(message);
        if !has_signal(&usage) {
            continue;
        }
        let timestamp = message_timestamp(message)
            .or(chat_timestamp)
            .unwrap_or(file_timestamp);
        let model = usage
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_CODEBUFF_MODEL.to_string());
        let dedup_key = dedup_key(
            message,
            &context.session_id,
            timestamp,
            &model,
            &usage,
            ordinal,
        );
        entries.push(CodebuffEntry {
            timestamp,
            timestamp_text: format_rfc3339_millis(timestamp),
            session_id: context.session_id.clone(),
            provider: infer_provider(&model).to_string(),
            model,
            credits: usage.credits,
            usage: TokenUsageRaw {
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_creation_input_tokens: usage.cache_creation_input_tokens,
                cache_read_input_tokens: usage.cache_read_input_tokens,
                speed: None,
            },
            dedup_key,
        });
    }
    Ok(entries)
}

fn to_loaded_entry(
    entry: CodebuffEntry,
    tz: Option<&JiffTimeZone>,
    pricing: &PricingMap,
) -> LoadedEntry {
    let cost = calculate_codebuff_cost(&entry, pricing);
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text.clone(),
        version: None,
        message: UsageMessage {
            usage: entry.usage,
            model: Some(entry.model.clone()),
            id: Some(entry.dedup_key.clone()),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("codebuff"),
        session_id: Arc::from(entry.session_id.as_str()),
        project_path: Arc::from("Codebuff"),
        cost,
        extra_total_tokens: 0,
        credits: (entry.credits > 0.0).then_some(entry.credits),
        model: Some(entry.model),
        usage_limit_reset_time: None,
        message_count: None,
        data,
    }
}

fn derive_context(path: &Path) -> CodebuffContext {
    let chat_id = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let chats_dir = path.parent().and_then(Path::parent);
    let project_dir = chats_dir.and_then(Path::parent);
    let project = project_dir
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let channel = project_dir
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("manicode")
        .to_string();
    CodebuffContext {
        session_id: format!("{channel}/{project}/{chat_id}"),
        chat_id,
    }
}

fn is_assistant_message(message: &serde_json::Map<String, Value>) -> bool {
    matches!(
        string_field(message, "variant")
            .or_else(|| string_field(message, "role"))
            .as_deref(),
        Some("ai" | "agent" | "assistant")
    )
}

fn extract_assistant_usage(message: &serde_json::Map<String, Value>) -> AssistantUsage {
    let mut usage = AssistantUsage::default();
    if let Some(metadata) = object_field(message, "metadata") {
        usage.model = string_field(metadata, "model");
        merge_fallback(&mut usage, parse_usage_object(metadata.get("usage")));
        merge_fallback(
            &mut usage,
            parse_usage_object(
                metadata
                    .get("codebuff")
                    .and_then(Value::as_object)
                    .and_then(|codebuff| codebuff.get("usage")),
            ),
        );
        if let Some(run_state_usage) = extract_usage_from_run_state(metadata) {
            merge_fallback(&mut usage, run_state_usage);
        }
    }
    let credits = number_field(message, "credits");
    if credits > 0.0 && usage.credits <= 0.0 {
        usage.credits = credits;
    }
    usage
}

fn extract_usage_from_run_state(
    metadata: &serde_json::Map<String, Value>,
) -> Option<AssistantUsage> {
    let history = metadata
        .get("runState")?
        .get("sessionState")?
        .get("mainAgentState")?
        .get("messageHistory")?
        .as_array()?;
    let mut usage = AssistantUsage::default();
    let mut found = false;
    for item in history.iter().rev() {
        let Some(entry) = item.as_object() else {
            continue;
        };
        if string_field(entry, "role").as_deref() != Some("assistant") {
            continue;
        }
        let Some(provider_options) = object_field(entry, "providerOptions") else {
            continue;
        };
        let mut entry_usage = AssistantUsage::default();
        merge_fallback(
            &mut entry_usage,
            parse_usage_object(provider_options.get("usage")),
        );
        if let Some(codebuff) = object_field(provider_options, "codebuff") {
            merge_fallback(&mut entry_usage, parse_usage_object(codebuff.get("usage")));
            entry_usage.model = string_field(codebuff, "model").or(entry_usage.model);
        }
        if has_signal(&entry_usage) || entry_usage.model.is_some() {
            found = true;
        }
        merge_fallback(&mut usage, entry_usage);
    }
    found.then_some(usage)
}

fn parse_usage_object(value: Option<&Value>) -> AssistantUsage {
    let mut usage = AssistantUsage::default();
    let Some(record) = value.and_then(Value::as_object) else {
        return usage;
    };
    usage.input_tokens = pick_u64(
        record,
        &[
            "inputTokens",
            "input_tokens",
            "promptTokens",
            "prompt_tokens",
        ],
    );
    usage.output_tokens = pick_u64(
        record,
        &[
            "outputTokens",
            "output_tokens",
            "completionTokens",
            "completion_tokens",
        ],
    );
    usage.cache_read_input_tokens =
        pick_u64(record, &["cacheReadInputTokens", "cache_read_input_tokens"])
            .max(pick_nested_u64(
                record,
                "promptTokensDetails",
                &["cachedTokens"],
            ))
            .max(pick_nested_u64(
                record,
                "prompt_tokens_details",
                &["cached_tokens"],
            ));
    usage.cache_creation_input_tokens = pick_u64(
        record,
        &[
            "cacheCreationInputTokens",
            "cache_creation_input_tokens",
            "cacheCreationTokens",
            "cache_creation_tokens",
            "cachedTokensCreated",
            "cached_tokens_created",
        ],
    );
    usage.credits = number_field(record, "credits");
    usage.model = string_field(record, "model");
    usage
}

fn merge_fallback(target: &mut AssistantUsage, fallback: AssistantUsage) {
    if target.input_tokens == 0 {
        target.input_tokens = fallback.input_tokens;
    }
    if target.output_tokens == 0 {
        target.output_tokens = fallback.output_tokens;
    }
    if target.cache_creation_input_tokens == 0 {
        target.cache_creation_input_tokens = fallback.cache_creation_input_tokens;
    }
    if target.cache_read_input_tokens == 0 {
        target.cache_read_input_tokens = fallback.cache_read_input_tokens;
    }
    if target.credits <= 0.0 {
        target.credits = fallback.credits;
    }
    if target.model.is_none() {
        target.model = fallback.model;
    }
}

fn has_signal(usage: &AssistantUsage) -> bool {
    usage.input_tokens > 0
        || usage.output_tokens > 0
        || usage.cache_creation_input_tokens > 0
        || usage.cache_read_input_tokens > 0
        || usage.credits > 0.0
}

fn message_timestamp(message: &serde_json::Map<String, Value>) -> Option<crate::TimestampMs> {
    timestamp_value(message.get("timestamp"))
        .or_else(|| timestamp_value(message.get("createdAt")))
        .or_else(|| {
            object_field(message, "metadata")
                .and_then(|metadata| timestamp_value(metadata.get("timestamp")))
        })
}

fn parse_codebuff_chat_id_timestamp(chat_id: &str) -> Option<crate::TimestampMs> {
    let (date, time) = chat_id.split_once('T')?;
    let mut time = time.to_string();
    for _ in 0..2 {
        if let Some(index) = time.find('-') {
            time.replace_range(index..=index, ":");
        }
    }
    parse_ts_timestamp(&format!("{date}T{time}"))
}

fn timestamp_value(value: Option<&Value>) -> Option<crate::TimestampMs> {
    match value? {
        Value::String(value) => parse_ts_timestamp(value),
        Value::Number(value) => {
            let raw = value.as_i64()?;
            let millis = if raw < 10_000_000_000 {
                raw.checked_mul(1_000)?
            } else {
                raw
            };
            (millis > 0).then(|| crate::TimestampMs::from_millis(millis))
        }
        _ => None,
    }
}

fn file_modified_timestamp(path: &Path) -> Option<crate::TimestampMs> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let millis = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis()
        .min(i64::MAX as u128) as i64;
    Some(crate::TimestampMs::from_millis(millis))
}

fn dedup_key(
    message: &serde_json::Map<String, Value>,
    session_id: &str,
    timestamp: crate::TimestampMs,
    model: &str,
    usage: &AssistantUsage,
    ordinal: usize,
) -> String {
    if let Some(id) = string_field(message, "id") {
        return format!("codebuff:{session_id}:{id}");
    }
    format!(
        "codebuff:{session_id}:{}:{model}:{ordinal}:{}:{}:{}:{}",
        format_rfc3339_millis(timestamp),
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens
    )
}

fn infer_provider(model: &str) -> &'static str {
    let model = model.to_ascii_lowercase();
    if model.starts_with("claude-")
        || model.starts_with("anthropic/")
        || model.starts_with("anthropic.")
    {
        "anthropic"
    } else if model.starts_with("gpt-")
        || model.starts_with("o1")
        || model.starts_with("o3")
        || model.starts_with("o4")
        || model.starts_with("openai/")
    {
        "openai"
    } else if model.starts_with("gemini") || model.starts_with("google/") {
        "google"
    } else if model.starts_with("grok") || model.starts_with("xai/") {
        "xai"
    } else if model.starts_with("openrouter/") {
        "openrouter"
    } else {
        "unknown"
    }
}

fn calculate_codebuff_cost(entry: &CodebuffEntry, pricing: &PricingMap) -> f64 {
    let raw = calculate_cost_for_usage(
        Some(&entry.model),
        entry.usage,
        None,
        CostMode::Calculate,
        Some(pricing),
    );
    if raw > 0.0
        || entry.provider == "unknown"
        || entry.model.starts_with(&format!("{}/", entry.provider))
    {
        return raw;
    }
    calculate_cost_for_usage(
        Some(&format!("{}/{}", entry.provider, entry.model)),
        entry.usage,
        None,
        CostMode::Calculate,
        Some(pricing),
    )
}

fn object_field<'a>(
    record: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a serde_json::Map<String, Value>> {
    record.get(key).and_then(Value::as_object)
}

fn string_field(record: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    let value = record.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn number_field(record: &serde_json::Map<String, Value>, key: &str) -> f64 {
    record
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(0.0)
}

fn pick_u64(record: &serde_json::Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .filter_map(|key| record.get(*key))
        .find_map(|value| value.as_u64().filter(|value| *value > 0))
        .unwrap_or(0)
}

fn pick_nested_u64(record: &serde_json::Map<String, Value>, key: &str, keys: &[&str]) -> u64 {
    object_field(record, key).map_or(0, |nested| pick_u64(nested, keys))
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
        env::temp_dir().join(format!("ccusage-codebuff-{name}-{nanos}"))
    }

    #[test]
    fn loads_assistant_usage_from_chat_messages() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("chat");
        let chat_dir = dir.join("projects/project-a/chats/2026-01-02T03-04-05.000Z");
        fs::create_dir_all(&chat_dir).unwrap();
        fs::write(
            chat_dir.join("chat-messages.json"),
            r#"[
                {"role":"user","text":"hello"},
                {"id":"assistant-message","role":"assistant","timestamp":"2026-01-02T03:04:06.000Z","metadata":{"model":"claude-sonnet-4-20250514","usage":{"inputTokens":100,"outputTokens":50,"cacheCreationInputTokens":20,"cacheReadInputTokens":10}},"credits":1.25}
            ]"#,
        )
        .unwrap();
        env::set_var(CODEBUFF_DATA_DIR_ENV, &dir);

        let pricing = PricingMap::load_embedded();
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, &pricing).unwrap();
        env::remove_var(CODEBUFF_DATA_DIR_ENV);
        fs::remove_dir_all(&dir).unwrap();

        let channel = dir.file_name().unwrap().to_str().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-02");
        assert_eq!(
            entries[0].session_id.as_ref(),
            format!("{channel}/project-a/2026-01-02T03-04-05.000Z")
        );
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
        assert_eq!(entries[0].credits, Some(1.25));
    }

    #[test]
    fn falls_back_to_run_state_provider_usage() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = temp_dir("run-state");
        let chat_dir = dir.join("projects/project-a/chats/2026-01-02T03-04-05.000Z");
        fs::create_dir_all(&chat_dir).unwrap();
        fs::write(
            chat_dir.join("chat-messages.json"),
            r#"[
                {"variant":"agent","metadata":{"runState":{"sessionState":{"mainAgentState":{"messageHistory":[
                    {"role":"user","providerOptions":{}},
                    {"role":"assistant","providerOptions":{"codebuff":{"model":"openai/gpt-5","usage":{"prompt_tokens":100,"completion_tokens":50,"prompt_tokens_details":{"cached_tokens":10}}}}}
                ]}}}}}
            ]"#,
        )
        .unwrap();
        env::set_var(CODEBUFF_DATA_DIR_ENV, &dir);

        let pricing = PricingMap::load_embedded();
        let entries = load_entries(&SharedArgs::default(), &pricing).unwrap();
        env::remove_var(CODEBUFF_DATA_DIR_ENV);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].data.message.model.as_deref(),
            Some("openai/gpt-5")
        );
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
    }

    #[test]
    fn report_includes_credits() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("session-a".to_string()),
                timestamp: "2026-01-02T03:04:06.000Z".to_string(),
                version: None,
                message: UsageMessage {
                    usage: TokenUsageRaw {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 20,
                        cache_read_input_tokens: 10,
                        speed: None,
                    },
                    model: Some("claude-sonnet-4-20250514".to_string()),
                    id: Some("message-a".to_string()),
                },
                cost_usd: None,
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: parse_ts_timestamp("2026-01-02T03:04:06.000Z").unwrap(),
            date: "2026-01-02".to_string(),
            project: Arc::from("codebuff"),
            session_id: Arc::from("session-a"),
            project_path: Arc::from("Codebuff"),
            cost: 0.02,
            extra_total_tokens: 0,
            credits: Some(1.25),
            model: Some("claude-sonnet-4-20250514".to_string()),
            usage_limit_reset_time: None,
            message_count: None,
        };
        let rows = summarize_entries(&[entry], AgentReportKind::Daily).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["credits"], serde_json::json!(1.25));
        assert_eq!(report["totals"]["credits"], serde_json::json!(1.25));
    }
}
