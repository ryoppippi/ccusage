use std::{
    collections::BTreeMap,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};

use jiff::tz::TimeZone as JiffTimeZone;
use rustc_hash::FxHasher;

use crate::{
    cli::{AgentReportKind, SharedArgs, WeekDay},
    fast::FxHashSet,
    format_date_tz, parse_ts_timestamp, parse_tz, wants_json, week_start, CodexGroup,
    CodexTokenUsageEvent, Result,
};

use super::{parser, paths};

type CodexEventKey = (crate::TimestampMs, u64, usize, u64, u64, u64, u64, u64);
type CodexDedupeShards = [Mutex<FxHashSet<CodexEventKey>>];

struct CodexAggregation {
    groups: BTreeMap<String, CodexGroup>,
    seen: FxHashSet<CodexEventKey>,
}

pub(super) fn load_groups(
    shared: &SharedArgs,
    kind: AgentReportKind,
) -> Result<BTreeMap<String, CodexGroup>> {
    let paths = paths::codex_usage_paths()?;
    if paths.len() == 1 && !wants_json(shared) {
        return load_groups_from_directory(&paths[0], shared, kind);
    }
    let mut groups = BTreeMap::new();
    let seen = create_dedupe_shards();
    for path in paths {
        merge_groups(
            &mut groups,
            load_groups_from_directory_with_dedupe(&path, shared, kind, &seen)?,
        );
    }
    Ok(groups)
}

pub(super) fn load_groups_from_directory(
    sessions_dir: &Path,
    shared: &SharedArgs,
    kind: AgentReportKind,
) -> Result<BTreeMap<String, CodexGroup>> {
    let mut files = Vec::new();
    crate::collect_usage_files(sessions_dir, &mut files);
    if shared.single_thread {
        return aggregate_files_local(sessions_dir, &files, shared, kind);
    }
    let seen = create_dedupe_shards();
    aggregate_files_parallel(sessions_dir, &files, shared, kind, &seen)
}

pub(super) fn load_groups_from_directory_with_dedupe(
    sessions_dir: &Path,
    shared: &SharedArgs,
    kind: AgentReportKind,
    seen: &CodexDedupeShards,
) -> Result<BTreeMap<String, CodexGroup>> {
    let mut files = Vec::new();
    crate::collect_usage_files(sessions_dir, &mut files);
    if shared.single_thread {
        return aggregate_files(sessions_dir, &files, shared, kind, seen);
    }
    aggregate_files_parallel(sessions_dir, &files, shared, kind, seen)
}

fn aggregate_files(
    sessions_dir: &Path,
    files: &[PathBuf],
    shared: &SharedArgs,
    kind: AgentReportKind,
    seen: &CodexDedupeShards,
) -> Result<BTreeMap<String, CodexGroup>> {
    let mut groups = BTreeMap::new();
    let timezone = parse_tz(shared.timezone.as_deref()).or_else(|| Some(JiffTimeZone::system()));
    for file in files {
        aggregate_file(
            sessions_dir,
            file,
            kind,
            timezone.as_ref(),
            shared,
            seen,
            &mut groups,
        )?;
    }
    Ok(groups)
}

fn aggregate_files_parallel(
    sessions_dir: &Path,
    files: &[PathBuf],
    shared: &SharedArgs,
    kind: AgentReportKind,
    seen: &CodexDedupeShards,
) -> Result<BTreeMap<String, CodexGroup>> {
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(files.len());
    if worker_count <= 1 {
        return aggregate_files(sessions_dir, files, shared, kind, seen);
    }

    let chunks = crate::chunk_file_indexes_by_size(files, worker_count);
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            handles.push(scope.spawn(move || {
                let mut groups = BTreeMap::new();
                let timezone =
                    parse_tz(shared.timezone.as_deref()).or_else(|| Some(JiffTimeZone::system()));
                for index in chunk {
                    aggregate_file(
                        sessions_dir,
                        &files[index],
                        kind,
                        timezone.as_ref(),
                        shared,
                        seen,
                        &mut groups,
                    )?;
                }
                Result::<BTreeMap<String, CodexGroup>>::Ok(groups)
            }));
        }

        let mut groups = BTreeMap::new();
        for handle in handles {
            merge_groups(
                &mut groups,
                handle
                    .join()
                    .map_err(|_| crate::cli_error("codex worker panicked"))??,
            );
        }
        Ok(groups)
    })
}

fn aggregate_file(
    sessions_dir: &Path,
    file: &Path,
    kind: AgentReportKind,
    timezone: Option<&JiffTimeZone>,
    shared: &SharedArgs,
    seen: &CodexDedupeShards,
    groups: &mut BTreeMap<String, CodexGroup>,
) -> Result<()> {
    parser::visit_codex_session_file(sessions_dir, file, |event| {
        add_event_to_groups(&event, kind, timezone, shared, seen, groups)
    })
}

