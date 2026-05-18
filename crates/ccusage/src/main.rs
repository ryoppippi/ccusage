use std::{
    collections::hash_map::DefaultHasher,
    collections::{BTreeMap, HashMap, HashSet},
    env, fmt, fs,
    hash::{Hash, Hasher},
    io,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

mod adapter;
mod blocks;
mod cli;
mod commands;
mod config;
mod cost;
mod date_utils;
mod home;
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
pub(crate) use cost::{calculate_cost, tiered_cost};
pub(crate) use date_utils::*;
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

macro_rules! bail {
    ($($arg:tt)*) => {
        return Err(cli_error(format!($($arg)*)))
    };
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

fn filter_loaded_entries_by_date(entries: &mut Vec<LoadedEntry>, shared: &SharedArgs) {
    if shared.since.is_none() && shared.until.is_none() {
        return;
    }
    entries.retain(|entry| {
        let date = entry.date.replace('-', "");
        shared.since.as_ref().is_none_or(|since| &date >= since)
            && shared.until.as_ref().is_none_or(|until| &date <= until)
    });
}

fn json_value_u64(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or_default()
}

fn load_entries(shared: &SharedArgs, project_filter: Option<&str>) -> Result<Vec<LoadedEntry>> {
    progress::track_usage_load(progress::UsageLoadAgent::Claude, shared.json, || {
        load_entries_inner(shared, project_filter)
    })
}

fn load_entries_inner(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    let paths = claude_paths()?;
    debug_log(
        shared,
        format!(
            "Scanning Claude data directories: {}",
            paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    );
    let files = usage_files(&paths);
    debug_log(shared, format!("Found {} JSONL usage files", files.len()));
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let pricing = if shared.mode == CostMode::Display {
        None
    } else {
        Some(PricingMap::load(shared.offline, log_level() != Some(0)))
    };
    let tz = parse_tz(shared.timezone.as_deref());
    let mode = shared.mode;
    let mut loaded_files = if shared.single_thread {
        files
            .iter()
            .map(|file| read_usage_file(file, tz.as_ref(), mode, pricing.as_ref()))
            .collect::<Vec<_>>()
    } else {
        read_usage_files_parallel(&files, tz.as_ref(), mode, pricing.as_ref())
    };
    loaded_files.sort_by(|a, b| match (a.timestamp, b.timestamp) {
        (Some(a_timestamp), Some(b_timestamp)) => a_timestamp.cmp(&b_timestamp),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.path.cmp(&b.path),
    });
    let loaded_entry_count = loaded_files
        .iter()
        .map(|file| file.entries.len())
        .sum::<usize>();
    debug_log(
        shared,
        format!(
            "Loaded {loaded_entry_count} usage entries from {} JSONL files",
            loaded_files.len()
        ),
    );

    let mut deduped_indexes: HashMap<u64, Vec<usize>> = HashMap::new();
    let mut deduped: Vec<LoadedEntry> =
        Vec::with_capacity(loaded_files.iter().map(|file| file.entries.len()).sum());
    for loaded_file in loaded_files {
        for entry in loaded_file.entries {
            if let Some(filter) = project_filter {
                if entry.project.as_ref() != filter {
                    continue;
                }
            }
            push_deduped_entry(entry, &mut deduped_indexes, &mut deduped);
        }
    }
    debug_log(
        shared,
        format!("Kept {} usage entries after deduplication", deduped.len()),
    );
    Ok(deduped)
}

fn read_usage_files_parallel(
    files: &[PathBuf],
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Vec<LoadedFile> {
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(files.len());
    if worker_count <= 1 {
        return files
            .iter()
            .map(|file| read_usage_file(file, tz, mode, pricing))
            .collect();
    }

    let chunks = chunk_file_indexes_by_size(files, worker_count);
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(worker_count);
        for chunk in chunks {
            let tz = tz.cloned();
            handles.push(scope.spawn(move || {
                chunk
                    .into_iter()
                    .map(|index| {
                        (
                            index,
                            read_usage_file(&files[index], tz.as_ref(), mode, pricing),
                        )
                    })
                    .collect::<Vec<_>>()
            }));
        }
        let mut loaded_files = Vec::with_capacity(files.len());
        loaded_files.resize_with(files.len(), || None);
        for (index, file) in handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("usage worker panicked"))
        {
            loaded_files[index] = Some(file);
        }
        loaded_files
            .into_iter()
            .map(|file| file.expect("usage worker returned every file"))
            .collect()
    })
}

fn chunk_file_indexes_by_size(files: &[PathBuf], chunk_count: usize) -> Vec<Vec<usize>> {
    let mut weighted_indexes = Vec::with_capacity(files.len());
    for (index, file) in files.iter().enumerate() {
        let size = fs::metadata(file).map_or(0, |metadata| metadata.len());
        weighted_indexes.push((index, size));
    }
    weighted_indexes.sort_unstable_by(|a, b| match b.1.cmp(&a.1) {
        std::cmp::Ordering::Equal => a.0.cmp(&b.0),
        order => order,
    });

    let mut chunks = vec![Vec::new(); chunk_count];
    let mut chunk_sizes = vec![0_u64; chunk_count];
    for (index, size) in weighted_indexes {
        let mut target = 0;
        for candidate in 1..chunk_sizes.len() {
            if chunk_sizes[candidate] < chunk_sizes[target] {
                target = candidate;
            }
        }
        chunks[target].push(index);
        chunk_sizes[target] = chunk_sizes[target].saturating_add(size);
    }

    chunks
        .into_iter()
        .filter(|chunk| !chunk.is_empty())
        .collect()
}

fn debug_log(shared: &SharedArgs, message: impl AsRef<str>) {
    if shared.debug {
        eprintln!("{}", message.as_ref());
    }
}

fn usage_token_total(data: &UsageEntry) -> u64 {
    let usage = data.message.usage;
    usage.input_tokens
        + usage.output_tokens
        + usage.cache_creation_input_tokens
        + usage.cache_read_input_tokens
}

fn should_replace_deduped_entry(candidate: &UsageEntry, existing: &UsageEntry) -> bool {
    let candidate_total = usage_token_total(candidate);
    let existing_total = usage_token_total(existing);
    if candidate_total != existing_total {
        return candidate_total > existing_total;
    }

    candidate.message.usage.speed.is_some() && existing.message.usage.speed.is_none()
}

fn push_deduped_entry(
    entry: LoadedEntry,
    deduped_indexes: &mut HashMap<u64, Vec<usize>>,
    deduped: &mut Vec<LoadedEntry>,
) {
    let dedupe_lookup = entry
        .data
        .message
        .id
        .as_deref()
        .zip(entry.data.request_id.as_deref())
        .map(|(message_id, request_id)| {
            let hash = usage_dedupe_hash(message_id, request_id);
            let existing_index = deduped_indexes.get(&hash).and_then(|indexes| {
                indexes.iter().copied().find(|&index| {
                    loaded_entry_matches_dedupe_key(&deduped[index], message_id, request_id)
                })
            });
            (hash, existing_index)
        });

    if let Some((_, Some(index))) = dedupe_lookup {
        if should_replace_deduped_entry(&entry.data, &deduped[index].data) {
            deduped[index] = entry;
        }
        return;
    }

    let index = deduped.len();
    deduped.push(entry);
    if let Some((hash, None)) = dedupe_lookup {
        deduped_indexes.entry(hash).or_default().push(index);
    }
}

fn usage_dedupe_hash(message_id: &str, request_id: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    message_id.hash(&mut hasher);
    request_id.hash(&mut hasher);
    hasher.finish()
}

fn loaded_entry_matches_dedupe_key(
    entry: &LoadedEntry,
    message_id: &str,
    request_id: &str,
) -> bool {
    entry.data.message.id.as_deref() == Some(message_id)
        && entry.data.request_id.as_deref() == Some(request_id)
}

fn read_usage_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> LoadedFile {
    let project: Arc<str> = Arc::from(extract_project(path));
    let (session_id, project_path) = extract_session_parts(path);
    let session_id: Arc<str> = Arc::from(session_id);
    let project_path: Arc<str> = Arc::from(project_path);
    let mut loaded_file = LoadedFile {
        path: path.to_path_buf(),
        timestamp: None,
        entries: Vec::new(),
    };
    let Ok(content) = fs::read_to_string(path) else {
        return loaded_file;
    };

    for line in content.lines() {
        if !line.contains("\"usage\":{") {
            if let Some(timestamp) = earliest_timestamp_from_line(line) {
                update_loaded_file_timestamp(&mut loaded_file, timestamp);
            }
            continue;
        }
        let Ok(data) = serde_json::from_str::<UsageEntry>(line) else {
            if let Some(timestamp) = earliest_timestamp_from_line(line) {
                update_loaded_file_timestamp(&mut loaded_file, timestamp);
            }
            continue;
        };
        let Some(timestamp) = parse_ts_timestamp(&data.timestamp) else {
            continue;
        };
        update_loaded_file_timestamp(&mut loaded_file, timestamp);
        if !is_valid_usage_entry(&data) {
            continue;
        }
        let date = format_date_tz(timestamp, tz);
        let cost = calculate_cost(&data, mode, pricing);
        let usage_limit_reset_time =
            usage_limit_reset_time_from_line(line, data.is_api_error_message);
        let model = data.message.model.as_ref().and_then(|model| {
            if model == "<synthetic>" {
                None
            } else if matches!(data.message.usage.speed, Some(Speed::Fast)) {
                Some(format!("{model}-fast"))
            } else {
                Some(model.clone())
            }
        });
        loaded_file.entries.push(LoadedEntry {
            data,
            timestamp,
            date,
            project: Arc::clone(&project),
            session_id: Arc::clone(&session_id),
            project_path: Arc::clone(&project_path),
            cost,
            credits: None,
            model,
            usage_limit_reset_time,
        });
    }
    loaded_file
}

fn update_loaded_file_timestamp(loaded_file: &mut LoadedFile, timestamp: TimestampMs) {
    loaded_file.timestamp = Some(
        loaded_file
            .timestamp
            .map_or(timestamp, |current| current.min(timestamp)),
    );
}

fn is_valid_usage_entry(data: &UsageEntry) -> bool {
    if data
        .version
        .as_deref()
        .is_some_and(|version| !is_semver_prefix(version))
    {
        return false;
    }
    if data
        .session_id
        .as_deref()
        .is_some_and(|session_id| session_id.is_empty())
    {
        return false;
    }
    if data
        .request_id
        .as_deref()
        .is_some_and(|request_id| request_id.is_empty())
    {
        return false;
    }
    if data
        .message
        .id
        .as_deref()
        .is_some_and(|message_id| message_id.is_empty())
    {
        return false;
    }
    if data
        .message
        .model
        .as_deref()
        .is_some_and(|model| model.is_empty())
    {
        return false;
    }
    true
}

fn is_semver_prefix(value: &str) -> bool {
    let mut parts = value.split('.');
    let Some(major) = parts.next() else {
        return false;
    };
    let Some(minor) = parts.next() else {
        return false;
    };
    let Some(patch) = parts.next() else {
        return false;
    };
    !major.is_empty()
        && !minor.is_empty()
        && !patch.is_empty()
        && major.chars().all(|ch| ch.is_ascii_digit())
        && minor.chars().all(|ch| ch.is_ascii_digit())
        && patch.chars().next().is_some_and(|ch| ch.is_ascii_digit())
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

fn claude_paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var("CLAUDE_CONFIG_DIR") {
        for raw in env_paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            let path = PathBuf::from(raw);
            if path.join("projects").is_dir() && seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        if !paths.is_empty() {
            return Ok(paths);
        }
        bail!("No valid Claude data directories found in CLAUDE_CONFIG_DIR");
    }

    let home = home::home_dir().ok_or_else(|| cli_error("home directory is not set"))?;
    let xdg = env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&home).join(".config"));
    for path in [xdg.join("claude"), home.join(".claude")] {
        if path.join("projects").is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        bail!("No valid Claude data directories found");
    }
    Ok(paths)
}

