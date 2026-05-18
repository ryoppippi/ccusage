use std::{
    collections::HashSet,
    env, fmt, fs, io,
    path::{Path, PathBuf},
    thread,
};

use serde_json::{json, Value};

mod adapter;
mod blocks;
mod claude_loader;
mod cli;
mod commands;
mod config;
mod cost;
mod date_utils;
mod home;
mod output;
mod pricing;
mod progress;
mod project_names;
mod summary;
mod table;
mod types;

pub(crate) use blocks::{
    block_json, calculate_burn_rate, filter_blocks_by_date, format_context, format_remaining_time,
    identify_session_blocks, print_active_block_detail, print_blocks_table, sort_blocks,
};
pub(crate) use claude_loader::{
    chunk_file_indexes_by_size, collect_files_with_extension, collect_usage_files,
    filter_loaded_entries_by_date, load_entries,
};
pub(crate) use cost::{calculate_cost, tiered_cost};
pub(crate) use date_utils::*;
pub(crate) use output::{
    format_currency, format_models_multiline, format_number, group_project_output, json_float,
    print_json_or_jq, print_usage_table, session_summary_json, summary_json, totals_json,
    wants_json,
};
pub(crate) use project_names::{format_project_name, parse_project_aliases, short_model_name};
pub(crate) use summary::{
    filter_and_sort_summaries, sort_summaries, summarize_by_key, summarize_summaries_by_bucket,
    week_start, BucketKind, SessionAccumulator,
};
pub(crate) use table::{color, print_box_title, terminal_width, Align, Color, SimpleTable};
pub(crate) use types::*;

use cli::{
    AgentCommandArgs, AgentReportKind, Cli, Command, CostMode, SharedArgs, SortOrder, WeekDay,
};
use pricing::PricingMap;

const DEFAULT_SESSION_DURATION_HOURS: f64 = 5.0;
const DEFAULT_RECENT_DAYS: i64 = 3;
const BLOCKS_WARNING_THRESHOLD: f64 = 0.8;
const DEFAULT_TERMINAL_WIDTH: usize = 120;
const USAGE_COMPACT_WIDTH_THRESHOLD: usize = 100;
const BLOCKS_COMPACT_WIDTH_THRESHOLD: usize = 120;

type Result<T> = std::result::Result<T, CliError>;

#[derive(Debug)]
struct CliError(String);

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<io::Error> for CliError {
    fn from(error: io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for CliError {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

fn cli_error(message: impl Into<String>) -> CliError {
    CliError(message.into())
}

trait Context<T> {
    fn context(self, message: impl Into<String>) -> Result<T>;
}

impl<T, E> Context<T> for std::result::Result<T, E>
where
    E: fmt::Display,
{
    fn context(self, message: impl Into<String>) -> Result<T> {
        self.map_err(|error| cli_error(format!("{}: {error}", message.into())))
    }
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::All(args)) => adapter::all::run(args),
        Some(Command::Daily(args)) => commands::run_daily(args),
        Some(Command::Monthly(shared)) => commands::run_bucket(shared, BucketKind::Monthly),
        Some(Command::Weekly(args)) => commands::run_weekly(args),
        Some(Command::Session(args)) => commands::run_session(args),
        Some(Command::Blocks(args)) => commands::run_blocks(args),
        Some(Command::Statusline(args)) => commands::run_statusline(args),
        Some(Command::Codex(args)) => adapter::codex::run(args),
        Some(Command::OpenCode(args)) => adapter::opencode::run(args),
        Some(Command::Amp(args)) => adapter::amp::run(args),
        Some(Command::Pi(args)) => adapter::pi::run(args),
        None => {
            let args = AgentCommandArgs {
                shared: cli.shared,
                kind: AgentReportKind::Daily,
                pi_path: None,
                codex_speed: cli::CodexSpeed::Auto,
            };
            adapter::all::run(args)
        }
    }
}

fn json_value_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or_default()
}

fn debug_log(shared: &SharedArgs, message: impl AsRef<str>) {
    if shared.debug {
        eprintln!("{}", message.as_ref());
    }
}

