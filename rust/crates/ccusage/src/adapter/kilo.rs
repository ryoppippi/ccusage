use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    adapter::opencode,
    apply_total_token_fallback, calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, WeekDay},
    debug_log, filter_loaded_entries_by_date, format_date_tz, json_value_u64,
    non_empty_json_string, parse_tz, print_json_or_jq, print_usage_table, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    LoadedEntry, PricingMap, Result, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

const KILO_DATA_DIR_ENV: &str = "KILO_DATA_DIR";
const KILO_DB_FILE_NAME: &str = "kilo.db";

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
        "Kilo Token Usage Report",
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
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Kilo, shared.json, || {
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
    for path in paths()? {
        let Some(db_path) = db_path(&path) else {
            continue;
        };
        for entry in load_entries_from_database(&db_path, tz.as_ref(), shared, pricing) {
            if let Some(id) = entry.data.message.id.as_deref() {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(KILO_DATA_DIR_ENV) {
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
        let path = home.join(".local").join("share").join("kilo");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn db_path(kilo_dir: &Path) -> Option<PathBuf> {
    let path = kilo_dir.join(KILO_DB_FILE_NAME);
    path.is_file().then_some(path)
}

fn load_entries_from_database(
    db_path: &Path,
    tz: Option<&JiffTimeZone>,
    shared: &crate::cli::SharedArgs,
    pricing: &PricingMap,
) -> Vec<LoadedEntry> {
    let Ok(connection) =
        sqlite::Connection::open_with_flags(db_path, sqlite::OpenFlags::new().with_read_only())
    else {
        debug_log(
            shared,
            format!("Failed to open Kilo database: {}", db_path.display()),
        );
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare("SELECT id, session_id, data FROM message") else {
        debug_log(
            shared,
            format!("Failed to read Kilo database: {}", db_path.display()),
        );
        return Vec::new();
    };
    let mut entries = Vec::new();
    loop {
        match statement.next() {
            Ok(sqlite::State::Row) => {
                let Ok(row_id) = statement.read::<String, _>(0) else {
                    continue;
                };
                let Ok(row_session_id) = statement.read::<String, _>(1) else {
                    continue;
                };
                let Ok(data) = statement.read::<String, _>(2) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                if let Some(entry) = message_value_to_entry(
                    &value,
                    &row_id,
                    &row_session_id,
                    db_path,
                    tz,
                    shared.mode,
                    pricing,
                ) {
                    entries.push(entry);
                }
            }
            Ok(sqlite::State::Done) => break,
            Err(_) => {
                debug_log(
                    shared,
                    format!("Failed to query Kilo database: {}", db_path.display()),
                );
                break;
            }
        }
    }
    entries
}

fn message_value_to_entry(
    value: &Value,
    row_id: &str,
    row_session_id: &str,
    db_path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &PricingMap,
) -> Option<LoadedEntry> {
    if value.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let tokens = value.get("tokens")?;
    let usage = TokenUsageRaw {
        input_tokens: json_value_u64(tokens.get("input")),
        output_tokens: json_value_u64(tokens.get("output")),
        cache_creation_input_tokens: tokens
            .get("cache")
            .map_or(0, |cache| json_value_u64(cache.get("write"))),
        cache_read_input_tokens: tokens
            .get("cache")
            .map_or(0, |cache| json_value_u64(cache.get("read"))),
        speed: None,
    };
    let reasoning_tokens = json_value_u64(tokens.get("reasoning"));
    let total_tokens = json_value_u64(tokens.get("total"));
    let (usage, extra_total_tokens) =
        apply_total_token_fallback(usage, reasoning_tokens, total_tokens);
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_creation_input_tokens == 0
        && usage.cache_read_input_tokens == 0
        && extra_total_tokens == 0
    {
        return None;
    }
    let model = non_empty_json_string(value.get("modelID"))?;
    let timestamp = value
        .get("time")
        .and_then(|time| time.get("created"))
        .and_then(Value::as_i64)
        .and_then(normalize_timestamp)?;
    let timestamp_text = crate::format_rfc3339_millis(timestamp);
    let session_id = non_empty_json_string(value.get("session_id"))
        .unwrap_or_else(|| row_session_id.to_string());
    let message_id = non_empty_json_string(value.get("id"))
        .unwrap_or_else(|| format!("{}:{row_id}", db_path.display()));
    let cost_usd = value.get("cost").and_then(Value::as_f64);
    let data = UsageEntry {
        session_id: Some(session_id.clone()),
        timestamp: timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(model.clone()),
            id: Some(message_id),
        },
        cost_usd,
        request_id: None,
        is_api_error_message: None,
    };
    let provider = non_empty_json_string(value.get("providerID"));
    let cost_data = UsageEntry {
        message: UsageMessage {
            usage: TokenUsageRaw {
                output_tokens: data
                    .message
                    .usage
                    .output_tokens
                    .saturating_add(extra_total_tokens),
                ..data.message.usage
            },
            ..data.message.clone()
        },
        ..data.clone()
    };
    let cost = calculate_kilo_cost(&cost_data, provider.as_deref(), mode, pricing);
    Some(LoadedEntry {
        date: format_date_tz(timestamp, tz),
        timestamp,
        project: Arc::from("kilo"),
        session_id: Arc::from(session_id),
        project_path: Arc::from("Kilo"),
        cost,
        extra_total_tokens,
        credits: None,
        model: Some(model),
        usage_limit_reset_time: None,
        message_count: None,
        data,
    })
}

fn normalize_timestamp(value: i64) -> Option<TimestampMs> {
    if value <= 0 {
        return None;
    }
    let millis = if value < 1_000_000_000_000 {
        value.checked_mul(1000)?
    } else {
        value
    };
    Some(TimestampMs::from_millis(millis))
}

fn calculate_kilo_cost(
    data: &UsageEntry,
    provider: Option<&str>,
    mode: CostMode,
    pricing: &PricingMap,
) -> f64 {
    match mode {
        CostMode::Display => data.cost_usd.unwrap_or(0.0),
        CostMode::Auto => data
            .cost_usd
            .unwrap_or_else(|| calculate_kilo_cost_from_tokens(data, provider, pricing)),
        CostMode::Calculate => calculate_kilo_cost_from_tokens(data, provider, pricing),
    }
}

fn calculate_kilo_cost_from_tokens(
    data: &UsageEntry,
    provider: Option<&str>,
    pricing: &PricingMap,
) -> f64 {
    let Some(model) = data.message.model.as_deref() else {
        return 0.0;
    };
    for candidate in model_candidates(model, provider) {
        if pricing.find(&candidate).is_some() {
            return calculate_cost_for_usage(
                Some(&candidate),
                data.message.usage,
                None,
                CostMode::Calculate,
                Some(pricing),
            );
        }
    }
    0.0
}

fn model_candidates(model: &str, provider: Option<&str>) -> Vec<String> {
    let mut candidates = vec![model.to_string()];
    if let Some(provider) = provider
        .map(normalize_provider)
        .filter(|provider| provider != "unknown" && provider != "kilo")
    {
        candidates.push(format!("{provider}/{model}"));
    }
    candidates.sort();
    candidates.dedup();
    candidates
}

fn normalize_provider(provider: &str) -> String {
    provider.replace('-', "_")
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use super::*;

    static KILO_DATA_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn temp_kilo_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-kilo-{name}-{nanos}"));
        path
    }

    fn create_db_message(path: &Path, id: &str, session_id: &str, data: &str) {
        let db = sqlite::open(path).unwrap();
        db.execute("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)")
            .unwrap();
        let mut statement = db
            .prepare("INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)")
            .unwrap();
        statement.bind((1, id)).unwrap();
        statement.bind((2, session_id)).unwrap();
        statement.bind((3, data)).unwrap();
        statement.next().unwrap();
    }

    #[test]
    fn loads_kilo_messages_from_sqlite() {
        let _guard = KILO_DATA_DIR_LOCK.lock().unwrap();
        let kilo_dir = temp_kilo_dir("sqlite");
        fs::create_dir_all(&kilo_dir).unwrap();
        create_db_message(
            &kilo_dir.join(KILO_DB_FILE_NAME),
            "row-1",
            "session-a",
            r#"{"id":"msg-1","role":"assistant","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":100,"output":50,"reasoning":5,"cache":{"read":10,"write":20}},"cost":0.02,"agent":"build"}"#,
        );
        env::set_var(KILO_DATA_DIR_ENV, &kilo_dir);
        let shared = crate::cli::SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..crate::cli::SharedArgs::default()
        };
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();
        env::remove_var(KILO_DATA_DIR_ENV);
        fs::remove_dir_all(&kilo_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-02");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(
            entries[0].model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
        assert_eq!(entries[0].extra_total_tokens, 5);
        assert_eq!(entries[0].cost, 0.02);
    }

    #[test]
    fn ignores_kilo_messages_without_timestamps() {
        let _guard = KILO_DATA_DIR_LOCK.lock().unwrap();
        let kilo_dir = temp_kilo_dir("missing-timestamp");
        fs::create_dir_all(&kilo_dir).unwrap();
        create_db_message(
            &kilo_dir.join(KILO_DB_FILE_NAME),
            "row-1",
            "session-a",
            r#"{"role":"assistant","providerID":"openai","modelID":"gpt-5","tokens":{"input":1,"output":1,"cache":{"read":0,"write":0}}}"#,
        );
        env::set_var(KILO_DATA_DIR_ENV, &kilo_dir);
        let shared = crate::cli::SharedArgs::default();
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();
        env::remove_var(KILO_DATA_DIR_ENV);
        fs::remove_dir_all(&kilo_dir).unwrap();

        assert!(entries.is_empty());
    }

    #[test]
    fn falls_back_to_total_tokens_when_kilo_parts_are_missing() {
        let value = serde_json::json!({
            "id": "msg-1",
            "role": "assistant",
            "providerID": "openai",
            "modelID": "gpt-5",
            "time": { "created": 1767312000000_i64 },
            "tokens": { "total": 234 }
        });
        let entry = message_value_to_entry(
            &value,
            "row-1",
            "session-a",
            Path::new("/tmp/kilo.db"),
            None,
            CostMode::Auto,
            &PricingMap::load_embedded(),
        )
        .unwrap();

        assert_eq!(entry.data.message.usage.output_tokens, 234);
        assert_eq!(entry.extra_total_tokens, 0);
    }

    #[test]
    fn deduplicates_kilo_messages_across_data_dirs() {
        let _guard = KILO_DATA_DIR_LOCK.lock().unwrap();
        let first = temp_kilo_dir("first");
        let second = temp_kilo_dir("second");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        for (dir, input) in [(&first, 10), (&second, 20)] {
            create_db_message(
                &dir.join(KILO_DB_FILE_NAME),
                "row-1",
                "session-a",
                &format!(
                    r#"{{"id":"embedded-msg-1","role":"assistant","providerID":"openai","modelID":"gpt-5","time":{{"created":1767312000000}},"tokens":{{"input":{input},"output":1,"cache":{{"read":0,"write":0}}}}}}"#
                ),
            );
        }
        env::set_var(
            KILO_DATA_DIR_ENV,
            format!("{},{}", first.display(), second.display()),
        );
        let shared = crate::cli::SharedArgs::default();
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();
        env::remove_var(KILO_DATA_DIR_ENV);
        fs::remove_dir_all(&first).unwrap();
        fs::remove_dir_all(&second).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.message.usage.input_tokens, 10);
    }
}
