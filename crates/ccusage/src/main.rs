use std::{
    collections::hash_map::DefaultHasher,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env, fmt, fs,
    hash::{Hash, Hasher},
    io::{self, IsTerminal},
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

mod adapter;
mod cli;
mod commands;
mod config;
mod date_utils;
mod home;
mod pricing;
mod progress;
mod types;

pub(crate) use date_utils::*;
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

#[cfg(all(unix, target_os = "macos"))]
const TIOCGWINSZ: usize = 0x4008_7468;
#[cfg(all(unix, target_os = "linux"))]
const TIOCGWINSZ: usize = 0x5413;

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

fn calculate_cost(data: &UsageEntry, mode: CostMode, pricing: Option<&PricingMap>) -> f64 {
    match mode {
        CostMode::Display => data.cost_usd.unwrap_or(0.0),
        CostMode::Auto => data
            .cost_usd
            .unwrap_or_else(|| calculate_cost_from_tokens(data, pricing)),
        CostMode::Calculate => calculate_cost_from_tokens(data, pricing),
    }
}

fn calculate_cost_from_tokens(data: &UsageEntry, pricing: Option<&PricingMap>) -> f64 {
    let Some(model) = data.message.model.as_deref() else {
        return 0.0;
    };
    let Some(pricing) = pricing.and_then(|pricing| pricing.find(model)) else {
        return 0.0;
    };
    let usage = data.message.usage;
    let multiplier = if matches!(usage.speed, Some(Speed::Fast)) {
        pricing.fast_multiplier
    } else {
        1.0
    };
    (tiered_cost(usage.input_tokens, pricing.input, pricing.input_above_200k)
        + tiered_cost(
            usage.output_tokens,
            pricing.output,
            pricing.output_above_200k,
        )
        + tiered_cost(
            usage.cache_creation_input_tokens,
            pricing.cache_create,
            pricing.cache_create_above_200k,
        )
        + tiered_cost(
            usage.cache_read_input_tokens,
            pricing.cache_read,
            pricing.cache_read_above_200k,
        ))
        * multiplier
}

fn tiered_cost(tokens: u64, base: f64, above: Option<f64>) -> f64 {
    const THRESHOLD: u64 = 200_000;
    if tokens == 0 {
        return 0.0;
    }
    if let Some(above) = above {
        if tokens > THRESHOLD {
            return (THRESHOLD as f64 * base) + ((tokens - THRESHOLD) as f64 * above);
        }
    }
    tokens as f64 * base
}

fn summarize_by_key<F, M>(
    entries: &[LoadedEntry],
    key_fn: F,
    meta_fn: M,
) -> Result<Vec<UsageSummary>>
where
    F: Fn(&LoadedEntry) -> String,
    M: Fn(&str) -> (String, Option<String>),
{
    let mut groups: BTreeMap<String, UsageAccumulator> = BTreeMap::new();
    for entry in entries {
        groups.entry(key_fn(entry)).or_default().add_entry(entry);
    }

    let mut rows = Vec::with_capacity(groups.len());
    for (key, group) in groups {
        let (date, project) = meta_fn(&key);
        let mut summary = group.into_summary();
        summary.date = Some(date);
        summary.project = project;
        rows.push(summary);
    }
    Ok(rows)
}

#[derive(Default)]
struct UsageAccumulator {
    counts: TokenCounts,
    cost: f64,
    credits: Option<f64>,
    models: Vec<String>,
    seen_models: HashSet<String>,
    breakdowns: Vec<ModelBreakdown>,
    breakdown_indexes: HashMap<String, usize>,
}

impl UsageAccumulator {
    fn add_entry(&mut self, entry: &LoadedEntry) {
        let usage = entry.data.message.usage;
        self.counts.add_usage(usage);
        self.cost += entry.cost;
        if let Some(credits) = entry.credits {
            *self.credits.get_or_insert(0.0) += credits;
        }
        if let Some(model) = &entry.model {
            if self.seen_models.insert(model.clone()) {
                self.models.push(model.clone());
            }
            let index = *self
                .breakdown_indexes
                .entry(model.clone())
                .or_insert_with(|| {
                    let index = self.breakdowns.len();
                    self.breakdowns.push(ModelBreakdown {
                        model_name: model.clone(),
                        ..ModelBreakdown::default()
                    });
                    index
                });
            let breakdown = &mut self.breakdowns[index];
            breakdown.input_tokens += usage.input_tokens;
            breakdown.output_tokens += usage.output_tokens;
            breakdown.cache_creation_tokens += usage.cache_creation_input_tokens;
            breakdown.cache_read_tokens += usage.cache_read_input_tokens;
            breakdown.cost += entry.cost;
        }
    }

    fn into_summary(mut self) -> UsageSummary {
        self.breakdowns.sort_by(|a, b| b.cost.total_cmp(&a.cost));
        UsageSummary {
            date: None,
            month: None,
            week: None,
            session_id: None,
            project_path: None,
            last_activity: None,
            input_tokens: self.counts.input_tokens,
            output_tokens: self.counts.output_tokens,
            cache_creation_tokens: self.counts.cache_creation_tokens,
            cache_read_tokens: self.counts.cache_read_tokens,
            total_cost: self.cost,
            credits: self.credits,
            models_used: self.models,
            model_breakdowns: self.breakdowns,
            project: None,
            versions: None,
        }
    }
}

#[derive(Default)]
struct SessionAccumulator {
    usage: UsageAccumulator,
    latest: Option<(TimestampMs, Arc<str>, Arc<str>)>,
    versions: BTreeSet<String>,
}

impl SessionAccumulator {
    fn add_entry(&mut self, entry: &LoadedEntry) {
        self.usage.add_entry(entry);
        if self
            .latest
            .as_ref()
            .is_none_or(|(timestamp, _, _)| entry.timestamp > *timestamp)
        {
            self.latest = Some((
                entry.timestamp,
                Arc::clone(&entry.session_id),
                Arc::clone(&entry.project_path),
            ));
        }
        if let Some(version) = &entry.data.version {
            self.versions.insert(version.clone());
        }
    }

    fn into_summary(self, timezone: Option<&str>) -> Result<UsageSummary> {
        let Some((timestamp, session_id, project_path)) = self.latest else {
            bail!("empty session group");
        };
        let mut summary = self.usage.into_summary();
        summary.session_id = Some(session_id.to_string());
        summary.project_path = Some(project_path.to_string());
        summary.last_activity = Some(format_date(timestamp, timezone));
        summary.versions = Some(self.versions.into_iter().collect());
        Ok(summary)
    }
}

#[derive(Clone, Copy)]
enum BucketKind {
    Monthly,
    Weekly,
}

fn summarize_summaries_by_bucket(
    rows: &[UsageSummary],
    kind: BucketKind,
    start: WeekDay,
) -> Vec<UsageSummary> {
    let mut groups: BTreeMap<String, Vec<&UsageSummary>> = BTreeMap::new();
    for row in rows {
        let Some(date) = row.date.as_deref() else {
            continue;
        };
        let bucket = match kind {
            BucketKind::Monthly => date.get(..7).unwrap_or(date).to_string(),
            BucketKind::Weekly => week_start(date, start).unwrap_or_else(|| date.to_string()),
        };
        groups.entry(bucket).or_default().push(row);
    }

    groups
        .into_iter()
        .map(|(bucket, rows)| {
            let mut summary = aggregate_summaries(&rows);
            match kind {
                BucketKind::Monthly => summary.month = Some(bucket),
                BucketKind::Weekly => summary.week = Some(bucket),
            }
            summary
        })
        .collect()
}

fn aggregate_summaries(rows: &[&UsageSummary]) -> UsageSummary {
    let mut summary = UsageSummary {
        date: None,
        month: None,
        week: None,
        session_id: None,
        project_path: None,
        last_activity: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_cost: 0.0,
        credits: None,
        models_used: Vec::new(),
        model_breakdowns: Vec::new(),
        project: None,
        versions: None,
    };
    let mut seen_models = HashSet::new();
    let mut breakdown_indexes = HashMap::<String, usize>::new();

    for row in rows {
        summary.input_tokens += row.input_tokens;
        summary.output_tokens += row.output_tokens;
        summary.cache_creation_tokens += row.cache_creation_tokens;
        summary.cache_read_tokens += row.cache_read_tokens;
        summary.total_cost += row.total_cost;
        if let Some(credits) = row.credits {
            *summary.credits.get_or_insert(0.0) += credits;
        }
        for model in &row.models_used {
            if seen_models.insert(model.clone()) {
                summary.models_used.push(model.clone());
            }
        }
        for item in &row.model_breakdowns {
            let index = *breakdown_indexes
                .entry(item.model_name.clone())
                .or_insert_with(|| {
                    let index = summary.model_breakdowns.len();
                    summary.model_breakdowns.push(ModelBreakdown {
                        model_name: item.model_name.clone(),
                        ..ModelBreakdown::default()
                    });
                    index
                });
            let breakdown = &mut summary.model_breakdowns[index];
            breakdown.input_tokens += item.input_tokens;
            breakdown.output_tokens += item.output_tokens;
            breakdown.cache_creation_tokens += item.cache_creation_tokens;
            breakdown.cache_read_tokens += item.cache_read_tokens;
            breakdown.cost += item.cost;
        }
    }
    summary
        .model_breakdowns
        .sort_by(|a, b| b.cost.total_cmp(&a.cost));
    summary
}

fn filter_and_sort_summaries<F>(rows: &mut Vec<UsageSummary>, shared: &SharedArgs, date_fn: F)
where
    F: Fn(&UsageSummary) -> &str,
{
    if shared.since.is_some() || shared.until.is_some() {
        rows.retain(|row| {
            let date = date_fn(row).replace('-', "");
            shared.since.as_ref().is_none_or(|since| &date >= since)
                && shared.until.as_ref().is_none_or(|until| &date <= until)
        });
    }
    sort_summaries(rows, &shared.order, date_fn);
}

fn sort_summaries<F>(rows: &mut [UsageSummary], order: &SortOrder, date_fn: F)
where
    F: Fn(&UsageSummary) -> &str,
{
    rows.sort_by(|a, b| match order {
        SortOrder::Asc => date_fn(a).cmp(date_fn(b)),
        SortOrder::Desc => date_fn(b).cmp(date_fn(a)),
    });
}

fn week_start(date: &str, start: WeekDay) -> Option<String> {
    let date = parse_iso_date(date)?;
    let start_num = match start {
        WeekDay::Sunday => 0,
        WeekDay::Monday => 1,
        WeekDay::Tuesday => 2,
        WeekDay::Wednesday => 3,
        WeekDay::Thursday => 4,
        WeekDay::Friday => 5,
        WeekDay::Saturday => 6,
    };
    let day = date.weekday_from_sunday() as i64;
    let shift = (day - start_num + 7) % 7;
    Some(format_naive_date(date.checked_add_days(-shift)?))
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

fn identify_session_blocks(
    mut entries: Vec<LoadedEntry>,
    session_duration_hours: f64,
) -> Vec<SessionBlock> {
    if entries.is_empty() {
        return Vec::new();
    }
    let session_duration = (session_duration_hours * MILLIS_PER_HOUR as f64) as i64;
    entries.sort_by_key(|entry| entry.timestamp);
    let now = utc_now();
    let mut blocks = Vec::new();
    let mut current_start: Option<TimestampMs> = None;
    let mut current_entries = Vec::new();

    for entry in entries {
        if let Some(start) = current_start {
            let last_time = current_entries
                .last()
                .map(|entry: &LoadedEntry| entry.timestamp)
                .unwrap_or(start);
            let since_start = entry.timestamp.duration_since(start);
            let since_last = entry.timestamp.duration_since(last_time);
            if since_start > session_duration || since_last > session_duration {
                blocks.push(create_block(
                    start,
                    std::mem::take(&mut current_entries),
                    now,
                    session_duration,
                ));
                if since_last > session_duration {
                    blocks.push(create_gap_block(
                        last_time,
                        entry.timestamp,
                        session_duration,
                    ));
                }
                current_start = Some(floor_to_hour(entry.timestamp));
            }
        } else {
            current_start = Some(floor_to_hour(entry.timestamp));
        }
        current_entries.push(entry);
    }

    if let Some(start) = current_start {
        if !current_entries.is_empty() {
            blocks.push(create_block(start, current_entries, now, session_duration));
        }
    }
    blocks
}

fn floor_to_hour(timestamp: TimestampMs) -> TimestampMs {
    timestamp.floor_to_hour()
}

fn create_block(
    start: TimestampMs,
    entries: Vec<LoadedEntry>,
    now: TimestampMs,
    duration: i64,
) -> SessionBlock {
    let end = start.checked_add_millis(duration).unwrap_or(start);
    let actual_end = entries.last().map(|entry| entry.timestamp);
    let is_active = actual_end.is_some_and(|last| now.duration_since(last) < duration && now < end);
    let mut token_counts = TokenCounts::default();
    let mut cost = 0.0;
    let mut models = Vec::new();
    let mut seen_models = HashSet::new();
    let mut usage_limit_reset_time = None;
    for entry in &entries {
        token_counts.add_usage(entry.data.message.usage);
        cost += entry.cost;
        if let Some(model) = &entry.model {
            if seen_models.insert(model.clone()) {
                models.push(model.clone());
            }
        }
        usage_limit_reset_time = usage_limit_reset_time.or(entry.usage_limit_reset_time);
    }
    SessionBlock {
        id: format_rfc3339_millis(start),
        start_time: start,
        end_time: end,
        actual_end_time: actual_end,
        is_active,
        is_gap: false,
        entries,
        token_counts,
        cost_usd: cost,
        models,
        usage_limit_reset_time,
    }
}

fn create_gap_block(last: TimestampMs, next: TimestampMs, duration: i64) -> SessionBlock {
    let start = last.checked_add_millis(duration).unwrap_or(last);
    SessionBlock {
        id: format!("gap-{}", format_rfc3339_millis(start)),
        start_time: start,
        end_time: next,
        actual_end_time: None,
        is_active: false,
        is_gap: true,
        entries: Vec::new(),
        token_counts: TokenCounts::default(),
        cost_usd: 0.0,
        models: Vec::new(),
        usage_limit_reset_time: None,
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

fn filter_blocks_by_date(blocks: &mut Vec<SessionBlock>, shared: &SharedArgs) {
    if shared.since.is_none() && shared.until.is_none() {
        return;
    }
    blocks.retain(|block| {
        let date = format_date(block.start_time, shared.timezone.as_deref()).replace('-', "");
        shared.since.as_ref().is_none_or(|since| &date >= since)
            && shared.until.as_ref().is_none_or(|until| &date <= until)
    });
}

fn sort_blocks(blocks: &mut [SessionBlock], order: &SortOrder) {
    blocks.sort_by_key(|block| block.start_time);
    if *order == SortOrder::Desc {
        blocks.reverse();
    }
}

fn block_json(block: &SessionBlock, token_limit: Option<&str>, max_tokens: u64) -> Value {
    let burn_rate = if block.is_active {
        calculate_burn_rate(block)
    } else {
        None
    };
    let projection = if block.is_active {
        project_block_usage(block)
    } else {
        None
    };
    let token_limit_status = projection.and_then(|projection| {
        let limit = token_limit.and_then(|_| parse_token_limit(token_limit, max_tokens))?;
        let percent = projection.total_tokens as f64 / limit as f64 * 100.0;
        Some(json!({
            "limit": limit,
            "projectedUsage": projection.total_tokens,
            "percentUsed": percent,
            "status": if projection.total_tokens > limit { "exceeds" } else if projection.total_tokens as f64 > limit as f64 * BLOCKS_WARNING_THRESHOLD { "warning" } else { "ok" },
        }))
    });
    let mut value = json!({
        "id": block.id,
        "startTime": format_rfc3339_millis(block.start_time),
        "endTime": format_rfc3339_millis(block.end_time),
        "actualEndTime": block.actual_end_time.map(format_rfc3339_millis),
        "isActive": block.is_active,
        "isGap": block.is_gap,
        "entries": block.entries.len(),
        "tokenCounts": {
            "inputTokens": block.token_counts.input_tokens,
            "outputTokens": block.token_counts.output_tokens,
            "cacheCreationInputTokens": block.token_counts.cache_creation_tokens,
            "cacheReadInputTokens": block.token_counts.cache_read_tokens,
        },
        "totalTokens": block.token_counts.total(),
        "costUSD": json_float(block.cost_usd),
        "models": block.models,
        "burnRate": burn_rate,
        "projection": projection,
    });
    if let Some(status) = token_limit_status {
        value["tokenLimitStatus"] = status;
    }
    if let Some(reset_time) = block.usage_limit_reset_time {
        value["usageLimitResetTime"] = json!(format_rfc3339_millis(reset_time));
    }
    value
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

#[derive(Clone, Copy, Eq, PartialEq)]
enum Align {
    Left,
    Right,
}

enum Color {
    Blue,
    Green,
    Grey,
    Red,
    Yellow,
}

struct SimpleTable<'a> {
    headers: Vec<String>,
    aligns: Vec<Align>,
    rows: Vec<Option<Vec<String>>>,
    shared: &'a SharedArgs,
    terminal_width: usize,
    compact_dates: bool,
}

impl<'a> SimpleTable<'a> {
    fn new(headers: Vec<&str>, aligns: Vec<Align>, shared: &'a SharedArgs) -> Self {
        Self {
            headers: headers.into_iter().map(str::to_string).collect(),
            aligns,
            rows: Vec::new(),
            shared,
            terminal_width: DEFAULT_TERMINAL_WIDTH,
            compact_dates: false,
        }
    }

    fn with_terminal_width(mut self, width: usize) -> Self {
        self.terminal_width = width;
        self
    }

    fn with_date_compaction(mut self, compact_dates: bool) -> Self {
        self.compact_dates = compact_dates;
        self
    }

    fn push(&mut self, row: Vec<String>) {
        self.rows.push(Some(row));
    }

    fn separator(&mut self) {
        self.rows.push(None);
    }

    fn column_count(&self) -> usize {
        self.headers.len()
    }

    fn print(&self) {
        let widths = self.column_widths();
        println!("{}", border('┌', '┬', '┐', &widths));
        for header_row in expand_multiline_row(&self.headers, self.headers.len(), &widths) {
            let header_row = header_row
                .iter()
                .map(|header| color(self.shared, header, Color::Blue))
                .collect::<Vec<_>>();
            println!("{}", table_line(&header_row, &self.aligns, &widths));
        }
        println!("{}", border('├', '┼', '┤', &widths));
        for (row_index, row) in self.rows.iter().enumerate() {
            match row {
                Some(row) => {
                    let row = self.compact_date_row(row, &widths);
                    for physical_row in expand_multiline_row(&row, self.headers.len(), &widths) {
                        println!("{}", table_line(&physical_row, &self.aligns, &widths));
                    }
                }
                None => println!("{}", border('├', '┼', '┤', &widths)),
            }
            if row.is_some()
                && row_index + 1 < self.rows.len()
                && !matches!(self.rows.get(row_index + 1), Some(None))
            {
                println!("{}", border('├', '┼', '┤', &widths));
            }
        }
        println!("{}", border('└', '┴', '┘', &widths));
    }

    fn column_widths(&self) -> Vec<usize> {
        let content_widths = self
            .headers
            .iter()
            .enumerate()
            .map(|(index, header)| {
                if index == 1 {
                    visible_width_sum(header)
                } else {
                    visible_width_max_line(header)
                }
            })
            .collect::<Vec<_>>();
        let mut content_widths = content_widths;
        for row in self.rows.iter().flatten() {
            for (index, cell) in row.iter().enumerate() {
                let cell_width = if index == 1 {
                    visible_width_sum(cell)
                } else {
                    visible_width_max_line(cell)
                };
                if let Some(width) = content_widths.get_mut(index) {
                    *width = (*width).max(cell_width);
                }
            }
        }
        let widths = content_widths
            .iter()
            .enumerate()
            .map(|(index, width)| {
                if self.aligns.get(index) == Some(&Align::Right) {
                    (width + 3).max(11)
                } else if index == 1 {
                    (width + 2).max(15)
                } else {
                    (width + 2).max(10)
                }
            })
            .collect::<Vec<_>>();
        let total_required = cli_table_required_width(&widths);
        let first_column_min = if self.compact_dates { 12 } else { 10 };
        let mut widths =
            fit_widths_to_terminal(widths, &self.aligns, self.terminal_width, first_column_min);
        if self.compact_dates && total_required > self.terminal_width {
            if let Some(width) = widths.first_mut() {
                *width = (*width).max(10);
            }
        }
        widths
    }

    fn compact_date_row(&self, row: &[String], widths: &[usize]) -> Vec<String> {
        if !self.compact_dates || widths.first().copied().unwrap_or_default() > 10 {
            return row.to_vec();
        }
        let mut row = row.to_vec();
        if let Some(first) = row.first_mut() {
            if let Some(compact) = compact_date_cell(first) {
                *first = compact;
            }
        }
        row
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

fn expand_multiline_row(row: &[String], column_count: usize, widths: &[usize]) -> Vec<Vec<String>> {
    let cells = (0..column_count)
        .map(|index| {
            let content_width = widths
                .get(index)
                .copied()
                .unwrap_or_default()
                .saturating_sub(2);
            row.get(index)
                .map(|cell| wrap_cell_lines(cell, content_width))
                .filter(|lines| !lines.is_empty())
                .unwrap_or_else(|| vec![String::new()])
        })
        .collect::<Vec<_>>();
    let height = cells.iter().map(Vec::len).max().unwrap_or(1);
    (0..height)
        .map(|line_index| {
            cells
                .iter()
                .map(|lines| lines.get(line_index).cloned().unwrap_or_default())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn fit_widths_to_terminal(
    mut widths: Vec<usize>,
    aligns: &[Align],
    terminal_width: usize,
    first_column_min: usize,
) -> Vec<usize> {
    if cli_table_required_width(&widths) <= terminal_width {
        return widths;
    }

    let minimums = widths
        .iter()
        .enumerate()
        .map(|(index, _)| {
            if aligns.get(index) == Some(&Align::Right) {
                10
            } else if index == 0 {
                first_column_min
            } else if index == 1 {
                12
            } else {
                8
            }
        })
        .collect::<Vec<_>>();

    let available_width = terminal_width.saturating_sub(widths.len() + 1);
    let total_content_width = widths.iter().sum::<usize>();
    if total_content_width > 0 {
        let scale = available_width as f64 / total_content_width as f64;
        for (index, width) in widths.iter_mut().enumerate() {
            let scaled = (*width as f64 * scale).floor() as usize;
            *width = scaled.max(minimums[index]);
        }
    }

    while cli_table_required_width(&widths) > terminal_width {
        let Some(index) = widths
            .iter()
            .enumerate()
            .filter(|(index, width)| **width > minimums[*index])
            .max_by_key(|(_, width)| **width)
            .map(|(index, _)| index)
        else {
            break;
        };
        widths[index] -= 1;
    }
    widths
}

fn cli_table_required_width(widths: &[usize]) -> usize {
    widths.iter().sum::<usize>() + widths.len() + 1
}

fn wrap_cell_lines(cell: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![String::new()];
    }
    let mut lines = Vec::new();
    for line in cell.lines() {
        if visible_width(line) <= width {
            lines.push(line.to_string());
            continue;
        }
        lines.extend(wrap_cell_line(line, width));
    }
    lines
}

fn wrap_cell_line(line: &str, width: usize) -> Vec<String> {
    if line.split_whitespace().count() <= 1 {
        return vec![truncate_visible(line, width)];
    }

    let mut lines = Vec::new();
    let mut current = String::new();
    for word in line.split_whitespace() {
        let candidate_width = if current.is_empty() {
            visible_width(word)
        } else {
            visible_width(&current) + 1 + visible_width(word)
        };
        if candidate_width <= width {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        } else {
            if !current.is_empty() {
                lines.push(current);
            }
            current = if visible_width(word) > width {
                truncate_visible(word, width)
            } else {
                word.to_string()
            };
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn truncate_visible(value: &str, width: usize) -> String {
    if visible_width(value) <= width {
        return value.to_string();
    }
    if width <= 1 {
        return "…".to_string();
    }
    let mut output = String::new();
    let mut current_width = 0;
    let mut index = 0;
    let bytes = value.as_bytes();
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            let start = index;
            index += 1;
            if index < bytes.len() && bytes[index] == b'[' {
                index += 1;
                while index < bytes.len() && !(bytes[index] as char).is_ascii_alphabetic() {
                    index += 1;
                }
                if index < bytes.len() {
                    index += 1;
                }
            }
            output.push_str(&value[start..index]);
            continue;
        }
        let Some(ch) = value[index..].chars().next() else {
            break;
        };
        let char_width = char_display_width(ch);
        if current_width + char_width >= width {
            break;
        }
        output.push(ch);
        current_width += char_width;
        index += ch.len_utf8();
    }
    if contains_ansi(value) && !output.ends_with("\x1b[0m") {
        output.push_str("\x1b[0m");
    }
    output.push('…');
    output
}

fn compact_date_cell(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        Some(format!("{}\n{}", &value[..4], &value[5..]))
    } else {
        None
    }
}

fn table_line(cells: &[String], aligns: &[Align], widths: &[usize]) -> String {
    let mut line = String::from("│");
    for (index, width) in widths.iter().enumerate() {
        let cell = cells.get(index).map(String::as_str).unwrap_or("");
        let align = if index == 0 && cell.starts_with("(assuming ") {
            Align::Right
        } else {
            aligns.get(index).copied().unwrap_or(Align::Left)
        };
        line.push(' ');
        line.push_str(&pad_cell(cell, width.saturating_sub(2), align));
        line.push(' ');
        line.push('│');
    }
    line
}

fn pad_cell(cell: &str, width: usize, align: Align) -> String {
    let visible = visible_width(cell);
    if visible >= width {
        return cell.to_string();
    }
    let padding = width - visible;
    match align {
        Align::Left => format!("{cell}{}", " ".repeat(padding)),
        Align::Right => format!("{}{cell}", " ".repeat(padding)),
    }
}

fn border(left: char, middle: char, right: char, widths: &[usize]) -> String {
    let mut line = String::new();
    line.push(left);
    for (index, width) in widths.iter().enumerate() {
        line.push_str(&"─".repeat(*width));
        line.push(if index + 1 == widths.len() {
            right
        } else {
            middle
        });
    }
    line
}

fn visible_width(value: &str) -> usize {
    let bytes = value.as_bytes();
    let mut width = 0;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == 0x1b {
            index += 1;
            if index < bytes.len() && bytes[index] == b'[' {
                index += 1;
                while index < bytes.len() && !(bytes[index] as char).is_ascii_alphabetic() {
                    index += 1;
                }
                index += usize::from(index < bytes.len());
            }
            continue;
        }
        let Some(ch) = value[index..].chars().next() else {
            break;
        };
        width += char_display_width(ch);
        index += ch.len_utf8();
    }
    width
}

fn contains_ansi(value: &str) -> bool {
    value.as_bytes().contains(&0x1b)
}

fn char_display_width(ch: char) -> usize {
    if ch.is_ascii() {
        1
    } else {
        2
    }
}

fn visible_width_max_line(value: &str) -> usize {
    value.lines().map(visible_width).max().unwrap_or_default()
}

fn visible_width_sum(value: &str) -> usize {
    value.lines().map(visible_width).sum()
}

fn terminal_width() -> usize {
    env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|width| *width > 0)
        .or_else(terminal_width_from_ioctl)
        .unwrap_or(DEFAULT_TERMINAL_WIDTH)
}

#[cfg(unix)]
fn terminal_width_from_ioctl() -> Option<usize> {
    if !io::stdout().is_terminal() {
        return None;
    }
    #[repr(C)]
    struct Winsize {
        rows: u16,
        cols: u16,
        xpixel: u16,
        ypixel: u16,
    }
    let mut size = Winsize {
        rows: 0,
        cols: 0,
        xpixel: 0,
        ypixel: 0,
    };
    let rc = unsafe { ioctl(io::stdout().as_raw_fd(), TIOCGWINSZ, &mut size) };
    if rc == 0 && size.cols > 0 {
        Some(size.cols as usize)
    } else {
        None
    }
}

#[cfg(not(unix))]
fn terminal_width_from_ioctl() -> Option<usize> {
    None
}

#[cfg(unix)]
extern "C" {
    fn ioctl(fd: i32, request: usize, ...) -> i32;
}

fn print_box_title(title: &str, shared: &SharedArgs) {
    if log_level() == Some(0) {
        return;
    }
    let content_width = visible_width(title).max(40) + 2;
    let padding = content_width.saturating_sub(visible_width(title));
    let left_padding = padding / 2;
    let right_padding = padding - left_padding;
    println!();
    println!("╭{}╮", "─".repeat(content_width + 2));
    println!("│{}│", " ".repeat(content_width + 2));
    println!(
        "│ {}{}{} │",
        " ".repeat(left_padding),
        color(shared, title, Color::Blue),
        " ".repeat(right_padding)
    );
    println!("│{}│", " ".repeat(content_width + 2));
    println!("╰{}╯", "─".repeat(content_width + 2));
    println!();
}

fn log_level() -> Option<u8> {
    env::var("LOG_LEVEL")
        .ok()
        .and_then(|value| value.parse::<u8>().ok())
}

fn color(shared: &SharedArgs, value: impl AsRef<str>, color: Color) -> String {
    let value = value.as_ref();
    if !use_color(shared) {
        return value.to_string();
    }
    let code = match color {
        Color::Blue => 34,
        Color::Green => 32,
        Color::Grey => 90,
        Color::Red => 31,
        Color::Yellow => 33,
    };
    format!("\x1b[{code}m{value}\x1b[0m")
}

fn use_color(shared: &SharedArgs) -> bool {
    if shared.no_color || env::var_os("NO_COLOR").is_some() {
        return false;
    }
    shared.color || env::var_os("FORCE_COLOR").is_some() || io::stdout().is_terminal()
}

fn format_block_models(models: &[String]) -> String {
    if models.is_empty() {
        "-".to_string()
    } else {
        format_models_multiline(models)
    }
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

fn parse_project_aliases(raw: Option<&str>) -> HashMap<String, String> {
    raw.unwrap_or_default()
        .split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            let value = value.trim();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some((key.to_string(), value.to_string()))
            }
        })
        .collect()
}

fn format_project_name(project: &str, aliases: &HashMap<String, String>) -> String {
    if let Some(alias) = aliases.get(project) {
        return alias.clone();
    }
    let parsed = parse_project_name(project);
    aliases.get(&parsed).cloned().unwrap_or(parsed)
}

fn parse_project_name(project: &str) -> String {
    if project.is_empty() || project == "unknown" {
        return "Unknown Project".to_string();
    }
    let mut cleaned = project.to_string();
    if cleaned.starts_with("-Users-") || cleaned.starts_with("/Users/") {
        let separator = if cleaned.starts_with("-Users-") {
            '-'
        } else {
            '/'
        };
        let segments = cleaned
            .split(separator)
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        if let Some(index) = segments.iter().position(|segment| *segment == "Users") {
            if index + 3 < segments.len() {
                cleaned = segments[index + 3..].join("-");
            }
        }
    } else {
        cleaned = cleaned
            .trim_matches(|ch| ch == '/' || ch == '\\' || ch == '-')
            .to_string();
    }
    if cleaned.split('-').count() >= 5
        && cleaned
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '-' || ch == '.')
    {
        let parts = cleaned.split('-').collect::<Vec<_>>();
        cleaned = parts[parts.len().saturating_sub(2)..].join("-");
    }
    if let Some((main, _)) = cleaned.split_once("--") {
        cleaned = main.to_string();
    }
    if cleaned.contains('-') && cleaned.len() > 20 {
        let meaningful = cleaned
            .split('-')
            .filter(|segment| {
                segment.len() > 2
                    && !matches!(
                        segment.to_ascii_lowercase().as_str(),
                        "dev"
                            | "development"
                            | "feat"
                            | "feature"
                            | "fix"
                            | "bug"
                            | "test"
                            | "staging"
                            | "prod"
                            | "production"
                            | "main"
                            | "master"
                            | "branch"
                    )
            })
            .collect::<Vec<_>>();
        if meaningful.len() >= 2 {
            let last_two = meaningful[meaningful.len() - 2..].join("-");
            cleaned = if last_two.len() >= 6 {
                last_two
            } else if meaningful.len() >= 3 {
                meaningful[meaningful.len() - 3..].join("-")
            } else {
                cleaned
            };
        }
    }
    let cleaned = cleaned.trim_matches(|ch| ch == '/' || ch == '\\' || ch == '-');
    if cleaned.is_empty() {
        project.to_string()
    } else {
        cleaned.to_string()
    }
}

fn short_model_name(model: &str) -> String {
    let model = model
        .strip_prefix("anthropic/claude-")
        .or_else(|| model.strip_prefix("claude-"))
        .unwrap_or(model);
    let parts = model.split('-').collect::<Vec<_>>();
    if parts.len() >= 3 && parts.last().is_some_and(|part| part.len() == 8) {
        return parts[..parts.len() - 1].join("-");
    }
    model.to_string()
}

fn format_block_time(block: &SessionBlock, compact: bool) -> String {
    let start = format_local_block_start(block.start_time, compact);
    if block.is_gap {
        let end = format_local_block_end(block.end_time, compact);
        let duration = block.end_time.duration_since(block.start_time) / MILLIS_PER_HOUR;
        return if compact {
            format!("{start}-{end}\n({duration}h gap)")
        } else {
            format!("{start} - {end} ({duration}h gap)")
        };
    }

    if block.is_active {
        let now = utc_now();
        let elapsed = now.duration_since(block.start_time) / MILLIS_PER_MINUTE;
        let remaining = block.end_time.duration_since(now) / MILLIS_PER_MINUTE;
        let elapsed_hours = elapsed / 60;
        let elapsed_minutes = elapsed.rem_euclid(60);
        let remaining_hours = remaining / 60;
        let remaining_minutes = remaining.rem_euclid(60);
        return if compact {
            format!("{start}\n({elapsed_hours}h{elapsed_minutes}m/{remaining_hours}h{remaining_minutes}m)")
        } else {
            format!(
                "{start} ({elapsed_hours}h {elapsed_minutes}m elapsed, {remaining_hours}h {remaining_minutes}m remaining)"
            )
        };
    }

    let duration = block
        .actual_end_time
        .map(|end| end.duration_since(block.start_time) / MILLIS_PER_MINUTE)
        .unwrap_or(0);
    let hours = duration / 60;
    let minutes = duration.rem_euclid(60);
    if compact {
        if hours > 0 {
            format!("{start}\n({hours}h{minutes}m)")
        } else {
            format!("{start}\n({minutes}m)")
        }
    } else if hours > 0 {
        format!("{start} ({hours}h {minutes}m)")
    } else {
        format!("{start} ({minutes}m)")
    }
}

fn format_local_block_start(timestamp: TimestampMs, compact: bool) -> String {
    let parts = local_parts(timestamp);
    if compact {
        format!(
            "{:02}/{:02}, {:02}:{:02} {}",
            parts.month,
            parts.day,
            hour_12(parts.hour),
            parts.minute,
            am_pm(parts.hour)
        )
    } else {
        format!(
            "{}/{}/{}, {}:{:02}:{:02} {}",
            parts.month,
            parts.day,
            parts.year,
            hour_12(parts.hour),
            parts.minute,
            parts.second,
            am_pm(parts.hour)
        )
    }
}

fn format_local_block_end(timestamp: TimestampMs, compact: bool) -> String {
    let parts = local_parts(timestamp);
    if compact {
        format!(
            "{:02}:{:02} {}",
            hour_12(parts.hour),
            parts.minute,
            am_pm(parts.hour)
        )
    } else {
        format_local_block_start(timestamp, false)
    }
}

fn print_blocks_table(
    blocks: &[SessionBlock],
    token_limit: Option<&str>,
    max_tokens: u64,
    shared: &SharedArgs,
) {
    if blocks.is_empty() {
        eprintln!("No Claude usage data found.");
        return;
    }
    let terminal_width = terminal_width();
    let compact = shared.compact || terminal_width < BLOCKS_COMPACT_WIDTH_THRESHOLD;
    let actual_limit = parse_token_limit(token_limit, max_tokens);
    print_box_title("Claude Code Token Usage Report - Session Blocks", shared);
    let mut headers = vec!["Block Start", "Duration/Status", "Models", "Tokens"];
    let mut aligns = vec![Align::Left, Align::Left, Align::Left, Align::Right];
    if actual_limit.is_some_and(|limit| limit > 0) {
        headers.push("%");
        aligns.push(Align::Right);
    }
    headers.push("Cost");
    aligns.push(Align::Right);
    let mut table = SimpleTable::new(headers, aligns, shared).with_terminal_width(terminal_width);
    for block in blocks {
        if block.is_gap {
            let mut row = vec![
                color(shared, format_block_time(block, compact), Color::Grey),
                color(shared, "(inactive)", Color::Grey),
                color(shared, "-", Color::Grey),
                color(shared, "-", Color::Grey),
            ];
            if actual_limit.is_some_and(|limit| limit > 0) {
                row.push(color(shared, "-", Color::Grey));
            }
            row.push(color(shared, "-", Color::Grey));
            table.push(row);
            continue;
        }
        let total = block.token_counts.total();
        let mut row = vec![
            format_block_time(block, compact),
            if block.is_active {
                color(shared, "ACTIVE", Color::Green)
            } else {
                String::new()
            },
            format_block_models(&block.models),
            format_number(total),
        ];
        if let Some(limit) = actual_limit.filter(|limit| *limit > 0) {
            let percentage = total as f64 / limit as f64 * 100.0;
            let percent_text = format!("{percentage:.1}%");
            row.push(if percentage > 100.0 {
                color(shared, percent_text, Color::Red)
            } else {
                percent_text
            });
        }
        row.push(format_currency(block.cost_usd));
        table.push(row);

        if block.is_active {
            if let Some(limit) = actual_limit.filter(|limit| *limit > 0) {
                table.separator();
                let remaining = limit.saturating_sub(total);
                let remaining_percent = (limit.saturating_sub(total) as f64 / limit as f64) * 100.0;
                let mut remaining_row = vec![
                    color(
                        shared,
                        format!("(assuming {} token limit)", format_number(limit)),
                        Color::Grey,
                    ),
                    color(shared, "REMAINING", Color::Blue),
                    String::new(),
                    if remaining > 0 {
                        format_number(remaining)
                    } else {
                        color(shared, "0", Color::Red)
                    },
                ];
                remaining_row.push(if remaining_percent > 0.0 {
                    format!("{remaining_percent:.1}%")
                } else {
                    color(shared, "0.0%", Color::Red)
                });
                remaining_row.push(String::new());
                table.push(remaining_row);
            }

            if let Some(projection) = project_block_usage(block) {
                table.separator();
                let mut projected_row = vec![
                    color(shared, "(assuming current burn rate)", Color::Grey),
                    color(shared, "PROJECTED", Color::Yellow),
                    String::new(),
                    match actual_limit {
                        Some(limit) if limit > 0 && projection.total_tokens > limit => {
                            color(shared, format_number(projection.total_tokens), Color::Red)
                        }
                        _ => format_number(projection.total_tokens),
                    },
                ];
                if let Some(limit) = actual_limit.filter(|limit| *limit > 0) {
                    let percentage = projection.total_tokens as f64 / limit as f64 * 100.0;
                    projected_row.push(format!("{percentage:.1}%"));
                }
                projected_row.push(format_currency(projection.total_cost));
                table.push(projected_row);
            }
        }
    }
    table.print();
}

fn print_active_block_detail(
    block: &SessionBlock,
    token_limit: Option<&str>,
    max_tokens: u64,
    shared: &SharedArgs,
) {
    print_box_title("Current Session Block Status", shared);
    let now = utc_now();
    let elapsed = now.duration_since(block.start_time) / MILLIS_PER_MINUTE;
    let remaining = block.end_time.duration_since(now) / MILLIS_PER_MINUTE;
    println!("Block Started:   {}", format_utc_second(block.start_time));
    println!(
        "Time Elapsed:    {}h {}m",
        elapsed / 60,
        elapsed.rem_euclid(60)
    );
    println!(
        "Time Remaining:  {}",
        color(
            shared,
            format!("{}h {}m", remaining / 60, remaining.rem_euclid(60)),
            Color::Green,
        )
    );
    println!();
    println!("{}", color(shared, "Current Usage:", Color::Blue));
    println!(
        "  Input Tokens:     {}",
        format_number(block.token_counts.input_tokens)
    );
    println!(
        "  Output Tokens:    {}",
        format_number(block.token_counts.output_tokens)
    );
    println!("  Total Cost:       {}", format_currency(block.cost_usd));

    if let Some(rate) = calculate_burn_rate(block) {
        println!();
        println!("{}", color(shared, "Burn Rate:", Color::Blue));
        println!(
            "  Tokens/minute:    {}",
            format_number(rate.tokens_per_minute.round() as u64)
        );
        println!(
            "  Cost/hour:        {}",
            format_currency(rate.cost_per_hour)
        );
    }

    if let Some(projection) = project_block_usage(block) {
        println!();
        println!(
            "{}",
            color(
                shared,
                "Projected Usage (if current rate continues):",
                Color::Blue
            )
        );
        println!(
            "  Total Tokens:     {}",
            format_number(projection.total_tokens)
        );
        println!(
            "  Total Cost:       {}",
            format_currency(projection.total_cost)
        );

        if let Some(limit) = parse_token_limit(token_limit, max_tokens) {
            let current = block.token_counts.total();
            let remaining_tokens = limit.saturating_sub(current);
            let percent = projection.total_tokens as f64 / limit as f64 * 100.0;
            let status = if projection.total_tokens > limit {
                color(shared, "EXCEEDS LIMIT", Color::Red)
            } else if projection.total_tokens as f64 > limit as f64 * BLOCKS_WARNING_THRESHOLD {
                color(shared, "WARNING", Color::Yellow)
            } else {
                color(shared, "OK", Color::Green)
            };
            println!();
            println!("{}", color(shared, "Token Limit Status:", Color::Blue));
            println!("  Limit:            {} tokens", format_number(limit));
            println!(
                "  Current Usage:    {} ({:.1}%)",
                format_number(current),
                current as f64 / limit as f64 * 100.0
            );
            println!(
                "  Remaining:        {} tokens",
                format_number(remaining_tokens)
            );
            println!("  Projected Usage:  {percent:.1}% {status}");
        }
    }
}

fn calculate_burn_rate(block: &SessionBlock) -> Option<BurnRate> {
    if block.entries.is_empty() || block.is_gap {
        return None;
    }
    let first = block.entries.first()?.timestamp;
    let last = block.entries.last()?.timestamp;
    let duration_minutes = last.duration_since(first) as f64 / MILLIS_PER_MINUTE as f64;
    if duration_minutes <= 0.0 {
        return None;
    }
    let total_tokens = block.token_counts.total() as f64;
    let non_cache = (block.token_counts.input_tokens + block.token_counts.output_tokens) as f64;
    Some(BurnRate {
        tokens_per_minute: total_tokens / duration_minutes,
        tokens_per_minute_for_indicator: non_cache / duration_minutes,
        cost_per_hour: block.cost_usd / duration_minutes * 60.0,
    })
}

fn project_block_usage(block: &SessionBlock) -> Option<Projection> {
    if !block.is_active || block.is_gap {
        return None;
    }
    let burn = calculate_burn_rate(block)?;
    let remaining_minutes =
        (block.end_time.duration_since(utc_now()) as f64 / MILLIS_PER_MINUTE as f64).round();
    let total_tokens =
        block.token_counts.total() as f64 + burn.tokens_per_minute * remaining_minutes;
    let total_cost = block.cost_usd + (burn.cost_per_hour / 60.0) * remaining_minutes;
    Some(Projection {
        total_tokens: total_tokens.round() as u64,
        total_cost: (total_cost * 100.0).round() / 100.0,
        remaining_minutes: remaining_minutes as u64,
    })
}

fn parse_token_limit(value: Option<&str>, max_tokens: u64) -> Option<u64> {
    match value {
        None | Some("") | Some("max") => (max_tokens > 0).then_some(max_tokens),
        Some(value) => value.parse().ok(),
    }
}

fn format_context(input_tokens: u64, context_limit: u64) -> String {
    let percentage = if context_limit == 0 {
        0
    } else {
        ((input_tokens as f64 / context_limit as f64) * 100.0).round() as u64
    };
    format!("{} ({}%)", format_number(input_tokens), percentage)
}

fn format_remaining_time(minutes: i64) -> String {
    let hours = minutes / 60;
    let mins = minutes % 60;
    if hours > 0 {
        format!("{hours}h {mins}m left")
    } else {
        format!("{mins}m left")
    }
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
