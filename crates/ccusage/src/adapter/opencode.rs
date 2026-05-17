use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    calculate_cost, cli::AgentCommandArgs, cli::AgentReportKind, cli::CostMode, cli::SharedArgs,
    cli::SortOrder, cli::WeekDay, collect_files_with_extension, debug_log,
    filter_loaded_entries_by_date, format_date_tz, json_value_u64, non_empty_json_string, parse_tz,
    print_json_or_jq, print_usage_table, sort_summaries, summarize_by_key,
    summarize_summaries_by_bucket, totals_json, wants_json, BucketKind, LoadedEntry, PricingMap,
    Result, TokenUsageRaw, UsageEntry, UsageMessage,
};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let mut entries = load_entries(&shared)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    if wants_json(&shared) {
        return print_json_or_jq(
            report_json(&entries, args.kind, &shared.order)?,
            shared.jq.as_deref(),
        );
    }
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, |row| summary_period(row));
    print_usage_table(
        "OpenCode Token Usage Report",
        first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn report_json(
    entries: &[LoadedEntry],
    kind: AgentReportKind,
    order: &SortOrder,
) -> Result<Value> {
    let mut rows = summarize_entries(entries, kind)?;
    sort_summaries(&mut rows, order, |row| summary_period(row));
    Ok(report_from_rows(&rows, kind))
}

fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = if kind == AgentReportKind::Session {
        rows.iter()
            .map(crate::session_summary_json)
            .collect::<Vec<_>>()
    } else {
        rows.iter().map(crate::summary_json).collect::<Vec<_>>()
    };
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
        AgentReportKind::Weekly => {
            let daily = summarize_by_key(
                entries,
                |entry| entry.date.clone(),
                |date| (date.to_string(), None),
            )?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Weekly,
                WeekDay::Monday,
            ))
        }
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

pub(crate) fn first_column(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "Date",
        AgentReportKind::Weekly => "Week",
        AgentReportKind::Monthly => "Month",
        AgentReportKind::Session => "Session",
    }
}

pub(crate) fn summary_period(row: &crate::UsageSummary) -> &str {
    row.date
        .as_deref()
        .or(row.week.as_deref())
        .or(row.month.as_deref())
        .or(row.session_id.as_deref())
        .unwrap_or_default()
}

pub(crate) fn load_entries(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for path in paths()? {
        for entry in load_entries_from_directory(&path, shared)? {
            if let Some(id) = entry_id(&entry) {
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
    if let Ok(env_paths) = env::var("OPENCODE_DATA_DIR") {
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

    let home = crate::home::home_dir()
        .ok_or_else(|| crate::cli_error("home directory is not set"))?;
    let path = home.join(".local/share/opencode");
    if path.is_dir() && seen.insert(path.clone()) {
        paths.push(path);
    }
    Ok(paths)
}

pub(crate) fn load_entries_from_directory(
    opencode_dir: &Path,
    shared: &SharedArgs,
) -> Result<Vec<LoadedEntry>> {
    let pricing = if shared.mode == CostMode::Display {
        None
    } else {
        Some(PricingMap::load(
            shared.offline,
            crate::log_level() != Some(0),
        ))
    };
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    if let Some(db_path) = db_path(opencode_dir) {
        for entry in
            load_entries_from_database(&db_path, tz.as_ref(), shared.mode, pricing.as_ref(), shared)
        {
            if let Some(id) = entry_id(&entry) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            entries.push(entry);
        }
    }

    let messages_dir = opencode_dir.join("storage").join("message");
    let mut files = Vec::new();
    collect_files_with_extension(&messages_dir, "json", &mut files);
    for file in files {
        if let Some(entry) = read_message_file(&file, tz.as_ref(), shared.mode, pricing.as_ref())? {
            if let Some(id) = entry_id(&entry) {
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

fn db_path(opencode_dir: &Path) -> Option<PathBuf> {
    let default_path = opencode_dir.join("opencode.db");
    if default_path.is_file() {
        return Some(default_path);
    }
    let mut candidates = fs::read_dir(opencode_dir)
        .ok()?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_channel_db_name)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

fn is_channel_db_name(name: &str) -> bool {
    name.starts_with("opencode-")
        && name.ends_with(".db")
        && name["opencode-".len()..name.len() - ".db".len()]
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn load_entries_from_database(
    db_path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
    shared: &SharedArgs,
) -> Vec<LoadedEntry> {
    let Ok(connection) =
        sqlite::Connection::open_with_flags(db_path, sqlite::OpenFlags::new().with_read_only())
    else {
        debug_log(
            shared,
            format!("Failed to open OpenCode database: {}", db_path.display()),
        );
        return Vec::new();
    };
    let Ok(mut statement) = connection.prepare("SELECT id, session_id, data FROM message") else {
        debug_log(
            shared,
            format!("Failed to read OpenCode database: {}", db_path.display()),
        );
        return Vec::new();
    };
    let mut entries = Vec::new();
    loop {
        match statement.next() {
            Ok(sqlite::State::Row) => {
                let Ok(id) = statement.read::<String, _>(0) else {
                    continue;
                };
                let Ok(session_id) = statement.read::<String, _>(1) else {
                    continue;
                };
                let Ok(data) = statement.read::<String, _>(2) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                if let Some(entry) =
                    message_value_to_entry(&value, Some(id), Some(session_id), tz, mode, pricing)
                {
                    entries.push(entry);
                }
            }
            Ok(sqlite::State::Done) => break,
            Err(_) => {
                debug_log(
                    shared,
                    format!("Failed to query OpenCode database: {}", db_path.display()),
                );
                break;
            }
        }
    }
    entries
}

fn read_message_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Result<Option<LoadedEntry>> {
    let content = fs::read_to_string(path)?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(None);
    };
    Ok(message_value_to_entry(
        &value, None, None, tz, mode, pricing,
    ))
}

pub(crate) fn message_value_to_entry(
    value: &Value,
    id: Option<String>,
    session_id: Option<String>,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Option<LoadedEntry> {
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
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_creation_input_tokens == 0
        && usage.cache_read_input_tokens == 0
    {
        return None;
    }
    let model = non_empty_json_string(value.get("modelID"))?;
    let _provider = non_empty_json_string(value.get("providerID"))?;
    let millis = value
        .get("time")
        .and_then(|time| time.get("created"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let timestamp = crate::TimestampMs::from_millis(millis);
    let timestamp_text = crate::format_rfc3339_millis(timestamp);
    let message_id = id.or_else(|| non_empty_json_string(value.get("id")));
    let session_id = session_id.or_else(|| non_empty_json_string(value.get("sessionID")));
    let data = UsageEntry {
        session_id: session_id.clone(),
        timestamp: timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(model.clone()),
            id: message_id,
        },
        cost_usd: value.get("cost").and_then(Value::as_f64),
        request_id: None,
        is_api_error_message: None,
    };
    let cost = calculate_cost(&data, mode, pricing);
    let loaded_session_id = data
        .session_id
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    Some(LoadedEntry {
        date: format_date_tz(timestamp, tz),
        timestamp,
        project: Arc::from("opencode"),
        session_id: Arc::from(loaded_session_id),
        project_path: Arc::from("OpenCode"),
        cost,
        credits: None,
        model: Some(model),
        usage_limit_reset_time: None,
        data,
    })
}

fn entry_id(entry: &LoadedEntry) -> Option<&str> {
    entry.data.message.id.as_deref().filter(|id| !id.is_empty())
}
