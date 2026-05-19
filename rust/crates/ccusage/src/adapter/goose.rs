use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, SharedArgs, WeekDay},
    filter_loaded_entries_by_date, format_date_tz, parse_tz, print_json_or_jq, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, totals_json, wants_json, BucketKind,
    LoadedEntry, PricingMap, Result, TokenUsageRaw, UsageEntry, UsageMessage, UsageSummary,
};

const GOOSE_PATH_ROOT_ENV: &str = "GOOSE_PATH_ROOT";
const GOOSE_DB_FILE_NAME: &str = "sessions.db";
const GOOSE_SESSION_QUERY: &str = r#"
SELECT
    id,
    model_config_json,
    provider_name,
    created_at,
    total_tokens,
    input_tokens,
    output_tokens,
    accumulated_total_tokens,
    accumulated_input_tokens,
    accumulated_output_tokens
FROM sessions
WHERE model_config_json IS NOT NULL
    AND TRIM(model_config_json) != ''
"#;

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
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Goose, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for db_path in goose_db_paths()? {
        for entry in load_entries_from_db(&db_path, tz.as_ref(), pricing, shared)? {
            let key = format!("{}:{}", db_path.display(), entry.session_id);
            if seen.insert(key) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn goose_db_paths() -> Result<Vec<PathBuf>> {
    let candidates = if let Ok(root) = env::var(GOOSE_PATH_ROOT_ENV) {
        let root = root.trim();
        if root.is_empty() {
            default_goose_db_candidates()?
        } else {
            vec![PathBuf::from(root)
                .join("data")
                .join("sessions")
                .join(GOOSE_DB_FILE_NAME)]
        }
    } else {
        default_goose_db_candidates()?
    };

    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for path in candidates {
        let path = path.canonicalize().unwrap_or(path);
        if path.is_file() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn default_goose_db_candidates() -> Result<Vec<PathBuf>> {
    let home =
        crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
    Ok(vec![
        home.join(".local/share/goose/sessions")
            .join(GOOSE_DB_FILE_NAME),
        home.join("Library/Application Support/goose/sessions")
            .join(GOOSE_DB_FILE_NAME),
        home.join(".local/share/Block/goose/sessions")
            .join(GOOSE_DB_FILE_NAME),
    ])
}

fn load_entries_from_db(
    db_path: &Path,
    tz: Option<&JiffTimeZone>,
    pricing: &PricingMap,
    shared: &SharedArgs,
) -> Result<Vec<LoadedEntry>> {
    let Ok(connection) =
        sqlite::Connection::open_with_flags(db_path, sqlite::OpenFlags::new().with_read_only())
    else {
        debug_log(
            shared,
            format!("Failed to open Goose database: {}", db_path.display()),
        );
        return Ok(Vec::new());
    };
    let Ok(mut statement) = connection.prepare(GOOSE_SESSION_QUERY) else {
        debug_log(
            shared,
            format!("Failed to read Goose database: {}", db_path.display()),
        );
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    loop {
        match statement.next() {
            Ok(sqlite::State::Row) => {
                if let Some(entry) = row_to_entry(&statement, tz, pricing) {
                    entries.push(entry);
                }
            }
            Ok(sqlite::State::Done) => break,
            Err(_) => {
                debug_log(
                    shared,
                    format!("Failed to query Goose database: {}", db_path.display()),
                );
                break;
            }
        }
    }
    Ok(entries)
}

fn row_to_entry(
    statement: &sqlite::Statement<'_>,
    tz: Option<&JiffTimeZone>,
    pricing: &PricingMap,
) -> Option<LoadedEntry> {
    let id = statement.read::<String, _>(0).ok()?;
    let model_config = statement.read::<String, _>(1).ok()?;
    let provider_name = statement.read::<String, _>(2).ok();
    let created_at = read_timestamp_value(statement, 3)?;
    let timestamp = parse_goose_timestamp(&created_at)?;
    let model = parse_goose_model_config(&model_config)?;

    let input_tokens = read_token_value(statement, 8)
        .or_else(|| read_token_value(statement, 5))
        .unwrap_or(0);
    let output_tokens = read_token_value(statement, 9)
        .or_else(|| read_token_value(statement, 6))
        .unwrap_or(0);
    let total_tokens = read_token_value(statement, 7)
        .or_else(|| read_token_value(statement, 4))
        .unwrap_or(input_tokens.saturating_add(output_tokens));
    if input_tokens == 0 && output_tokens == 0 && total_tokens == 0 {
        return None;
    }

    let reasoning_tokens = total_tokens.saturating_sub(input_tokens.saturating_add(output_tokens));
    let provider_id = normalize_provider(provider_name.as_deref(), &model);
    let usage = TokenUsageRaw {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        speed: None,
    };
    let timestamp_text = crate::format_rfc3339_millis(timestamp);
    let data = UsageEntry {
        session_id: Some(id.clone()),
        timestamp: timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(model.clone()),
            id: Some(id.clone()),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    let cost = calculate_goose_cost(&model, &provider_id, usage, reasoning_tokens, pricing);

    Some(LoadedEntry {
        date: format_date_tz(timestamp, tz),
        timestamp,
        project: Arc::from("goose"),
        session_id: Arc::from(id.as_str()),
        project_path: Arc::from("Goose"),
        cost,
        credits: None,
        model: Some(model),
        usage_limit_reset_time: None,
        extra_total_tokens: reasoning_tokens,
        data,
    })
}

fn read_token_value(statement: &sqlite::Statement<'_>, index: usize) -> Option<u64> {
    statement
        .read::<i64, _>(index)
        .ok()
        .filter(|value| *value > 0)
        .map(|value| value as u64)
}

fn read_timestamp_value(statement: &sqlite::Statement<'_>, index: usize) -> Option<String> {
    statement.read::<String, _>(index).ok().or_else(|| {
        statement
            .read::<i64, _>(index)
            .ok()
            .map(|value| value.to_string())
    })
}

fn parse_goose_model_config(value: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(value).ok()?;
    let model = value.get("model_name")?.as_str()?.trim();
    (!model.is_empty()).then(|| model.to_string())
}

fn parse_goose_timestamp(value: &str) -> Option<crate::TimestampMs> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(number) = trimmed.parse::<i64>() {
        let millis = if number > 1_000_000_000_000 {
            number
        } else {
            number.checked_mul(1_000)?
        };
        return (millis > 0).then(|| crate::TimestampMs::from_millis(millis));
    }
    if let Some(timestamp) = crate::parse_ts_timestamp(trimmed) {
        return Some(timestamp);
    }
    if trimmed.len() == 19
        && trimmed.as_bytes().get(4) == Some(&b'-')
        && trimmed.as_bytes().get(7) == Some(&b'-')
        && (trimmed.as_bytes().get(10) == Some(&b' ') || trimmed.as_bytes().get(10) == Some(&b'T'))
    {
        let normalized = format!("{}T{}Z", &trimmed[..10], &trimmed[11..]);
        return crate::parse_ts_timestamp(&normalized);
    }
    if trimmed.len() == 10
        && trimmed.as_bytes().get(4) == Some(&b'-')
        && trimmed.as_bytes().get(7) == Some(&b'-')
    {
        return crate::parse_ts_timestamp(&format!("{trimmed}T00:00:00Z"));
    }
    None
}

fn normalize_provider(provider: Option<&str>, model: &str) -> String {
    let provider = provider
        .map(str::trim)
        .filter(|provider| !provider.is_empty());
    if let Some(provider) = provider {
        return provider.replace('-', "_");
    }
    if model.starts_with("claude-") {
        return "anthropic".to_string();
    }
    if model.starts_with("gpt-") || model.starts_with("chatgpt-") || model.starts_with('o') {
        return "openai".to_string();
    }
    if model.starts_with("gemini-") {
        return "google".to_string();
    }
    if model.to_ascii_lowercase().starts_with("qwen") {
        return "openrouter".to_string();
    }
    "goose".to_string()
}

fn calculate_goose_cost(
    model: &str,
    provider_id: &str,
    usage: TokenUsageRaw,
    reasoning_tokens: u64,
    pricing: &PricingMap,
) -> f64 {
    let cost_usage = TokenUsageRaw {
        output_tokens: usage.output_tokens.saturating_add(reasoning_tokens),
        ..usage
    };
    let raw = calculate_cost_for_usage(
        Some(model),
        cost_usage,
        None,
        CostMode::Calculate,
        Some(pricing),
    );
    if raw > 0.0 || provider_id == "goose" {
        return raw;
    }
    let candidate = format!("{provider_id}/{model}");
    calculate_cost_for_usage(
        Some(&candidate),
        cost_usage,
        None,
        CostMode::Calculate,
        Some(pricing),
    )
}

fn debug_log(shared: &SharedArgs, message: String) {
    if shared.debug {
        eprintln!("DEBUG {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("ccusage-goose-{name}-{nanos}"))
    }

    fn create_goose_db(path: &Path) {
        let db = sqlite::open(path).unwrap();
        db.execute(
            r#"
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    model_config_json TEXT,
    provider_name TEXT,
    created_at TEXT,
    total_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    accumulated_total_tokens INTEGER,
    accumulated_input_tokens INTEGER,
    accumulated_output_tokens INTEGER
)
"#,
        )
        .unwrap();
    }

    struct SessionFixture<'a> {
        id: &'a str,
        model_config: &'a str,
        provider: Option<&'a str>,
        created_at: &'a str,
        total: i64,
        input: i64,
        output: i64,
    }

    fn insert_session(path: &Path, fixture: SessionFixture<'_>) {
        let db = sqlite::open(path).unwrap();
        let mut statement = db
            .prepare(
                r#"
INSERT INTO sessions (
    id,
    model_config_json,
    provider_name,
    created_at,
    accumulated_total_tokens,
    accumulated_input_tokens,
    accumulated_output_tokens
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
"#,
            )
            .unwrap();
        statement.bind((1, fixture.id)).unwrap();
        statement.bind((2, fixture.model_config)).unwrap();
        statement.bind((3, fixture.provider)).unwrap();
        statement.bind((4, fixture.created_at)).unwrap();
        statement.bind((5, fixture.total)).unwrap();
        statement.bind((6, fixture.input)).unwrap();
        statement.bind((7, fixture.output)).unwrap();
        statement.next().unwrap();
    }

    #[test]
    fn loads_accumulated_tokens_from_goose_sqlite() {
        let dir = temp_dir("sqlite");
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join(GOOSE_DB_FILE_NAME);
        create_goose_db(&db_path);
        insert_session(
            &db_path,
            SessionFixture {
                id: "session-a",
                model_config: r#"{"model_name":"claude-sonnet-4-20250514"}"#,
                provider: Some("anthropic"),
                created_at: "2026-05-01 01:02:03",
                total: 180,
                input: 100,
                output: 50,
            },
        );

        let pricing = PricingMap::load_embedded();
        let entries = load_entries_from_db(
            &db_path,
            Some(&jiff::tz::TimeZone::UTC),
            &pricing,
            &SharedArgs::default(),
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-05-01");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(entries[0].extra_total_tokens, 30);
    }

    #[test]
    fn includes_goose_reasoning_remainder_in_report_total() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("session-a".to_string()),
                timestamp: "2026-05-01T01:02:03.000Z".to_string(),
                version: None,
                message: UsageMessage {
                    usage: TokenUsageRaw {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                        speed: None,
                    },
                    model: Some("claude-sonnet-4-20250514".to_string()),
                    id: Some("session-a".to_string()),
                },
                cost_usd: None,
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: crate::parse_ts_timestamp("2026-05-01T01:02:03.000Z").unwrap(),
            date: "2026-05-01".to_string(),
            project: Arc::from("goose"),
            session_id: Arc::from("session-a"),
            project_path: Arc::from("Goose"),
            cost: 0.02,
            credits: None,
            model: Some("claude-sonnet-4-20250514".to_string()),
            usage_limit_reset_time: None,
            extra_total_tokens: 30,
        };
        let rows = summarize_entries(&[entry], AgentReportKind::Daily).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["inputTokens"], 100);
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["totalTokens"], 180);
    }

    #[test]
    fn discovers_goose_path_root_database() {
        let dir = temp_dir("path-root");
        let db_dir = dir.join("data/sessions");
        fs::create_dir_all(&db_dir).unwrap();
        let db_path = db_dir.join(GOOSE_DB_FILE_NAME);
        fs::write(&db_path, "").unwrap();
        env::set_var(GOOSE_PATH_ROOT_ENV, &dir);

        let paths = goose_db_paths().unwrap();
        env::remove_var(GOOSE_PATH_ROOT_ENV);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with(Path::new("data/sessions/sessions.db")));
    }
}