fn usage_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for path in paths {
        collect_usage_files(&path.join("projects"), &mut files);
    }
    files
}

fn collect_usage_files(dir: &Path, files: &mut Vec<PathBuf>) {
    collect_files_with_extension(dir, "jsonl", files);
}

fn collect_files_with_extension(dir: &Path, extension: &str, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.filter_map(std::result::Result::ok) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_file() && path.extension().is_some_and(|ext| ext == extension) {
            files.push(path);
        } else if file_type.is_dir() {
            collect_files_with_extension(&path, extension, files);
        }
    }
}

fn timestamp_from_line(line: &str) -> Option<TimestampMs> {
    let start = line.find("\"timestamp\":\"")? + "\"timestamp\":\"".len();
    let end = line[start..].find('"')? + start;
    parse_ts_timestamp(&line[start..end])
}

fn earliest_timestamp_from_line(line: &str) -> Option<TimestampMs> {
    if let Some(timestamp) = timestamp_from_line(line) {
        return Some(timestamp);
    }
    if !line.contains("\"timestamp\"") {
        return None;
    }
    let value = serde_json::from_str::<Value>(line).ok()?;
    let timestamp = value.get("timestamp")?.as_str()?;
    parse_ts_timestamp(timestamp)
}

fn extract_project(path: &Path) -> String {
    let mut saw_projects = false;
    for part in path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
    {
        if saw_projects {
            return if part.trim().is_empty() {
                "unknown"
            } else {
                part
            }
            .to_string();
        }
        if part == "projects" {
            saw_projects = true;
        }
    }
    "unknown".to_string()
}