fn load_codex_events_from_directory(
    sessions_dir: &Path,
    single_thread: bool,
) -> Result<Vec<CodexTokenUsageEvent>> {
    let mut files = Vec::new();
    collect_usage_files(sessions_dir, &mut files);
    let mut events = if single_thread {
        files
            .iter()
            .flat_map(|file| read_codex_session_file(sessions_dir, file))
            .collect::<Vec<_>>()
    } else {
        read_codex_session_files_parallel(sessions_dir, &files)
    };
    dedupe_codex_events(&mut events);
    Ok(events)
}

fn load_codex_events(shared: &SharedArgs) -> Result<Vec<CodexTokenUsageEvent>> {
    progress::track_usage_load(progress::UsageLoadAgent::Codex, shared.json, || {
        load_codex_events_inner(shared)
    })
}

fn load_codex_events_inner(shared: &SharedArgs) -> Result<Vec<CodexTokenUsageEvent>> {
    let mut events = Vec::new();
    for path in codex_sessions_paths()? {
        events.extend(load_codex_events_from_directory(
            &path,
            shared.single_thread,
        )?);
    }
    dedupe_codex_events(&mut events);
    Ok(events)
}

fn read_codex_session_files_parallel(
    sessions_dir: &Path,
    files: &[PathBuf],
) -> Vec<CodexTokenUsageEvent> {
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(files.len());
    if worker_count <= 1 {
        return files
            .iter()
            .flat_map(|file| read_codex_session_file(sessions_dir, file))
            .collect();
    }

    let chunks = chunk_file_indexes_by_size(files, worker_count);
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            handles.push(scope.spawn(move || {
                chunk
                    .into_iter()
                    .map(|index| (index, read_codex_session_file(sessions_dir, &files[index])))
                    .collect::<Vec<_>>()
            }));
        }

        let mut loaded_files = Vec::with_capacity(files.len());
        loaded_files.resize_with(files.len(), || None);
        for (index, events) in handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("codex worker panicked"))
        {
            loaded_files[index] = Some(events);
        }
        loaded_files
            .into_iter()
            .flatten()
            .flatten()
            .collect::<Vec<_>>()
    })
}

fn codex_sessions_paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var("CODEX_HOME") {
        for raw in env_paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            let path = PathBuf::from(raw).join("sessions");
            if seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        return Ok(paths);
    }

    let home = home::home_dir().ok_or_else(|| cli_error("home directory is not set"))?;
    let path = home.join(".codex").join("sessions");
    if seen.insert(path.clone()) {
        paths.push(path);
    }
    Ok(paths)
}

fn read_codex_session_file(sessions_dir: &Path, path: &Path) -> Vec<CodexTokenUsageEvent> {
    let mut events = Vec::new();
    let _ = visit_codex_session_file(sessions_dir, path, |event| {
        events.push(event);
        Ok(())
    });
    events
}

fn visit_codex_session_file(
    sessions_dir: &Path,
    path: &Path,
    mut visit: impl FnMut(CodexTokenUsageEvent) -> Result<()>,
) -> Result<()> {
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(());
    };
    let session_id = codex_session_id(sessions_dir, path);
    let mut previous_totals: Option<CodexRawUsage> = None;
    let mut current_model: Option<String> = None;
    let mut current_model_is_fallback = false;

    for line in content.lines() {
        if !line.contains("turn_context") && !line.contains("token_count") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(entry_type) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        if entry_type == "turn_context" {
            if let Some(model) = codex_model_from_payload(value.get("payload")) {
                current_model = Some(model);
                current_model_is_fallback = false;
            }
            continue;
        }
        if entry_type != "event_msg" {
            continue;
        }
        let Some(timestamp) = value.get("timestamp").and_then(Value::as_str) else {
            continue;
        };
        let Some(payload) = value.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(Value::as_str) != Some("token_count") {
            continue;
        }
        let info = payload.get("info");
        let total_usage = info.and_then(|info| {
            info.get("total_token_usage")
                .and_then(normalize_codex_raw_usage)
        });
        let raw_usage = info
            .and_then(|info| {
                info.get("last_token_usage")
                    .and_then(normalize_codex_raw_usage)
            })
            .or_else(|| {
                total_usage
                    .as_ref()
                    .map(|usage| subtract_codex_raw_usage(usage, previous_totals.as_ref()))
            });
        if let Some(total_usage) = total_usage {
            previous_totals = Some(total_usage);
        }
        let Some(raw_usage) = raw_usage else {
            continue;
        };
        if raw_usage.input_tokens == 0
            && raw_usage.cached_input_tokens == 0
            && raw_usage.output_tokens == 0
            && raw_usage.reasoning_output_tokens == 0
        {
            continue;
        }

        let parsed_model = codex_model_from_payload(Some(payload))
            .or_else(|| info.and_then(|info| codex_model_from_payload(Some(info))));
        if let Some(model) = parsed_model.clone() {
            current_model = Some(model);
            current_model_is_fallback = false;
        }
        let mut is_fallback_model = false;
        let model = parsed_model.or_else(|| current_model.clone()).or_else(|| {
            is_fallback_model = true;
            current_model_is_fallback = true;
            current_model = Some("gpt-5".to_string());
            current_model.clone()
        });
        if parsed_model_is_missing(&model, &current_model, current_model_is_fallback) {
            is_fallback_model = true;
        }

        visit(CodexTokenUsageEvent {
            session_id: session_id.clone(),
            timestamp: timestamp.to_string(),
            model,
            input_tokens: raw_usage.input_tokens,
            cached_input_tokens: raw_usage.cached_input_tokens.min(raw_usage.input_tokens),
            output_tokens: raw_usage.output_tokens,
            reasoning_output_tokens: raw_usage.reasoning_output_tokens,
            total_tokens: raw_usage.total_tokens,
            is_fallback_model,
        })?;
    }

    Ok(())
}

