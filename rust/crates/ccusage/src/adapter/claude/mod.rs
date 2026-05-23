mod daily;
mod paths;

use std::{
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

use jiff::tz::TimeZone as JiffTimeZone;
use memchr::memmem;
use rustc_hash::FxHasher;

use crate::{
    calculate_cost,
    cli::{CostMode, SharedArgs},
    debug_log,
    fast::{byte_lines, suffix_string, FxHashMap, SmallIndexVec},
    format_date_tz, log_level, parse_ts_timestamp, parse_tz, progress, LoadedEntry, LoadedFile,
    PricingMap, Result, Speed, TimestampMs, UsageEntry, UsageSummary,
};

#[cfg(test)]
pub(crate) use paths::timestamp_from_line;
pub(crate) use paths::{
    claude_paths, collect_files_with_extension, collect_usage_files, extract_project,
    extract_session_parts, usage_files,
};

pub(crate) fn load_entries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    progress::track_usage_load(progress::UsageLoadAgent::Claude, shared.json, || {
        load_entries_inner(shared, project_filter)
    })
}

pub(crate) fn load_daily_summaries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    progress::track_usage_load(progress::UsageLoadAgent::Claude, shared.json, || {
        daily::load_daily_summaries_inner(shared, project_filter, group_by_project)
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
    let files = usage_files(&paths, project_filter);
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
    let loaded_files = if shared.single_thread {
        files
            .iter()
            .map(|file| read_usage_file(file, tz.as_ref(), mode, pricing.as_ref()))
            .collect::<Vec<_>>()
    } else {
        read_usage_files_parallel(&files, tz.as_ref(), mode, pricing.as_ref())
    };
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

    let mut deduped_indexes: FxHashMap<u64, SmallIndexVec> = FxHashMap::default();
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

pub(crate) fn filter_loaded_entries_by_date(entries: &mut Vec<LoadedEntry>, shared: &SharedArgs) {
    if shared.since.is_none() && shared.until.is_none() {
        return;
    }
    entries.retain(|entry| {
        let date = entry.date.replace('-', "");
        shared.since.as_ref().is_none_or(|since| &date >= since)
            && shared.until.as_ref().is_none_or(|until| &date <= until)
    });
}

pub(crate) fn chunk_file_indexes_by_size(files: &[PathBuf], chunk_count: usize) -> Vec<Vec<usize>> {
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
    deduped_indexes: &mut FxHashMap<u64, SmallIndexVec>,
    deduped: &mut Vec<LoadedEntry>,
) {
    let dedupe_lookup = entry.data.message.id.as_deref().map(|message_id| {
        let request_id = entry.data.request_id.as_deref();
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

fn usage_dedupe_hash(message_id: &str, request_id: Option<&str>) -> u64 {
    let mut hasher = FxHasher::default();
    message_id.hash(&mut hasher);
    request_id.hash(&mut hasher);
    hasher.finish()
}

fn loaded_entry_matches_dedupe_key(
    entry: &LoadedEntry,
    message_id: &str,
    request_id: Option<&str>,
) -> bool {
    entry.data.message.id.as_deref() == Some(message_id)
        && entry.data.request_id.as_deref() == request_id
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
        timestamp: None,
        entries: Vec::new(),
    };
    let Ok(content) = fs::read(path) else {
        return loaded_file;
    };

    let usage_marker = memmem::Finder::new(br#""usage":{"#);
    for line in byte_lines(&content) {
        if usage_marker.find(line).is_none() {
            continue;
        }
        if has_unsupported_null_field(line) {
            continue;
        }
        let Ok(data) = serde_json::from_slice::<UsageEntry>(line) else {
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
            usage_limit_reset_time_from_line_bytes(line, data.is_api_error_message);
        let model = data.message.model.as_ref().and_then(|model| {
            if model == "<synthetic>" {
                None
            } else if matches!(data.message.usage.speed, Some(Speed::Fast)) {
                Some(suffix_string(model, "-fast"))
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
            extra_total_tokens: 0,
            credits: None,
            message_count: None,
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

pub(super) fn is_valid_usage_entry(data: &UsageEntry) -> bool {
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

pub(super) fn has_unsupported_null_field(line: &[u8]) -> bool {
    let mut offset = 0;
    while let Some(relative_index) = memmem::find(&line[offset..], b":null") {
        let null_index = offset + relative_index;
        let mut field_end = null_index.saturating_sub(1);
        if line.get(field_end) != Some(&b'"') {
            while field_end > 0 && line[field_end] != b'"' {
                field_end -= 1;
            }
        }
        if line.get(field_end) == Some(&b'"') {
            let mut field_start = field_end.saturating_sub(1);
            while field_start > 0 && line[field_start] != b'"' {
                field_start -= 1;
            }
            if line.get(field_start) == Some(&b'"')
                && is_unsupported_nullable_field(&line[field_start + 1..field_end])
            {
                return true;
            }
        }
        offset = null_index + b":null".len();
    }
    false
}

fn is_unsupported_nullable_field(field: &[u8]) -> bool {
    static FIELDS: phf::Set<&'static str> = phf::phf_set! {
        "id",
        "cwd",
        "model",
        "speed",
        "costUSD",
        "version",
        "sessionId",
        "requestId",
        "isApiErrorMessage",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    };

    std::str::from_utf8(field).is_ok_and(|field| FIELDS.contains(field))
}

pub(super) fn is_semver_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    if !consume_ascii_digits(bytes, &mut index) || bytes.get(index) != Some(&b'.') {
        return false;
    }
    index += 1;
    if !consume_ascii_digits(bytes, &mut index) || bytes.get(index) != Some(&b'.') {
        return false;
    }
    index += 1;
    bytes.get(index).is_some_and(u8::is_ascii_digit)
}

fn consume_ascii_digits(bytes: &[u8], index: &mut usize) -> bool {
    let start = *index;
    while bytes.get(*index).is_some_and(u8::is_ascii_digit) {
        *index += 1;
    }
    *index > start
}

#[cfg(test)]
pub(crate) fn usage_limit_reset_time_from_line(
    line: &str,
    is_api_error_message: Option<bool>,
) -> Option<TimestampMs> {
    usage_limit_reset_time_from_line_bytes(line.as_bytes(), is_api_error_message)
}

fn usage_limit_reset_time_from_line_bytes(
    line: &[u8],
    is_api_error_message: Option<bool>,
) -> Option<TimestampMs> {
    if is_api_error_message != Some(true) {
        return None;
    }
    let marker = b"Claude AI usage limit reached";
    let marker_start = memmem::find(line, marker)?;
    let timestamp_start = memchr::memchr(b'|', &line[marker_start..])? + marker_start + 1;
    let timestamp_end = line[timestamp_start..]
        .iter()
        .position(|byte| !byte.is_ascii_digit())
        .map_or(line.len(), |offset| timestamp_start + offset);
    if timestamp_start == timestamp_end {
        return None;
    }
    let timestamp = std::str::from_utf8(&line[timestamp_start..timestamp_end])
        .ok()?
        .parse::<i64>()
        .ok()?;
    if timestamp <= 0 {
        return None;
    }
    TimestampMs::from_unix_seconds(timestamp)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use super::{
        extract_session_parts, has_unsupported_null_field, paths::is_project_path_segment,
        usage_files,
    };

    fn temp_claude_dir(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("ccusage-claude-loader-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn limits_usage_file_discovery_to_requested_project() {
        let dir = temp_claude_dir("project-filter");
        let project_a = dir.join("projects/project-a/session-a");
        let project_b = dir.join("projects/project-b/session-b");
        fs::create_dir_all(&project_a).unwrap();
        fs::create_dir_all(&project_b).unwrap();
        fs::write(project_a.join("a.jsonl"), "{}").unwrap();
        fs::write(project_b.join("b.jsonl"), "{}").unwrap();

        let files = usage_files(std::slice::from_ref(&dir), Some("project-a"));
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(files.len(), 1);
        assert!(files[0].to_string_lossy().contains("project-a"));
    }

    #[test]
    fn falls_back_to_full_discovery_for_non_segment_project_filter() {
        let dir = temp_claude_dir("project-filter-fallback");
        let project_a = dir.join("projects/project-a/session-a");
        let project_b = dir.join("projects/project-b/session-b");
        fs::create_dir_all(&project_a).unwrap();
        fs::create_dir_all(&project_b).unwrap();
        fs::write(project_a.join("a.jsonl"), "{}").unwrap();
        fs::write(project_b.join("b.jsonl"), "{}").unwrap();

        let files = usage_files(std::slice::from_ref(&dir), Some("project-a/session-a"));
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(files.len(), 2);
    }

    #[test]
    fn rejects_dot_segments_as_project_path_segments() {
        assert!(!is_project_path_segment(""));
        assert!(!is_project_path_segment("."));
        assert!(!is_project_path_segment(".."));
        assert!(!is_project_path_segment("project-a/session-a"));
        assert!(!is_project_path_segment("project-a\\session-a"));
        assert!(is_project_path_segment("project-a"));
    }

    #[test]
    fn extracts_file_session_from_modern_claude_project_path() {
        let (session_id, project_path) = extract_session_parts(Path::new(
            "/home/me/.claude/projects/project-a/session-a.jsonl",
        ));

        assert_eq!(session_id, "session-a");
        assert_eq!(project_path, "project-a");
    }

    #[test]
    fn extracts_parent_session_from_nested_claude_project_path() {
        let (session_id, project_path) = extract_session_parts(Path::new(
            "/home/me/.claude/projects/project-a/session-a/chat.jsonl",
        ));

        assert_eq!(session_id, "session-a");
        assert_eq!(project_path, "project-a");
    }

    #[test]
    fn extracts_parent_session_from_claude_subagent_path() {
        let (session_id, project_path) = extract_session_parts(Path::new(
            "/home/me/.claude/projects/project-a/session-a/subagents/worker.jsonl",
        ));

        assert_eq!(session_id, "session-a");
        assert_eq!(project_path, "project-a");
    }

    #[test]
    fn rejects_null_schema_fields_like_typescript_loader() {
        assert!(has_unsupported_null_field(
            br#"{"message":{"usage":{"speed":null}}}"#
        ));
        assert!(has_unsupported_null_field(
            br#"{"message":{"model":null,"usage":{"input_tokens":0}}}"#
        ));
        assert!(has_unsupported_null_field(
            br#"{"sessionId":null,"message":{"usage":{"input_tokens":0}}}"#
        ));
    }

    #[test]
    fn allows_null_content_like_typescript_loader() {
        assert!(!has_unsupported_null_field(
            br#"{"message":{"content":null,"usage":{"input_tokens":0}}}"#
        ));
    }
}
