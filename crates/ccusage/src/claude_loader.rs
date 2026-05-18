use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::{
    cli::SharedArgs, cli_error, home, parse_ts_timestamp, LoadedEntry, Result, TimestampMs,
};

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

pub(crate) fn claude_paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
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
        return Err(cli_error(
            "No valid Claude data directories found in CLAUDE_CONFIG_DIR",
        ));
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
        return Err(cli_error("No valid Claude data directories found"));
    }
    Ok(paths)
}

pub(crate) fn usage_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for path in paths {
        collect_usage_files(&path.join("projects"), &mut files);
    }
    files
}

pub(crate) fn collect_usage_files(dir: &Path, files: &mut Vec<PathBuf>) {
    collect_files_with_extension(dir, "jsonl", files);
}

pub(crate) fn collect_files_with_extension(dir: &Path, extension: &str, files: &mut Vec<PathBuf>) {
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

pub(crate) fn timestamp_from_line(line: &str) -> Option<TimestampMs> {
    let start = line.find("\"timestamp\":\"")? + "\"timestamp\":\"".len();
    let end = line[start..].find('"')? + start;
    parse_ts_timestamp(&line[start..end])
}

pub(crate) fn earliest_timestamp_from_line(line: &str) -> Option<TimestampMs> {
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

pub(crate) fn extract_project(path: &Path) -> String {
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

pub(crate) fn extract_session_parts(path: &Path) -> (String, String) {
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

pub(crate) fn usage_limit_reset_time_from_line(
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