fn parsed_model_is_missing(
    model: &Option<String>,
    current_model: &Option<String>,
    current_model_is_fallback: bool,
) -> bool {
    model.is_some() && current_model.is_some() && current_model_is_fallback
}

fn codex_session_id(sessions_dir: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(sessions_dir).unwrap_or(path);
    let mut session_id = relative
        .with_extension("")
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/");
    if session_id.is_empty() {
        session_id = "unknown".to_string();
    }
    session_id
}

fn codex_model_from_payload(value: Option<&Value>) -> Option<String> {
    let value = value?;
    ["model", "model_name"]
        .into_iter()
        .find_map(|key| non_empty_json_string(value.get(key)))
        .or_else(|| {
            value
                .get("metadata")
                .and_then(|metadata| non_empty_json_string(metadata.get("model")))
        })
}

fn non_empty_json_string(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_codex_raw_usage(value: &Value) -> Option<CodexRawUsage> {
    if !value.is_object() {
        return None;
    }
    let input = json_u64(value.get("input_tokens"));
    let cached = json_u64(value.get("cached_input_tokens"))
        .or_else(|| json_u64(value.get("cache_read_input_tokens")))
        .unwrap_or(0);
    let output = json_u64(value.get("output_tokens"));
    let reasoning = json_u64(value.get("reasoning_output_tokens"));
    let total = json_u64(value.get("total_tokens"));
    let input = input.unwrap_or(0);
    let output = output.unwrap_or(0);
    let reasoning = reasoning.unwrap_or(0);
    Some(CodexRawUsage {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: reasoning,
        total_tokens: total.unwrap_or(input + output + reasoning),
    })
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    match value {
        Some(Value::Number(number)) => number.as_u64(),
        _ => None,
    }
}

fn subtract_codex_raw_usage(
    current: &CodexRawUsage,
    previous: Option<&CodexRawUsage>,
) -> CodexRawUsage {
    CodexRawUsage {
        input_tokens: current
            .input_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.input_tokens)),
        cached_input_tokens: current
            .cached_input_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.cached_input_tokens)),
        output_tokens: current
            .output_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.output_tokens)),
        reasoning_output_tokens: current
            .reasoning_output_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.reasoning_output_tokens)),
        total_tokens: current
            .total_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.total_tokens)),
    }
}

fn dedupe_codex_events(events: &mut Vec<CodexTokenUsageEvent>) {
    let mut seen = HashSet::new();
    events.retain(|event| {
        seen.insert((
            event.timestamp.clone(),
            event.model.clone(),
            event.input_tokens,
            event.cached_input_tokens,
            event.output_tokens,
            event.reasoning_output_tokens,
            event.total_tokens,
        ))
    });
}

fn log_level() -> Option<u8> {
    env::var("LOG_LEVEL")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
}