fn aggregate_files_local(
    sessions_dir: &Path,
    files: &[PathBuf],
    shared: &SharedArgs,
    kind: AgentReportKind,
) -> Result<BTreeMap<String, CodexGroup>> {
    Ok(aggregate_files_local_with_seen(sessions_dir, files, shared, kind)?.groups)
}

fn aggregate_files_local_with_seen(
    sessions_dir: &Path,
    files: &[PathBuf],
    shared: &SharedArgs,
    kind: AgentReportKind,
) -> Result<CodexAggregation> {
    let mut aggregation = CodexAggregation {
        groups: BTreeMap::new(),
        seen: FxHashSet::default(),
    };
    let timezone = parse_tz(shared.timezone.as_deref()).or_else(|| Some(JiffTimeZone::system()));
    for file in files {
        aggregate_file_local(
            sessions_dir,
            file,
            kind,
            timezone.as_ref(),
            shared,
            &mut aggregation,
        )?;
    }
    Ok(aggregation)
}

fn aggregate_file_local(
    sessions_dir: &Path,
    file: &Path,
    kind: AgentReportKind,
    timezone: Option<&JiffTimeZone>,
    shared: &SharedArgs,
    aggregation: &mut CodexAggregation,
) -> Result<()> {
    parser::visit_codex_session_file(sessions_dir, file, |event| {
        add_event_to_groups_local(&event, kind, timezone, shared, aggregation)
    })
}

fn add_event_to_groups(
    event: &CodexTokenUsageEvent,
    kind: AgentReportKind,
    timezone: Option<&JiffTimeZone>,
    shared: &SharedArgs,
    seen: &CodexDedupeShards,
    groups: &mut BTreeMap<String, CodexGroup>,
) -> Result<()> {
    let Some(model) = event.model.as_deref().filter(|model| !model.is_empty()) else {
        return Ok(());
    };
    let timestamp = parse_ts_timestamp(&event.timestamp)
        .ok_or_else(|| crate::cli_error(format!("Invalid Codex timestamp: {}", event.timestamp)))?;
    if !insert_event_key(event, timestamp, model, seen) {
        return Ok(());
    }
    add_deduped_event_to_groups(event, model, timestamp, kind, timezone, shared, groups)
}

fn add_event_to_groups_local(
    event: &CodexTokenUsageEvent,
    kind: AgentReportKind,
    timezone: Option<&JiffTimeZone>,
    shared: &SharedArgs,
    aggregation: &mut CodexAggregation,
) -> Result<()> {
    let Some(model) = event.model.as_deref().filter(|model| !model.is_empty()) else {
        return Ok(());
    };
    let timestamp = parse_ts_timestamp(&event.timestamp)
        .ok_or_else(|| crate::cli_error(format!("Invalid Codex timestamp: {}", event.timestamp)))?;
    if !aggregation
        .seen
        .insert(codex_event_key(event, timestamp, model))
    {
        return Ok(());
    }
    add_deduped_event_to_groups(
        event,
        model,
        timestamp,
        kind,
        timezone,
        shared,
        &mut aggregation.groups,
    )
}

fn add_deduped_event_to_groups(
    event: &CodexTokenUsageEvent,
    model: &str,
    timestamp: crate::TimestampMs,
    kind: AgentReportKind,
    timezone: Option<&JiffTimeZone>,
    shared: &SharedArgs,
    groups: &mut BTreeMap<String, CodexGroup>,
) -> Result<()> {
    let date = format_date_tz(timestamp, timezone);
    if shared.since.is_some() || shared.until.is_some() {
        let date_key = date.replace('-', "");
        if shared.since.as_ref().is_some_and(|since| &date_key < since)
            || shared.until.as_ref().is_some_and(|until| &date_key > until)
        {
            return Ok(());
        }
    }
    let period = match kind {
        AgentReportKind::Daily => date,
        AgentReportKind::Weekly => week_start(&date, WeekDay::Monday).unwrap_or(date),
        AgentReportKind::Monthly => date[..7].to_string(),
        AgentReportKind::Session => event.session_id.clone(),
    };
    let group = groups.entry(period).or_default();
    accumulate_codex_event_into_group(group, event, model);
    Ok(())
}

fn accumulate_codex_event_into_group(
    group: &mut CodexGroup,
    event: &CodexTokenUsageEvent,
    model: &str,
) {
    group.input_tokens += event.input_tokens;
    group.cached_input_tokens += event.cached_input_tokens;
    group.output_tokens += event.output_tokens;
    group.reasoning_output_tokens += event.reasoning_output_tokens;
    group.total_tokens += event.total_tokens;
    if group
        .last_activity
        .as_deref()
        .is_none_or(|current| event.timestamp.as_str() > current)
    {
        group.last_activity = Some(event.timestamp.clone());
    }

    let model_usage = group.models.entry(model.to_string()).or_default();
    model_usage.input_tokens += event.input_tokens;
    model_usage.cached_input_tokens += event.cached_input_tokens;
    model_usage.output_tokens += event.output_tokens;
    model_usage.reasoning_output_tokens += event.reasoning_output_tokens;
    model_usage.total_tokens += event.total_tokens;
    model_usage.is_fallback |= event.is_fallback_model;
}

