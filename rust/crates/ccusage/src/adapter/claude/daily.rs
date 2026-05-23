use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

use jiff::tz::TimeZone as JiffTimeZone;
use memchr::memmem;
use serde::Deserialize;

use crate::{
    calculate_cost_for_usage,
    cli::{CostMode, SharedArgs},
    fast::{byte_lines, suffix_string, FxHashMap, SmallIndexVec},
    format_date_tz, log_level, parse_ts_timestamp, parse_tz, ModelBreakdown, PricingMap, Result,
    Speed, TimestampMs, TokenCounts, TokenUsageRaw, UsageSummary,
};

use super::{
    chunk_file_indexes_by_size, has_unsupported_null_field, is_semver_prefix,
    paths::{claude_paths, extract_project, usage_files},
    usage_dedupe_hash,
};

pub(super) fn load_daily_summaries_inner(
    shared: &SharedArgs,
    project_filter: Option<&str>,
    group_by_project: bool,
) -> Result<Vec<UsageSummary>> {
    let paths = claude_paths()?;
    let files = usage_files(&paths, project_filter);
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
            .map(|file| read_daily_usage_file(file, tz.as_ref(), mode, pricing.as_ref()))
            .collect::<Vec<_>>()
    } else {
        read_daily_usage_files_parallel(&files, tz.as_ref(), mode, pricing.as_ref())
    };

    let mut deduped_indexes: FxHashMap<u64, SmallIndexVec> = FxHashMap::default();
    let mut deduped = Vec::with_capacity(loaded_files.iter().map(|file| file.entries.len()).sum());
    for loaded_file in loaded_files {
        for entry in loaded_file.entries {
            if let Some(filter) = project_filter {
                if entry.project.as_ref() != filter {
                    continue;
                }
            }
            push_deduped_daily_entry(entry, &mut deduped_indexes, &mut deduped);
        }
    }

    if group_by_project {
        let mut groups = BTreeMap::<(String, Arc<str>), DailyAccumulator>::new();
        for entry in &deduped {
            groups
                .entry((entry.date.clone(), Arc::clone(&entry.project)))
                .or_default()
                .add_entry(entry);
        }
        return Ok(groups
            .into_iter()
            .map(|((date, project), group)| {
                let mut summary = group.into_summary();
                summary.date = Some(date);
                summary.project = Some(project.to_string());
                summary
            })
            .collect());
    }

    let mut groups = BTreeMap::<String, DailyAccumulator>::new();
    for entry in &deduped {
        groups
            .entry(entry.date.clone())
            .or_default()
            .add_entry(entry);
    }
    Ok(groups
        .into_iter()
        .map(|(key, group)| {
            let mut summary = group.into_summary();
            summary.date = Some(key);
            summary
        })
        .collect())
}

#[derive(Debug)]
struct DailyLoadedFile {
    timestamp: Option<TimestampMs>,
    entries: Vec<DailyLoadedEntry>,
}

#[derive(Debug)]
struct DailyLoadedEntry {
    date: String,
    project: Arc<str>,
    usage: TokenUsageRaw,
    cost: f64,
    model: Option<String>,
    message_id: Option<String>,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DailyUsageEntry {
    timestamp: String,
    message: DailyUsageMessage,
    version: Option<String>,
    session_id: Option<String>,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum DailyUsageLine {
    Direct(DailyUsageEntry),
    AgentProgress(DailyAgentProgressEntry),
}

impl DailyUsageLine {
    fn into_entry(self) -> DailyUsageEntry {
        match self {
            DailyUsageLine::Direct(entry) => entry,
            DailyUsageLine::AgentProgress(entry) => DailyUsageEntry {
                timestamp: entry.data.message.timestamp,
                message: entry.data.message.message,
                version: None,
                session_id: None,
                cost_usd: entry.data.message.cost_usd,
                request_id: entry.data.message.request_id,
            },
        }
    }
}

#[derive(Debug, Deserialize)]
struct DailyAgentProgressEntry {
    data: DailyAgentProgressData,
}

#[derive(Debug, Deserialize)]
struct DailyAgentProgressData {
    message: DailyAgentProgressMessage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DailyAgentProgressMessage {
    timestamp: String,
    message: DailyUsageMessage,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DailyUsageMessage {
    usage: TokenUsageRaw,
    model: Option<String>,
    id: Option<String>,
}

fn read_daily_usage_files_parallel(
    files: &[PathBuf],
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Vec<DailyLoadedFile> {
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(files.len());
    if worker_count <= 1 {
        return files
            .iter()
            .map(|file| read_daily_usage_file(file, tz, mode, pricing))
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
                            read_daily_usage_file(&files[index], tz.as_ref(), mode, pricing),
                        )
                    })
                    .collect::<Vec<_>>()
            }));
        }
        let mut loaded_files = Vec::with_capacity(files.len());
        loaded_files.resize_with(files.len(), || None);
        for (index, file) in handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("daily usage worker panicked"))
        {
            loaded_files[index] = Some(file);
        }
        loaded_files
            .into_iter()
            .map(|file| file.expect("daily usage worker returned every file"))
            .collect()
    })
}