fn extract_session_parts(path: &Path) -> (String, String) {
    let parts = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    let projects_index = parts.iter().position(|part| *part == "projects");
    let relative = projects_index
        .map(|index| &parts[index + 1..])
        .unwrap_or(&parts);
    let session_id = relative
        .get(relative.len().saturating_sub(2))
        .copied()
        .unwrap_or("unknown")
        .to_string();
    let project_path = if relative.len() > 2 {
        relative[..relative.len() - 2].join(std::path::MAIN_SEPARATOR_STR)
    } else {
        "Unknown Project".to_string()
    };
    (session_id, project_path)
}

fn wants_json(shared: &SharedArgs) -> bool {
    shared.json || shared.jq.is_some()
}

fn summary_json(row: &UsageSummary) -> Value {
    let total =
        row.input_tokens + row.output_tokens + row.cache_creation_tokens + row.cache_read_tokens;
    let mut value = json!({
        "inputTokens": row.input_tokens,
        "outputTokens": row.output_tokens,
        "cacheCreationTokens": row.cache_creation_tokens,
        "cacheReadTokens": row.cache_read_tokens,
        "totalTokens": total,
        "totalCost": row.total_cost,
        "modelsUsed": row.models_used,
        "modelBreakdowns": row.model_breakdowns,
    });
    if let Some(obj) = value.as_object_mut() {
        if let Some(date) = &row.date {
            obj.insert("date".to_string(), json!(date));
        }
        if let Some(month) = &row.month {
            obj.insert("month".to_string(), json!(month));
        }
        if let Some(week) = &row.week {
            obj.insert("week".to_string(), json!(week));
        }
        if let Some(project) = &row.project {
            obj.insert("project".to_string(), json!(project));
        }
        if let Some(credits) = row.credits {
            obj.insert("credits".to_string(), json!(credits));
        }
    }
    value
}