fn create_dedupe_shards() -> Vec<Mutex<FxHashSet<CodexEventKey>>> {
    let shard_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1);
    (0..shard_count.max(1))
        .map(|_| Mutex::new(FxHashSet::default()))
        .collect()
}

fn insert_event_key(
    event: &CodexTokenUsageEvent,
    timestamp: crate::TimestampMs,
    model: &str,
    seen: &CodexDedupeShards,
) -> bool {
    let key = codex_event_key(event, timestamp, model);
    let mut hasher = FxHasher::default();
    key.hash(&mut hasher);
    let shard_index = hasher.finish() as usize % seen.len();
    seen[shard_index].lock().unwrap().insert(key)
}

fn codex_event_key(
    event: &CodexTokenUsageEvent,
    timestamp: crate::TimestampMs,
    model: &str,
) -> CodexEventKey {
    (
        timestamp,
        hash_model_name(model),
        model.len(),
        event.input_tokens,
        event.cached_input_tokens,
        event.output_tokens,
        event.reasoning_output_tokens,
        event.total_tokens,
    )
}

fn hash_model_name(model: &str) -> u64 {
    let mut hasher = FxHasher::default();
    model.hash(&mut hasher);
    hasher.finish()
}

fn merge_groups(target: &mut BTreeMap<String, CodexGroup>, source: BTreeMap<String, CodexGroup>) {
    for (period, group) in source {
        let target_group = target.entry(period).or_default();
        target_group.input_tokens += group.input_tokens;
        target_group.cached_input_tokens += group.cached_input_tokens;
        target_group.output_tokens += group.output_tokens;
        target_group.reasoning_output_tokens += group.reasoning_output_tokens;
        target_group.total_tokens += group.total_tokens;
        if target_group.last_activity.as_deref().is_none_or(|current| {
            group
                .last_activity
                .as_deref()
                .is_some_and(|next| next > current)
        }) {
            target_group.last_activity = group.last_activity;
        }
        for (model, usage) in group.models {
            let target_usage = target_group.models.entry(model).or_default();
            target_usage.input_tokens += usage.input_tokens;
            target_usage.cached_input_tokens += usage.cached_input_tokens;
            target_usage.output_tokens += usage.output_tokens;
            target_usage.reasoning_output_tokens += usage.reasoning_output_tokens;
            target_usage.total_tokens += usage.total_tokens;
            target_usage.is_fallback |= usage.is_fallback;
        }
    }
}

pub(crate) fn aggregate_events(
    events: &[CodexTokenUsageEvent],
    kind: AgentReportKind,
    timezone: Option<&str>,
) -> Result<BTreeMap<String, CodexGroup>> {
    let mut groups = BTreeMap::new();
    let timezone = parse_tz(timezone).or_else(|| Some(JiffTimeZone::system()));
    for event in events {
        let Some(model) = event.model.as_deref().filter(|model| !model.is_empty()) else {
            continue;
        };
        let timestamp = parse_ts_timestamp(&event.timestamp).ok_or_else(|| {
            crate::cli_error(format!("Invalid Codex timestamp: {}", event.timestamp))
        })?;
        let date = format_date_tz(timestamp, timezone.as_ref());
        let period = match kind {
            AgentReportKind::Daily => date,
            AgentReportKind::Weekly => week_start(&date, WeekDay::Monday).unwrap_or(date),
            AgentReportKind::Monthly => date[..7].to_string(),
            AgentReportKind::Session => event.session_id.clone(),
        };
        let group = groups.entry(period).or_insert_with(CodexGroup::default);
        accumulate_codex_event_into_group(group, event, model);
    }
    Ok(groups)
}

pub(crate) fn filter_events_by_date(
    events: &mut Vec<CodexTokenUsageEvent>,
    shared: &SharedArgs,
) -> Result<()> {
    if shared.since.is_none() && shared.until.is_none() {
        return Ok(());
    }
    let timezone = parse_tz(shared.timezone.as_deref()).or_else(|| Some(JiffTimeZone::system()));
    let mut kept = Vec::with_capacity(events.len());
    for event in events.drain(..) {
        let timestamp = parse_ts_timestamp(&event.timestamp).ok_or_else(|| {
            crate::cli_error(format!("Invalid Codex timestamp: {}", event.timestamp))
        })?;
        let date = format_date_tz(timestamp, timezone.as_ref()).replace('-', "");
        if shared.since.as_ref().is_none_or(|since| &date >= since)
            && shared.until.as_ref().is_none_or(|until| &date <= until)
        {
            kept.push(event);
        }
    }
    *events = kept;
    Ok(())
}
