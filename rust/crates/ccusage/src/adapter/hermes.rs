use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, SharedArgs, WeekDay},
    filter_loaded_entries_by_date, format_date_tz, format_rfc3339_millis, print_json_or_jq,
    print_usage_table, sort_summaries, summarize_by_key, summarize_summaries_by_bucket,
    totals_json, wants_json, BucketKind, LoadedEntry, PricingMap, Result, TimestampMs,
    TokenUsageRaw, UsageEntry, UsageMessage, UsageSummary,
};

const HERMES_HOME_ENV: &str = "HERMES_HOME";

struct HermesEntry {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    provider: String,
    usage: TokenUsageRaw,
    reasoning_tokens: u64,
    message_count: u64,
    cost_usd: Option<f64>,
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
        "Hermes Token Usage Report",
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
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Hermes, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = crate::parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen_sessions = HashSet::new();
    for db_path in hermes_state_db_paths()? {
        for entry in load_state_db_entries(&db_path, shared) {
            if !seen_sessions.insert(entry.session_id.clone()) {
                continue;
            }
            entries.push(to_loaded_entry(entry, tz.as_ref(), pricing));
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn hermes_state_db_paths() -> Result<Vec<PathBuf>> {
    let homes = if let Ok(paths) = env::var(HERMES_HOME_ENV) {
        paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    } else {
        let home =
            crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
        vec![home.join(".hermes")]
    };
    let mut seen = HashSet::new();
    Ok(homes
        .into_iter()
        .map(|home| home.join("state.db"))
        .filter(|path| path.is_file())
        .filter(|path| seen.insert(path.clone()))
        .collect())
}

fn load_state_db_entries(db_path: &Path, shared: &SharedArgs) -> Vec<HermesEntry> {
    let Ok(connection) =
        sqlite::Connection::open_with_flags(db_path, sqlite::OpenFlags::new().with_read_only())
    else {
        crate::debug_log(
            shared,
            format!(
                "Failed to open Hermes state database: {}",
                db_path.display()
            ),
        );
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare(
        "
            SELECT
                id,
                model,
                billing_provider,
                started_at,
                message_count,
                input_tokens,
                output_tokens,
                cache_read_tokens,
                cache_write_tokens,
                reasoning_tokens,
                estimated_cost_usd,
                actual_cost_usd
            FROM sessions
            WHERE model IS NOT NULL
                AND TRIM(model) != ''
        ",
    ) else {
        crate::debug_log(
            shared,
            format!(
                "Failed to read Hermes state database: {}",
                db_path.display()
            ),
        );
        return Vec::new();
    };
    let mut entries = Vec::new();
    loop {
        match statement.next() {
            Ok(sqlite::State::Row) => {
                if let Some(entry) = read_session_row(&statement) {
                    entries.push(entry);
                }
            }
            Ok(sqlite::State::Done) => break,
            Err(_) => {
                crate::debug_log(
                    shared,
                    format!(
                        "Failed to query Hermes state database: {}",
                        db_path.display()
                    ),
                );
                break;
            }
        }
    }
    entries
}

fn read_session_row(statement: &sqlite::Statement<'_>) -> Option<HermesEntry> {
    let session_id = statement.read::<String, _>(0).ok()?;
    let model = statement.read::<String, _>(1).ok()?.trim().to_string();
    if session_id.is_empty() || model.is_empty() {
        return None;
    }
    let provider_raw = statement.read::<String, _>(2).ok();
    let started_at = read_f64(statement, 3)?;
    let timestamp = timestamp_from_number(started_at)?;
    let message_count = read_u64(statement, 4);
    let input_tokens = read_u64(statement, 5);
    let output_tokens = read_u64(statement, 6);
    let cache_read_tokens = read_u64(statement, 7);
    let cache_creation_tokens = read_u64(statement, 8);
    let reasoning_tokens = read_u64(statement, 9);
    let estimated_cost = read_non_negative_f64(statement, 10);
    let actual_cost = read_non_negative_f64(statement, 11);
    let cost_usd = actual_cost.or(estimated_cost);
    if input_tokens == 0
        && output_tokens == 0
        && cache_read_tokens == 0
        && cache_creation_tokens == 0
        && reasoning_tokens == 0
        && cost_usd.unwrap_or(0.0) == 0.0
    {
        return None;
    }
    Some(HermesEntry {
        timestamp,
        timestamp_text: format_rfc3339_millis(timestamp),
        session_id,
        provider: normalize_provider(provider_raw.as_deref(), &model),
        model,
        usage: TokenUsageRaw {
            input_tokens,
            output_tokens,
            cache_creation_input_tokens: cache_creation_tokens,
            cache_read_input_tokens: cache_read_tokens,
            speed: None,
        },
        reasoning_tokens,
        message_count,
        cost_usd,
    })
}

fn read_u64(statement: &sqlite::Statement<'_>, index: usize) -> u64 {
    statement
        .read::<i64, _>(index)
        .ok()
        .and_then(|value| u64::try_from(value.max(0)).ok())
        .or_else(|| {
            statement
                .read::<f64, _>(index)
                .ok()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map(|value| value.trunc() as u64)
        })
        .unwrap_or(0)
}

fn read_f64(statement: &sqlite::Statement<'_>, index: usize) -> Option<f64> {
    statement
        .read::<f64, _>(index)
        .ok()
        .filter(|value| value.is_finite())
        .or_else(|| {
            statement
                .read::<i64, _>(index)
                .ok()
                .map(|value| value as f64)
        })
}

fn read_non_negative_f64(statement: &sqlite::Statement<'_>, index: usize) -> Option<f64> {
    read_f64(statement, index).map(|value| value.max(0.0))
}

fn timestamp_from_number(value: f64) -> Option<TimestampMs> {
    if !value.is_finite() {
        return None;
    }
    let millis = if value > 1e12 { value } else { value * 1000.0 };
    (millis > 0.0).then(|| TimestampMs::from_millis(millis.trunc() as i64))
}

fn normalize_provider(value: Option<&str>, model: &str) -> String {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return infer_provider_from_model(model).to_string();
    };
    let normalized = value.to_ascii_lowercase().replace('-', "_");
    match normalized.as_str() {
        "anthropic" | "claude" => "anthropic".to_string(),
        "openai" | "openai_codex" => "openai".to_string(),
        "google" | "google_ai" | "gemini" | "vertex" | "vertex_ai" => "google".to_string(),
        "openrouter" => "openrouter".to_string(),
        "xai" => "xai".to_string(),
        "groq" => "groq".to_string(),
        value => value.to_string(),
    }
}

fn infer_provider_from_model(model: &str) -> &'static str {
    let model = model.to_ascii_lowercase();
    if model.starts_with("claude-") || model.starts_with("claude/") {
        "anthropic"
    } else if model.starts_with("gpt")
        || model.starts_with("chatgpt")
        || model.starts_with('o') && model.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
    {
        "openai"
    } else if model.starts_with("gemini-") || model.starts_with("gemini/") {
        "google"
    } else {
        "hermes"
    }
}

fn to_loaded_entry(
    entry: HermesEntry,
    tz: Option<&JiffTimeZone>,
    pricing: &PricingMap,
) -> LoadedEntry {
    let cost = calculate_hermes_cost(&entry, pricing);
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text.clone(),
        version: None,
        message: UsageMessage {
            usage: entry.usage,
            model: Some(entry.model.clone()),
            id: Some(format!("hermes:{}", entry.session_id)),
        },
        cost_usd: entry.cost_usd,
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("hermes"),
        session_id: Arc::from(entry.session_id.as_str()),
        project_path: Arc::from("Hermes"),
        cost,
        credits: None,
        extra_total_tokens: entry.reasoning_tokens,
        message_count: Some(entry.message_count),
        model: Some(entry.model),
        usage_limit_reset_time: None,
        data,
    }
}

fn calculate_hermes_cost(entry: &HermesEntry, pricing: &PricingMap) -> f64 {
    if let Some(cost) = entry.cost_usd {
        return cost;
    }
    let usage = TokenUsageRaw {
        output_tokens: entry.usage.output_tokens + entry.reasoning_tokens,
        ..entry.usage
    };
    for candidate in model_candidates(entry) {
        let cost = calculate_cost_for_usage(
            Some(&candidate),
            usage,
            None,
            CostMode::Calculate,
            Some(pricing),
        );
        if cost >= 0.0 && cost.is_finite() && cost > 0.0 {
            return cost;
        }
    }
    0.0
}

fn model_candidates(entry: &HermesEntry) -> Vec<String> {
    let mut candidates = Vec::new();
    if entry.provider != "hermes" {
        candidates.push(format!("{}/{}", entry.provider, entry.model));
    }
    candidates.push(entry.model.clone());
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("ccusage-hermes-{name}-{nanos}"))
    }

    fn create_state_db(path: &Path) {
        let db = sqlite::open(path).unwrap();
        db.execute(
            "
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    source TEXT NOT NULL,
                    model TEXT,
                    started_at REAL NOT NULL,
                    message_count INTEGER DEFAULT 0,
                    input_tokens INTEGER DEFAULT 0,
                    output_tokens INTEGER DEFAULT 0,
                    cache_read_tokens INTEGER DEFAULT 0,
                    cache_write_tokens INTEGER DEFAULT 0,
                    reasoning_tokens INTEGER DEFAULT 0,
                    billing_provider TEXT,
                    estimated_cost_usd REAL,
                    actual_cost_usd REAL
                );
            ",
        )
        .unwrap();
    }

    #[test]
    fn loads_billable_hermes_sessions_from_state_db() {
        let dir = temp_dir("state");
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("state.db");
        create_state_db(&db_path);
        let db = sqlite::open(&db_path).unwrap();
        let mut statement = db
            .prepare(
                "
                    INSERT INTO sessions (
                        id, source, model, started_at, message_count,
                        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
                        billing_provider, estimated_cost_usd, actual_cost_usd
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                ",
            )
            .unwrap();
        statement.bind((1, "session-1")).unwrap();
        statement.bind((2, "cli")).unwrap();
        statement.bind((3, "claude-sonnet-4-20250514")).unwrap();
        statement.bind((4, 1_750_000_000.25)).unwrap();
        statement.bind((5, 42_i64)).unwrap();
        statement.bind((6, 1200_i64)).unwrap();
        statement.bind((7, 300_i64)).unwrap();
        statement.bind((8, 50_i64)).unwrap();
        statement.bind((9, 20_i64)).unwrap();
        statement.bind((10, 10_i64)).unwrap();
        statement.bind((11, "anthropic")).unwrap();
        statement.bind((12, 0.12)).unwrap();
        statement.bind((13, 0.34)).unwrap();
        statement.next().unwrap();

        let pricing = PricingMap::load_embedded();
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let tz = crate::parse_tz(shared.timezone.as_deref());
        let entries = load_state_db_entries(&db_path, &shared)
            .into_iter()
            .map(|entry| to_loaded_entry(entry, tz.as_ref(), &pricing))
            .collect::<Vec<_>>();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2025-06-15");
        assert_eq!(entries[0].session_id.as_ref(), "session-1");
        assert_eq!(
            entries[0].model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(entries[0].data.message.usage.input_tokens, 1200);
        assert_eq!(entries[0].data.message.usage.output_tokens, 300);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 50);
        assert_eq!(entries[0].extra_total_tokens, 10);
        assert_eq!(entries[0].message_count, Some(42));
        assert_eq!(entries[0].cost, 0.34);
    }

    #[test]
    fn report_includes_message_count_and_reasoning_total() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("session-1".to_string()),
                timestamp: "2025-06-15T15:06:40.250Z".to_string(),
                version: None,
                message: UsageMessage {
                    usage: TokenUsageRaw {
                        input_tokens: 1200,
                        output_tokens: 300,
                        cache_creation_input_tokens: 20,
                        cache_read_input_tokens: 50,
                        speed: None,
                    },
                    model: Some("claude-sonnet-4-20250514".to_string()),
                    id: Some("hermes:session-1".to_string()),
                },
                cost_usd: Some(0.34),
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: crate::parse_ts_timestamp("2025-06-15T15:06:40.250Z").unwrap(),
            date: "2025-06-15".to_string(),
            project: Arc::from("hermes"),
            session_id: Arc::from("session-1"),
            project_path: Arc::from("Hermes"),
            cost: 0.34,
            credits: None,
            extra_total_tokens: 10,
            message_count: Some(42),
            model: Some("claude-sonnet-4-20250514".to_string()),
            usage_limit_reset_time: None,
        };
        let rows = summarize_entries(&[entry], AgentReportKind::Daily).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["totalTokens"], json!(1580));
        assert_eq!(report["daily"][0]["messageCount"], json!(42));
        assert_eq!(report["totals"]["totalTokens"], json!(1580));
    }

    #[test]
    fn calculates_cost_for_hermes_frontier_models_from_embedded_pricing() {
        let pricing = PricingMap::load_embedded();
        for model in ["gpt-5.5", "grok-4.3"] {
            let entry = HermesEntry {
                timestamp: crate::parse_ts_timestamp("2026-05-19T00:00:00.000Z").unwrap(),
                timestamp_text: "2026-05-19T00:00:00.000Z".to_string(),
                session_id: format!("session-{model}"),
                model: model.to_string(),
                provider: "hermes".to_string(),
                usage: TokenUsageRaw {
                    input_tokens: 1_000,
                    output_tokens: 100,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    speed: None,
                },
                reasoning_tokens: 50,
                message_count: 1,
                cost_usd: None,
            };

            assert!(
                calculate_hermes_cost(&entry, &pricing) > 0.0,
                "{model} should resolve to embedded pricing"
            );
        }
    }

    #[test]
    fn tries_provider_qualified_model_candidate_first() {
        let entry = HermesEntry {
            timestamp: crate::parse_ts_timestamp("2026-05-19T00:00:00.000Z").unwrap(),
            timestamp_text: "2026-05-19T00:00:00.000Z".to_string(),
            session_id: "session-provider".to_string(),
            model: "gpt-5.5".to_string(),
            provider: "openai".to_string(),
            usage: TokenUsageRaw::default(),
            reasoning_tokens: 0,
            message_count: 1,
            cost_usd: None,
        };

        assert_eq!(
            model_candidates(&entry),
            vec!["openai/gpt-5.5".to_string(), "gpt-5.5".to_string()]
        );
    }
}