fn session_summary_json(row: &UsageSummary) -> Value {
    let mut value = json!({
        "sessionId": row.session_id,
        "inputTokens": row.input_tokens,
        "outputTokens": row.output_tokens,
        "cacheCreationTokens": row.cache_creation_tokens,
        "cacheReadTokens": row.cache_read_tokens,
        "totalTokens": row.input_tokens + row.output_tokens + row.cache_creation_tokens + row.cache_read_tokens,
        "totalCost": row.total_cost,
        "lastActivity": row.last_activity,
        "modelsUsed": row.models_used,
        "modelBreakdowns": row.model_breakdowns,
        "projectPath": row.project_path,
    });
    if let (Some(obj), Some(credits)) = (value.as_object_mut(), row.credits) {
        obj.insert("credits".to_string(), json!(credits));
    }
    value
}

fn totals_json(rows: &[UsageSummary]) -> Value {
    let input = rows.iter().map(|row| row.input_tokens).sum::<u64>();
    let output = rows.iter().map(|row| row.output_tokens).sum::<u64>();
    let cache_create = rows
        .iter()
        .map(|row| row.cache_creation_tokens)
        .sum::<u64>();
    let cache_read = rows.iter().map(|row| row.cache_read_tokens).sum::<u64>();
    let mut value = json!({
        "inputTokens": input,
        "outputTokens": output,
        "cacheCreationTokens": cache_create,
        "cacheReadTokens": cache_read,
        "totalTokens": input + output + cache_create + cache_read,
        "totalCost": rows.iter().map(|row| row.total_cost).sum::<f64>(),
    });
    let credits = rows.iter().filter_map(|row| row.credits).sum::<f64>();
    if credits > 0.0 {
        value["credits"] = json!(credits);
    }
    value
}

fn group_project_output(rows: &[UsageSummary]) -> Value {
    let mut projects: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for row in rows {
        projects
            .entry(row.project.clone().unwrap_or_else(|| "unknown".to_string()))
            .or_default()
            .push(summary_json(row));
    }
    json!(projects)
}