fn read_daily_usage_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> DailyLoadedFile {
    let project: Arc<str> = Arc::from(extract_project(path));
    let mut loaded_file = DailyLoadedFile {
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
        let Ok(data) = serde_json::from_slice::<DailyUsageLine>(line) else {
            continue;
        };
        let data = data.into_entry();
        let Some(timestamp) = parse_ts_timestamp(&data.timestamp) else {
            continue;
        };
        loaded_file.timestamp = Some(
            loaded_file
                .timestamp
                .map_or(timestamp, |current| current.min(timestamp)),
        );
        if !is_valid_daily_usage_entry(&data) {
            continue;
        }
        let usage = data.message.usage;
        let cost = calculate_cost_for_usage(
            data.message.model.as_deref(),
            usage,
            data.cost_usd,
            mode,
            pricing,
        );
        let model = data.message.model.as_ref().and_then(|model| {
            if model == "<synthetic>" {
                None
            } else if matches!(usage.speed, Some(Speed::Fast)) {
                Some(suffix_string(model, "-fast"))
            } else {
                Some(model.clone())
            }
        });
        loaded_file.entries.push(DailyLoadedEntry {
            date: format_date_tz(timestamp, tz),
            project: Arc::clone(&project),
            usage,
            cost,
            model,
            message_id: data.message.id,
            request_id: data.request_id,
        });
    }
    loaded_file
}

fn is_valid_daily_usage_entry(data: &DailyUsageEntry) -> bool {
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
fn daily_usage_token_total(entry: &DailyLoadedEntry) -> u64 {
    entry.usage.input_tokens
        + entry.usage.output_tokens
        + entry.usage.cache_creation_input_tokens
        + entry.usage.cache_read_input_tokens
}

fn push_deduped_daily_entry(
    entry: DailyLoadedEntry,
    deduped_indexes: &mut FxHashMap<u64, SmallIndexVec>,
    deduped: &mut Vec<DailyLoadedEntry>,
) {
    let dedupe_lookup = entry.message_id.as_deref().map(|message_id| {
        let request_id = entry.request_id.as_deref();
        let hash = usage_dedupe_hash(message_id, request_id);
        let existing_index = deduped_indexes.get(&hash).and_then(|indexes| {
            indexes.iter().copied().find(|&index| {
                deduped[index].message_id.as_deref() == Some(message_id)
                    && deduped[index].request_id.as_deref() == request_id
            })
        });
        (hash, existing_index)
    });

    if let Some((_, Some(index))) = dedupe_lookup {
        let candidate_total = daily_usage_token_total(&entry);
        let existing_total = daily_usage_token_total(&deduped[index]);
        let should_replace = if candidate_total != existing_total {
            candidate_total > existing_total
        } else if entry.cost != deduped[index].cost {
            entry.cost > deduped[index].cost
        } else {
            entry.usage.speed.is_some() && deduped[index].usage.speed.is_none()
        };
        if should_replace {
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

#[derive(Default)]
struct DailyAccumulator {
    counts: TokenCounts,
    cost: f64,
    models: Vec<String>,
    breakdowns: Vec<ModelBreakdown>,
    breakdown_indexes: FxHashMap<String, usize>,
}

impl DailyAccumulator {
    fn add_entry(&mut self, entry: &DailyLoadedEntry) {
        self.counts.add_usage(entry.usage);
        self.cost += entry.cost;
        if let Some(model) = &entry.model {
            let index = if let Some(index) = self.breakdown_indexes.get(model.as_str()) {
                *index
            } else {
                let index = self.breakdowns.len();
                self.breakdown_indexes.insert(model.clone(), index);
                self.models.push(model.clone());
                self.breakdowns.push(ModelBreakdown {
                    model_name: model.clone(),
                    ..ModelBreakdown::default()
                });
                index
            };
            let breakdown = &mut self.breakdowns[index];
            breakdown.input_tokens += entry.usage.input_tokens;
            breakdown.output_tokens += entry.usage.output_tokens;
            breakdown.cache_creation_tokens += entry.usage.cache_creation_input_tokens;
            breakdown.cache_read_tokens += entry.usage.cache_read_input_tokens;
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
            extra_total_tokens: 0,
            total_cost: self.cost,
            credits: None,
            message_count: None,
            models_used: self.models,
            model_breakdowns: self.breakdowns,
            project: None,
            versions: None,
        }
    }
}