fn total_usage_tokens(usage: TokenUsageRaw) -> u64 {
    usage.input_tokens
        + usage.output_tokens
        + usage.cache_creation_input_tokens
        + usage.cache_read_input_tokens
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Arc};

    use super::*;

    fn temp_claude_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-{name}-{nanos}"));
        path
    }

    fn create_opencode_db_message(path: &Path, id: &str, session_id: &str, data: &str) {
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
    fn formats_numbers_with_commas() {
        assert_eq!(format_number(1_234_567), "1,234,567");
    }

    #[test]
    fn calculates_tiered_cost() {
        assert!((tiered_cost(300_000, 3e-6, Some(6e-6)) - 1.2).abs() < f64::EPSILON);
    }

    #[test]
    fn formats_windows_user_project_paths_like_typescript() {
        let aliases = HashMap::new();

        assert_eq!(
            format_project_name(r"C:\Users\phaedrus\Development\ccusage", &aliases),
            "ccusage"
        );
        assert_eq!(
            format_project_name(r"\Users\phaedrus\Development\ccusage", &aliases),
            "ccusage"
        );
    }

    #[test]
    fn gets_week_start() {
        assert_eq!(
            week_start("2024-01-03", WeekDay::Sunday).unwrap(),
            "2023-12-31"
        );
        assert_eq!(
            week_start("2024-01-03", WeekDay::Monday).unwrap(),
            "2024-01-01"
        );
    }

    #[test]
    fn balances_file_chunks_by_size() {
        let dir = temp_claude_dir("chunks");
        fs::create_dir_all(&dir).unwrap();
        let files = [
            ("large-a.jsonl", 100),
            ("small-a.jsonl", 1),
            ("small-b.jsonl", 1),
            ("large-b.jsonl", 100),
        ]
        .into_iter()
        .map(|(name, size)| {
            let path = dir.join(name);
            fs::write(&path, "x".repeat(size)).unwrap();
            path
        })
        .collect::<Vec<_>>();

        let chunks = chunk_file_indexes_by_size(&files, 2);
        assert_eq!(chunks.len(), 2);
        let mut indexes = chunks.iter().flatten().copied().collect::<Vec<_>>();
        indexes.sort_unstable();
        assert_eq!(indexes, vec![0, 1, 2, 3]);

        let chunk_sizes = chunks
            .iter()
            .map(|chunk| {
                chunk
                    .iter()
                    .map(|index| fs::metadata(&files[*index]).unwrap().len())
                    .sum::<u64>()
            })
            .collect::<Vec<_>>();
        assert_eq!(chunk_sizes, vec![101, 101]);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn formats_dates_with_timezone() {
        let timestamp = parse_ts_timestamp("2024-08-04T23:30:00.000Z").unwrap();

        assert_eq!(format_date(timestamp, Some("UTC")), "2024-08-04");
        assert_eq!(format_date(timestamp, Some("Asia/Tokyo")), "2024-08-05");
        assert_eq!(format_utc_minute(timestamp), "2024-08-04 23:30");
        assert_eq!(format_utc_second(timestamp), "2024-08-04 23:30:00");
        assert_eq!(format_rfc3339_millis(timestamp), "2024-08-04T23:30:00.000Z");
    }

    #[test]
    fn parses_timestamp_offsets() {
        assert_eq!(
            parse_ts_timestamp("2024-08-05T08:30:00.000+09:00").unwrap(),
            parse_ts_timestamp("2024-08-04T23:30:00.000Z").unwrap()
        );
        assert_eq!(
            parse_ts_timestamp("2024-08-04T16:30:00-07:00").unwrap(),
            parse_ts_timestamp("2024-08-04T23:30:00Z").unwrap()
        );
    }

    #[test]
    fn extracts_compact_jsonl_timestamp() {
        let timestamp = claude_loader::timestamp_from_line(
            r#"{"timestamp":"2026-05-11T12:34:56.789Z","message":{}}"#,
        )
        .unwrap();

        assert_eq!(format_rfc3339_millis(timestamp), "2026-05-11T12:34:56.789Z");
        assert!(
            claude_loader::timestamp_from_line(r#"{"timestamp": "2026-05-11T12:34:56.789Z"}"#)
                .is_none()
        );
    }

    #[test]
    fn keeps_most_complete_duplicate_usage_entry() {
        let claude_dir = temp_claude_dir("dedupe");
        let session_dir = claude_dir.join("projects/project1/session1");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("chat.jsonl"),
            [
                r#"{"timestamp":"2025-01-10T10:00:00.000Z","message":{"id":"msg_123","model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":25,"cache_creation_input_tokens":10,"cache_read_input_tokens":5}},"requestId":"req_456","costUSD":0.001}"#,
                r#"{"timestamp":"2025-01-10T10:00:01.000Z","message":{"id":"msg_123","model":"claude-opus-4-6","usage":{"input_tokens":100,"output_tokens":250,"cache_creation_input_tokens":10,"cache_read_input_tokens":5,"speed":"standard"}},"requestId":"req_456","costUSD":0.01}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let previous = env::var("CLAUDE_CONFIG_DIR").ok();
        env::set_var("CLAUDE_CONFIG_DIR", &claude_dir);
        let shared = SharedArgs {
            mode: CostMode::Display,
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, None).unwrap();
        if let Some(previous) = previous {
            env::set_var("CLAUDE_CONFIG_DIR", previous);
        } else {
            env::remove_var("CLAUDE_CONFIG_DIR");
        }
        fs::remove_dir_all(&claude_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 250);
        assert_eq!(entries[0].cost, 0.01);
    }

    #[test]
    fn loads_codex_token_count_events() {
        let codex_dir = temp_claude_dir("codex");
        let sessions_dir = codex_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("codex-session.jsonl"),
            [
                r#"{"timestamp":"2026-01-02T00:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5"}}"#,
                r#"{"timestamp":"2026-01-02T00:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"reasoning_output_tokens":0,"total_tokens":150},"model":"gpt-5"}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&sessions_dir, true).unwrap();
        fs::remove_dir_all(&codex_dir).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "codex-session");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(events[0].input_tokens, 100);
        assert_eq!(events[0].cached_input_tokens, 10);
        assert_eq!(events[0].output_tokens, 50);
        assert_eq!(events[0].reasoning_output_tokens, 0);
        assert_eq!(events[0].total_tokens, 150);
    }

    #[test]
    fn loads_codex_token_count_events_in_parallel() {
        let codex_dir = temp_claude_dir("codex-parallel");
        let sessions_dir = codex_dir.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("session-a.jsonl"),
            [
                r#"{"timestamp":"2026-01-02T00:00:00.000Z","type":"turn_context","payload":{"model":"gpt-5"}}"#,
                r#"{"timestamp":"2026-01-02T00:00:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"reasoning_output_tokens":0,"total_tokens":150},"model":"gpt-5"}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(
            sessions_dir.join("session-b.jsonl"),
            [
                r#"{"timestamp":"2026-01-02T00:01:00.000Z","type":"turn_context","payload":{"model":"gpt-5-mini"}}"#,
                r#"{"timestamp":"2026-01-02T00:01:01.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":40,"cached_input_tokens":4,"output_tokens":20,"reasoning_output_tokens":2,"total_tokens":62},"model":"gpt-5-mini"}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let single_thread_events = load_codex_events_from_directory(&sessions_dir, true).unwrap();
        let parallel_events = load_codex_events_from_directory(&sessions_dir, false).unwrap();
        fs::remove_dir_all(&codex_dir).unwrap();

        assert_eq!(parallel_events.len(), 2);
        assert_eq!(parallel_events, single_thread_events);
        assert_eq!(parallel_events[0].session_id, "session-a");
        assert_eq!(parallel_events[1].session_id, "session-b");
    }

    #[test]
    fn builds_codex_daily_json_report() {
        let pricing = PricingMap::load_embedded();
        let events = vec![CodexTokenUsageEvent {
            session_id: "codex-session".to_string(),
            timestamp: "2026-01-02T00:00:01.000Z".to_string(),
            model: Some("gpt-5".to_string()),
            input_tokens: 100,
            cached_input_tokens: 10,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 150,
            is_fallback_model: false,
        }];

        let report = adapter::codex::report_json(
            &events,
            AgentReportKind::Daily,
            None,
            &pricing,
            cli::CodexSpeed::Standard,
        )
        .unwrap();

        assert_eq!(report["daily"][0]["date"], "2026-01-02");
        assert_eq!(report["daily"][0]["inputTokens"], 100);
        assert_eq!(report["daily"][0]["cachedInputTokens"], 10);
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["reasoningOutputTokens"], 0);
        assert_eq!(report["daily"][0]["totalTokens"], 150);
        assert_eq!(report["daily"][0]["costUSD"], json!(0.00061375));
        assert_eq!(report["totals"]["costUSD"], json!(0.00061375));
    }

    #[test]
    fn prices_codex_versioned_models_like_typescript_adapter() {
        let pricing = PricingMap::load_embedded();
        let events = vec![CodexTokenUsageEvent {
            session_id: "codex-session".to_string(),
            timestamp: "2026-01-02T00:00:01.000Z".to_string(),
            model: Some("gpt-5.3-codex".to_string()),
            input_tokens: 120,
            cached_input_tokens: 30,
            output_tokens: 11,
            reasoning_output_tokens: 3,
            total_tokens: 131,
            is_fallback_model: false,
        }];

        let report = adapter::codex::report_json(
            &events,
            AgentReportKind::Daily,
            None,
            &pricing,
            cli::CodexSpeed::Standard,
        )
        .unwrap();

        assert_eq!(report["daily"][0]["costUSD"], json!(0.00031675));
    }

    #[test]
    fn applies_codex_fast_speed_multiplier_to_costs() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-test": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000002,
                    "cache_read_input_token_cost": 0.0000005,
                    "provider_specific_entry": { "fast": 2 }
                }
            }"#,
        );
        let events = vec![CodexTokenUsageEvent {
            session_id: "codex-session".to_string(),
            timestamp: "2026-01-02T00:00:01.000Z".to_string(),
            model: Some("gpt-test".to_string()),
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 15,
            is_fallback_model: false,
        }];

        let standard = adapter::codex::report_json(
            &events,
            AgentReportKind::Daily,
            None,
            &pricing,
            cli::CodexSpeed::Standard,
        )
        .unwrap();
        let fast = adapter::codex::report_json(
            &events,
            AgentReportKind::Daily,
            None,
            &pricing,
            cli::CodexSpeed::Fast,
        )
        .unwrap();

        assert_eq!(standard["daily"][0]["costUSD"], json!(0.000019));
        assert_eq!(fast["daily"][0]["costUSD"], json!(0.000038));
    }

    #[test]
    fn loads_opencode_message_json_files() {
        let opencode_dir = temp_claude_dir("opencode");
        let messages_dir = opencode_dir.join("storage/message");
        fs::create_dir_all(&messages_dir).unwrap();
        fs::write(
            messages_dir.join("message.json"),
            r#"{"id":"msg-1","sessionID":"session-a","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":100,"output":50,"cache":{"read":10,"write":20}},"cost":0.02}"#,
        )
        .unwrap();

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries =
            adapter::opencode::load_entries_from_directory(&opencode_dir, &shared).unwrap();
        fs::remove_dir_all(&opencode_dir).unwrap();

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
        assert_eq!(entries[0].cost, 0.02);
    }

    #[test]
    fn loads_opencode_messages_from_sqlite_database() {
        let opencode_dir = temp_claude_dir("opencode-db");
        fs::create_dir_all(&opencode_dir).unwrap();
        create_opencode_db_message(
            &opencode_dir.join("opencode.db"),
            "db-msg-1",
            "db-session-a",
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":120,"output":60,"cache":{"read":12,"write":24}},"cost":0.03}"#,
        );

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries =
            adapter::opencode::load_entries_from_directory(&opencode_dir, &shared).unwrap();
        fs::remove_dir_all(&opencode_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-02");
        assert_eq!(entries[0].session_id.as_ref(), "db-session-a");
        assert_eq!(entries[0].data.message.id.as_deref(), Some("db-msg-1"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 120);
        assert_eq!(entries[0].data.message.usage.output_tokens, 60);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            24
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 12);
        assert_eq!(entries[0].cost, 0.03);
    }

    #[test]
    fn loads_opencode_channel_sqlite_database() {
        let opencode_dir = temp_claude_dir("opencode-channel-db");
        fs::create_dir_all(&opencode_dir).unwrap();
        create_opencode_db_message(
            &opencode_dir.join("opencode-beta.db"),
            "channel-msg-1",
            "channel-session-a",
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":80,"output":40}}"#,
        );

        let entries =
            adapter::opencode::load_entries_from_directory(&opencode_dir, &SharedArgs::default())
                .unwrap();
        fs::remove_dir_all(&opencode_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "channel-session-a");
        assert_eq!(entries[0].data.message.usage.input_tokens, 80);
    }

    #[test]
    fn prefers_opencode_database_messages_over_duplicate_json_files() {
        let opencode_dir = temp_claude_dir("opencode-dedupe");
        let messages_dir = opencode_dir.join("storage/message");
        fs::create_dir_all(&messages_dir).unwrap();
        create_opencode_db_message(
            &opencode_dir.join("opencode.db"),
            "msg-1",
            "db-session-a",
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":120,"output":60},"cost":0.03}"#,
        );
        fs::write(
			messages_dir.join("message.json"),
			r#"{"id":"msg-1","sessionID":"json-session-a","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":999,"output":999},"cost":0.99}"#,
		)
		.unwrap();

        let shared = SharedArgs {
            mode: CostMode::Display,
            ..SharedArgs::default()
        };
        let entries =
            adapter::opencode::load_entries_from_directory(&opencode_dir, &shared).unwrap();
        fs::remove_dir_all(&opencode_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "db-session-a");
        assert_eq!(entries[0].data.message.usage.input_tokens, 120);
        assert_eq!(entries[0].cost, 0.03);
    }

    #[test]
    fn loads_amp_thread_usage_events() {
        let amp_dir = temp_claude_dir("amp");
        let threads_dir = amp_dir.join("threads");
        fs::create_dir_all(&threads_dir).unwrap();
        fs::write(
            threads_dir.join("thread.json"),
            r#"{"id":"thread-a","messages":[{"role":"assistant","messageId":2,"usage":{"cacheCreationInputTokens":20,"cacheReadInputTokens":10}}],"usageLedger":{"events":[{"id":"event-a","timestamp":"2026-05-01T01:02:03.000Z","model":"claude-sonnet-4-20250514","credits":1.25,"tokens":{"input":100,"output":50},"toMessageId":2}]}}"#,
        )
        .unwrap();

        let entries = adapter::amp::read_thread_file(
            &threads_dir.join("thread.json"),
            parse_tz(Some("UTC")).as_ref(),
            CostMode::Display,
            None,
        )
        .unwrap();
        fs::remove_dir_all(&amp_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-05-01");
        assert_eq!(entries[0].session_id.as_ref(), "thread-a");
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
        assert_eq!(entries[0].credits, Some(1.25));
    }

    #[test]
    fn builds_amp_daily_json_report() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("thread-a".to_string()),
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
                    model: Some("claude-sonnet-4-20250514".to_string()),
                    id: Some("event-a".to_string()),
                },
                cost_usd: None,
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: parse_ts_timestamp("2026-05-01T01:02:03.000Z").unwrap(),
            date: "2026-05-01".to_string(),
            project: Arc::from("amp"),
            session_id: Arc::from("thread-a"),
            project_path: Arc::from("Amp"),
            cost: 0.02,
            credits: Some(1.25),
            model: Some("claude-sonnet-4-20250514".to_string()),
            usage_limit_reset_time: None,
        };

        let rows = adapter::amp::summarize_entries(&[entry], AgentReportKind::Daily).unwrap();
        let report = adapter::amp::report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["date"], "2026-05-01");
        assert_eq!(report["daily"][0]["inputTokens"], 100);
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["cacheCreationTokens"], 20);
        assert_eq!(report["daily"][0]["cacheReadTokens"], 10);
        assert_eq!(report["daily"][0]["totalTokens"], 180);
        assert_eq!(report["daily"][0]["credits"], json!(1.25));
        assert_eq!(report["daily"][0]["totalCost"], json!(0.02));
        assert_eq!(report["totals"]["credits"], json!(1.25));
    }

    #[test]
    fn loads_pi_agent_jsonl_usage_entries() {
        let pi_dir = temp_claude_dir("pi-agent");
        let session_dir = pi_dir.join("sessions/project-a");
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("prefix_session-a.jsonl"),
            [
                r#"{"type":"message","timestamp":"2026-04-22T01:02:02.000Z","message":{"role":"user","usage":{"input":999,"output":999}}}"#,
                r#"{"type":"message","timestamp":"2026-04-22T01:02:03.000Z","message":{"role":"assistant","model":"gpt-5.4","usage":{"input":100,"output":50,"cacheRead":10,"cacheWrite":20,"totalTokens":180,"cost":{"total":0.05}}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let entries = adapter::pi::read_session_file(
            &session_dir.join("prefix_session-a.jsonl"),
            parse_tz(Some("UTC")).as_ref(),
        )
        .unwrap();
        fs::remove_dir_all(&pi_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-04-22");
        assert_eq!(entries[0].project.as_ref(), "project-a");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].model.as_deref(), Some("[pi] gpt-5.4"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
        assert_eq!(entries[0].cost, 0.05);
    }

    #[test]
    fn builds_pi_daily_json_report() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("session-a".to_string()),
                timestamp: "2026-04-22T01:02:03.000Z".to_string(),
                version: None,
                message: UsageMessage {
                    usage: TokenUsageRaw {
                        input_tokens: 100,
                        output_tokens: 50,
                        cache_creation_input_tokens: 20,
                        cache_read_input_tokens: 10,
                        speed: None,
                    },
                    model: Some("[pi] gpt-5.4".to_string()),
                    id: None,
                },
                cost_usd: Some(0.05),
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: parse_ts_timestamp("2026-04-22T01:02:03.000Z").unwrap(),
            date: "2026-04-22".to_string(),
            project: Arc::from("project-a"),
            session_id: Arc::from("session-a"),
            project_path: Arc::from("project-a"),
            cost: 0.05,
            credits: None,
            model: Some("[pi] gpt-5.4".to_string()),
            usage_limit_reset_time: None,
        };

        let rows = adapter::pi::summarize_entries(&[entry], AgentReportKind::Daily).unwrap();
        let report = adapter::pi::report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["date"], "2026-04-22");
        assert_eq!(report["daily"][0]["inputTokens"], 100);
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["cacheCreationTokens"], 20);
        assert_eq!(report["daily"][0]["cacheReadTokens"], 10);
        assert_eq!(report["daily"][0]["totalTokens"], 180);
        assert_eq!(report["daily"][0]["totalCost"], json!(0.05));
        assert_eq!(report["daily"][0]["modelsUsed"], json!(["[pi] gpt-5.4"]));
    }

    #[test]
    fn builds_opencode_daily_json_report() {
        let entry = LoadedEntry {
            data: UsageEntry {
                session_id: Some("opencode-session".to_string()),
                timestamp: "2026-01-02T00:00:00.000Z".to_string(),
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
                    id: Some("msg-1".to_string()),
                },
                cost_usd: Some(0.02),
                request_id: None,
                is_api_error_message: None,
            },
            timestamp: parse_ts_timestamp("2026-01-02T00:00:00.000Z").unwrap(),
            date: "2026-01-02".to_string(),
            project: Arc::from("opencode"),
            session_id: Arc::from("opencode-session"),
            project_path: Arc::from("OpenCode"),
            cost: 0.02,
            credits: None,
            model: Some("claude-sonnet-4-20250514".to_string()),
            usage_limit_reset_time: None,
        };

        let report =
            adapter::opencode::report_json(&[entry], AgentReportKind::Daily, &SortOrder::Asc)
                .unwrap();

        assert_eq!(report["daily"][0]["date"], "2026-01-02");
        assert_eq!(report["daily"][0]["inputTokens"], 100);
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["cacheCreationTokens"], 20);
        assert_eq!(report["daily"][0]["cacheReadTokens"], 10);
        assert_eq!(report["daily"][0]["totalTokens"], 180);
        assert_eq!(report["daily"][0]["totalCost"], json!(0.02));
        assert_eq!(
            report["daily"][0]["modelsUsed"],
            json!(["claude-sonnet-4-20250514"])
        );
    }

    #[test]
    fn extracts_usage_limit_reset_time_from_raw_line() {
        let line = r#"{"timestamp":"2025-01-10T10:00:00.000Z","isApiErrorMessage":true,"message":{"content":[{"text":"Claude AI usage limit reached|1736503200 remaining"}],"usage":{"input_tokens":0,"output_tokens":0}}}"#;
        let reset_time = claude_loader::usage_limit_reset_time_from_line(line, Some(true)).unwrap();

        assert_eq!(
            format_rfc3339_millis(reset_time),
            "2025-01-10T10:00:00.000Z"
        );
        assert!(claude_loader::usage_limit_reset_time_from_line(line, Some(false)).is_none());
        assert!(claude_loader::usage_limit_reset_time_from_line(
            r#"{"message":{"content":[{"text":"Claude AI usage limit reached|0"}]}}"#,
            Some(true)
        )
        .is_none());
    }
}