fn print_json_or_jq(value: Value, jq: Option<&str>) -> Result<()> {
    if let Some(filter) = jq {
        let mut child = std::process::Command::new("jq")
            .arg(filter)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .spawn()
            .context("failed to run jq")?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            stdin.write_all(serde_json::to_string(&value)?.as_bytes())?;
        }
        let status = child.wait()?;
        if !status.success() {
            bail!("jq failed");
        }
    } else {
        println!("{}", serde_json::to_string_pretty(&value)?);
    }
    Ok(())
}

fn print_usage_table(
    title: &str,
    first_column: &str,
    rows: &[UsageSummary],
    shared: &SharedArgs,
    group_projects: bool,
    project_aliases: Option<&str>,
) {
    if rows.is_empty() {
        eprintln!("No Claude usage data found.");
        return;
    }
    let terminal_width = terminal_width();
    let compact = shared.compact || terminal_width < USAGE_COMPACT_WIDTH_THRESHOLD;
    let include_last_activity = rows.iter().any(|row| row.last_activity.is_some());
    print_box_title(title, shared);
    let mut headers = if compact {
        vec![first_column, "Models", "Input", "Output", "Cost (USD)"]
    } else {
        vec![
            first_column,
            "Models",
            "Input",
            "Output",
            "Cache Create",
            "Cache Read",
            "Total Tokens",
            "Cost (USD)",
        ]
    };
    let mut aligns = if compact {
        vec![
            Align::Left,
            Align::Left,
            Align::Right,
            Align::Right,
            Align::Right,
        ]
    } else {
        vec![
            Align::Left,
            Align::Left,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
        ]
    };
    if include_last_activity {
        headers.push("Last Activity");
        aligns.push(Align::Left);
    }
    let mut table = SimpleTable::new(headers, aligns, shared)
        .with_terminal_width(terminal_width)
        .with_date_compaction(true);
    let aliases = parse_project_aliases(project_aliases);
    let mut current_project: Option<&str> = None;
    for row in rows {
        if group_projects {
            if let Some(project) = row.project.as_deref() {
                if current_project != Some(project) {
                    if current_project.is_some() {
                        table.separator();
                    }
                    table.push(project_header_row(
                        table.column_count(),
                        &format_project_name(project, &aliases),
                        shared,
                    ));
                    current_project = Some(project);
                }
            }
        }
        let label = row
            .date
            .as_deref()
            .or(row.month.as_deref())
            .or(row.week.as_deref())
            .or(row.session_id.as_deref())
            .unwrap_or("");
        let models = format_models_multiline(&row.models_used);
        let total_tokens = row.input_tokens
            + row.output_tokens
            + row.cache_creation_tokens
            + row.cache_read_tokens;
        let mut values = if compact {
            vec![
                label.to_string(),
                models,
                format_number(row.input_tokens),
                format_number(row.output_tokens),
                format_currency(row.total_cost),
            ]
        } else {
            vec![
                label.to_string(),
                models,
                format_number(row.input_tokens),
                format_number(row.output_tokens),
                format_number(row.cache_creation_tokens),
                format_number(row.cache_read_tokens),
                format_number(total_tokens),
                format_currency(row.total_cost),
            ]
        };
        if include_last_activity {
            values.push(row.last_activity.clone().unwrap_or_default());
        }
        table.push(values);
        if shared.breakdown {
            push_breakdown_rows(&mut table, row, compact, include_last_activity, shared);
        }
    }

    let totals = totals_json(rows);
    let input = totals
        .get("inputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output = totals
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cache_create = totals
        .get("cacheCreationTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cache_read = totals
        .get("cacheReadTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let total_cost = totals
        .get("totalCost")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    table.separator();
    let mut total_row = if compact {
        vec![
            color(shared, "Total", Color::Yellow),
            String::new(),
            color(shared, format_number(input), Color::Yellow),
            color(shared, format_number(output), Color::Yellow),
            color(shared, format_currency(total_cost), Color::Yellow),
        ]
    } else {
        vec![
            color(shared, "Total", Color::Yellow),
            String::new(),
            color(shared, format_number(input), Color::Yellow),
            color(shared, format_number(output), Color::Yellow),
            color(shared, format_number(cache_create), Color::Yellow),
            color(shared, format_number(cache_read), Color::Yellow),
            color(
                shared,
                format_number(input + output + cache_create + cache_read),
                Color::Yellow,
            ),
            color(shared, format_currency(total_cost), Color::Yellow),
        ]
    };
    if include_last_activity {
        total_row.push(String::new());
    }
    table.push(total_row);
    table.print();
    if compact {
        eprintln!("\nRunning in Compact Mode");
        eprintln!("Expand terminal width to see cache metrics and total tokens");
    }
}

fn usage_limit_reset_time_from_line(
    line: &str,
    is_api_error_message: Option<bool>,
) -> Option<TimestampMs> {
    if is_api_error_message != Some(true) {
        return None;
    }
    let marker = "Claude AI usage limit reached";
    let marker_start = line.find(marker)?;
    let timestamp_start = line[marker_start..].find('|')? + marker_start + 1;
    let timestamp_end = line[timestamp_start..]
        .find(|ch: char| !ch.is_ascii_digit())
        .map_or(line.len(), |offset| timestamp_start + offset);
    if timestamp_start == timestamp_end {
        return None;
    }
    let timestamp = line[timestamp_start..timestamp_end].parse::<i64>().ok()?;
    if timestamp <= 0 {
        return None;
    }
    TimestampMs::from_unix_seconds(timestamp)
}

fn json_float(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value <= i64::MAX as f64
    {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn project_header_row(column_count: usize, project: &str, shared: &SharedArgs) -> Vec<String> {
    let mut row = vec![String::new(); column_count];
    if let Some(first) = row.first_mut() {
        *first = color(shared, format!("Project: {project}"), Color::Blue);
    }
    row
}

fn push_breakdown_rows(
    table: &mut SimpleTable<'_>,
    row: &UsageSummary,
    compact: bool,
    include_last_activity: bool,
    shared: &SharedArgs,
) {
    for breakdown in &row.model_breakdowns {
        let total = breakdown.input_tokens
            + breakdown.output_tokens
            + breakdown.cache_creation_tokens
            + breakdown.cache_read_tokens;
        let mut values = if compact {
            vec![
                color(
                    shared,
                    format!("  └─ {}", short_model_name(&breakdown.model_name)),
                    Color::Grey,
                ),
                String::new(),
                color(shared, format_number(breakdown.input_tokens), Color::Grey),
                color(shared, format_number(breakdown.output_tokens), Color::Grey),
                color(shared, format_currency(breakdown.cost), Color::Grey),
            ]
        } else {
            vec![
                color(
                    shared,
                    format!("  └─ {}", short_model_name(&breakdown.model_name)),
                    Color::Grey,
                ),
                String::new(),
                color(shared, format_number(breakdown.input_tokens), Color::Grey),
                color(shared, format_number(breakdown.output_tokens), Color::Grey),
                color(
                    shared,
                    format_number(breakdown.cache_creation_tokens),
                    Color::Grey,
                ),
                color(
                    shared,
                    format_number(breakdown.cache_read_tokens),
                    Color::Grey,
                ),
                color(shared, format_number(total), Color::Grey),
                color(shared, format_currency(breakdown.cost), Color::Grey),
            ]
        };
        if include_last_activity {
            values.push(String::new());
        }
        table.push(values);
    }
}

fn log_level() -> Option<u8> {
    env::var("LOG_LEVEL")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
}

fn format_models_multiline(models: &[String]) -> String {
    let mut models = models
        .iter()
        .map(|model| short_model_name(model))
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models
        .into_iter()
        .map(|model| format!("- {model}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn total_usage_tokens(usage: TokenUsageRaw) -> u64 {
    usage.input_tokens
        + usage.output_tokens
        + usage.cache_creation_input_tokens
        + usage.cache_read_input_tokens
}

fn format_number(value: u64) -> String {
    let s = value.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

fn format_currency(value: f64) -> String {
    format!("${value:.2}")
}

#[cfg(test)]
mod tests {
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
        let timestamp =
            timestamp_from_line(r#"{"timestamp":"2026-05-11T12:34:56.789Z","message":{}}"#)
                .unwrap();

        assert_eq!(format_rfc3339_millis(timestamp), "2026-05-11T12:34:56.789Z");
        assert!(timestamp_from_line(r#"{"timestamp": "2026-05-11T12:34:56.789Z"}"#).is_none());
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
        let reset_time = usage_limit_reset_time_from_line(line, Some(true)).unwrap();

        assert_eq!(
            format_rfc3339_millis(reset_time),
            "2025-01-10T10:00:00.000Z"
        );
        assert!(usage_limit_reset_time_from_line(line, Some(false)).is_none());
        assert!(usage_limit_reset_time_from_line(
            r#"{"message":{"content":[{"text":"Claude AI usage limit reached|0"}]}}"#,
            Some(true)
        )
        .is_none());
    }
}
