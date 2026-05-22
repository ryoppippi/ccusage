use std::{
    collections::BTreeMap,
    env, fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};

use jiff::tz::TimeZone as JiffTimeZone;
use rustc_hash::FxHasher;
use serde_json::{json, Value};

use crate::{
    cli::{AgentCommandArgs, AgentReportKind, CodexSpeed, SharedArgs, WeekDay},
    color,
    fast::FxHashSet,
    format_currency, format_date_tz, format_models_multiline, format_number, json_float, log_level,
    parse_ts_timestamp, parse_tz, print_box_title, print_json_or_jq, wants_json, week_start, Align,
    CodexGroup, CodexModelUsage, CodexTokenUsageEvent, Color, PricingMap, Result, SimpleTable,
};

type CodexEventKey = (crate::TimestampMs, u64, usize, u64, u64, u64, u64, u64);
type CodexDedupeShards = [Mutex<FxHashSet<CodexEventKey>>];

struct CodexAggregation {
    groups: BTreeMap<String, CodexGroup>,
    seen: FxHashSet<CodexEventKey>,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, log_level() != Some(0));
    let groups = load_groups(&shared, args.kind)?;
    let speed = resolve_codex_speed(args.codex_speed);
    if wants_json(&shared) {
        let output = report_from_groups(&groups, args.kind, &pricing, speed);
        return print_json_or_jq(output, shared.jq.as_deref());
    }
    print_table_from_groups(&groups, args.kind, &pricing, speed, &shared);
    Ok(())
}

#[cfg(test)]
pub(crate) fn report_json(
    events: &[CodexTokenUsageEvent],
    kind: AgentReportKind,
    timezone: Option<&str>,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> Result<Value> {
    let groups = aggregate_events(events, kind, timezone)?;
    Ok(report_from_groups(&groups, kind, pricing, speed))
}

fn report_from_groups(
    groups: &BTreeMap<String, CodexGroup>,
    kind: AgentReportKind,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> Value {
    let rows = groups
        .iter()
        .map(|(period, group)| group_json(period, group, kind, pricing, speed))
        .collect::<Vec<_>>();
    let totals = totals_json(groups.values(), pricing, speed);
    json!({
        rows_key(kind): rows,
        "totals": totals,
    })
}

pub(crate) fn resolve_codex_speed(requested: CodexSpeed) -> CodexSpeed {
    match requested {
        CodexSpeed::Auto => {
            if detect_codex_fast_service_tier() {
                CodexSpeed::Fast
            } else {
                CodexSpeed::Standard
            }
        }
        speed => speed,
    }
}

fn detect_codex_fast_service_tier() -> bool {
    codex_home_paths().iter().any(|path| {
        fs::read_to_string(path.join("config.toml"))
            .ok()
            .is_some_and(|content| codex_config_requests_fast_service_tier(&content))
    })
}

fn codex_home_paths() -> Vec<PathBuf> {
    if let Ok(paths) = env::var("CODEX_HOME") {
        return paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect();
    }
    crate::home::home_dir()
        .map(|home| vec![home.join(".codex")])
        .unwrap_or_default()
}

fn codex_config_requests_fast_service_tier(content: &str) -> bool {
    content.lines().any(|line| {
        let setting = line.split('#').next().unwrap_or_default().trim();
        setting.starts_with("service_tier")
            && (setting.contains("fast") || setting.contains("priority"))
    })
}

fn load_groups(shared: &SharedArgs, kind: AgentReportKind) -> Result<BTreeMap<String, CodexGroup>> {
    let paths = crate::codex_usage_paths()?;
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

fn load_groups_from_directory(
    sessions_dir: &Path,
    shared: &SharedArgs,
    kind: AgentReportKind,
) -> Result<BTreeMap<String, CodexGroup>> {
    let mut files = Vec::new();
    crate::collect_usage_files(sessions_dir, &mut files);
    if shared.single_thread {
        return aggregate_files_local(sessions_dir, &files, shared, kind);
    }
    aggregate_files_parallel_local(sessions_dir, &files, shared, kind)
}

fn load_groups_from_directory_with_dedupe(
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
    crate::visit_codex_session_file(sessions_dir, file, |event| {
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

fn aggregate_files_parallel_local(
    sessions_dir: &Path,
    files: &[PathBuf],
    shared: &SharedArgs,
    kind: AgentReportKind,
) -> Result<BTreeMap<String, CodexGroup>> {
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .saturating_mul(3)
        .min(files.len());
    if worker_count <= 1 {
        return aggregate_files_local(sessions_dir, files, shared, kind);
    }

    let chunks = crate::chunk_file_indexes_by_size(files, worker_count);
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            handles.push(scope.spawn(move || {
                let mut chunk_files = Vec::with_capacity(chunk.len());
                for index in chunk {
                    chunk_files.push(files[index].clone());
                }
                aggregate_files_local_with_seen(sessions_dir, &chunk_files, shared, kind)
            }));
        }

        let mut groups = BTreeMap::new();
        let mut seen = FxHashSet::default();
        for handle in handles {
            let partial = handle
                .join()
                .map_err(|_| crate::cli_error("codex worker panicked"))??;
            for key in partial.seen {
                if !seen.insert(key) {
                    let global_seen = create_dedupe_shards();
                    return aggregate_files(sessions_dir, files, shared, kind, &global_seen);
                }
            }
            merge_groups(&mut groups, partial.groups);
        }
        Ok(groups)
    })
}

fn aggregate_file_local(
    sessions_dir: &Path,
    file: &Path,
    kind: AgentReportKind,
    timezone: Option<&JiffTimeZone>,
    shared: &SharedArgs,
    aggregation: &mut CodexAggregation,
) -> Result<()> {
    crate::visit_codex_session_file(sessions_dir, file, |event| {
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

pub(crate) fn calculate_group_cost(
    group: &CodexGroup,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> f64 {
    group
        .models
        .iter()
        .map(|(model, usage)| calculate_codex_model_cost(model, usage, pricing, speed))
        .sum()
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

fn rows_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "daily",
        AgentReportKind::Weekly => "weekly",
        AgentReportKind::Monthly => "monthly",
        AgentReportKind::Session => "sessions",
    }
}

fn period_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "date",
        AgentReportKind::Weekly => "week",
        AgentReportKind::Monthly => "month",
        AgentReportKind::Session => "sessionId",
    }
}

fn group_json(
    period: &str,
    group: &CodexGroup,
    kind: AgentReportKind,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> Value {
    let cost = calculate_group_cost(group, pricing, speed);
    let input_tokens = non_cached_input_tokens(group.input_tokens, group.cached_input_tokens);
    let models = group
        .models
        .iter()
        .map(|(model, usage)| (model.clone(), model_usage_json(usage)))
        .collect::<BTreeMap<_, _>>();
    let mut row = json!({
        period_key(kind): period,
        "inputTokens": input_tokens,
        "cachedInputTokens": group.cached_input_tokens,
        "outputTokens": group.output_tokens,
        "reasoningOutputTokens": group.reasoning_output_tokens,
        "totalTokens": group.total_tokens,
        "costUSD": json_float(cost),
        "models": models,
    });
    if kind == AgentReportKind::Session {
        row["lastActivity"] = json!(group.last_activity);
        let separator = period.rfind('/');
        row["sessionFile"] = json!(separator.map_or(period, |index| &period[index + 1..]));
        row["directory"] = json!(separator.map_or("", |index| &period[..index]));
    }
    row
}

pub(crate) fn non_cached_input_tokens(input_tokens: u64, cached_input_tokens: u64) -> u64 {
    input_tokens.saturating_sub(cached_input_tokens)
}

fn model_usage_json(usage: &CodexModelUsage) -> Value {
    json!({
        "inputTokens": non_cached_input_tokens(usage.input_tokens, usage.cached_input_tokens),
        "cachedInputTokens": usage.cached_input_tokens,
        "outputTokens": usage.output_tokens,
        "reasoningOutputTokens": usage.reasoning_output_tokens,
        "totalTokens": usage.total_tokens,
        "isFallback": usage.is_fallback,
    })
}

fn totals_json<'a>(
    groups: impl Iterator<Item = &'a CodexGroup>,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> Value {
    let mut input = 0;
    let mut cached = 0;
    let mut output = 0;
    let mut reasoning = 0;
    let mut total = 0;
    let mut cost = 0.0;
    for group in groups {
        input += non_cached_input_tokens(group.input_tokens, group.cached_input_tokens);
        cached += group.cached_input_tokens;
        output += group.output_tokens;
        reasoning += group.reasoning_output_tokens;
        total += group.total_tokens;
        cost += calculate_group_cost(group, pricing, speed);
    }
    json!({
        "inputTokens": input,
        "cachedInputTokens": cached,
        "outputTokens": output,
        "reasoningOutputTokens": reasoning,
        "totalTokens": total,
        "costUSD": json_float(cost),
    })
}

pub(crate) fn calculate_codex_model_cost(
    model: &str,
    usage: &CodexModelUsage,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> f64 {
    let Some(pricing) = pricing.find(model) else {
        return 0.0;
    };
    let non_cached_input = usage.input_tokens.saturating_sub(usage.cached_input_tokens);
    let multiplier = if matches!(speed, CodexSpeed::Fast) {
        if pricing.fast_multiplier == 1.0 {
            2.0
        } else {
            pricing.fast_multiplier
        }
    } else {
        1.0
    };
    let cache_read = if pricing.cache_read_explicit {
        pricing.cache_read
    } else {
        pricing.input
    };
    (non_cached_input as f64 * pricing.input
        + usage.cached_input_tokens as f64 * cache_read
        + usage.output_tokens as f64 * pricing.output)
        * multiplier
}

fn print_table_from_groups(
    groups: &BTreeMap<String, CodexGroup>,
    kind: AgentReportKind,
    pricing: &PricingMap,
    speed: CodexSpeed,
    shared: &SharedArgs,
) {
    if groups.is_empty() {
        eprintln!("No Codex usage data found.");
        return;
    }
    let first_column = match kind {
        AgentReportKind::Daily => "Date",
        AgentReportKind::Weekly => "Week",
        AgentReportKind::Monthly => "Month",
        AgentReportKind::Session => "Session",
    };
    print_box_title(
        &format!(
            "Codex Token Usage Report - {}",
            match kind {
                AgentReportKind::Daily => "Daily",
                AgentReportKind::Weekly => "Weekly",
                AgentReportKind::Monthly => "Monthly",
                AgentReportKind::Session => "Session",
            }
        ),
        shared,
    );
    let mut table = SimpleTable::new(
        vec![
            first_column,
            "Models",
            "Input",
            "Output",
            "Reasoning",
            "Cache Read",
            "Total Tokens",
            "Cost (USD)",
        ],
        vec![
            Align::Left,
            Align::Left,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
        ],
        shared,
    )
    .with_date_compaction(true);
    let mut total_input = 0;
    let mut total_cached = 0;
    let mut total_output = 0;
    let mut total_reasoning = 0;
    let mut total_tokens = 0;
    let mut total_cost = 0.0;
    for (label, group) in groups {
        let input_tokens = non_cached_input_tokens(group.input_tokens, group.cached_input_tokens);
        let cost = calculate_group_cost(group, pricing, speed);
        total_input += input_tokens;
        total_cached += group.cached_input_tokens;
        total_output += group.output_tokens;
        total_reasoning += group.reasoning_output_tokens;
        total_tokens += group.total_tokens;
        total_cost += cost;
        let models = format_models_multiline(&group.models.keys().cloned().collect::<Vec<_>>());
        table.push(vec![
            label.clone(),
            models,
            format_number(input_tokens),
            format_number(group.output_tokens),
            format_number(group.reasoning_output_tokens),
            format_number(group.cached_input_tokens),
            format_number(group.total_tokens),
            format_currency(cost),
        ]);
    }
    table.separator();
    table.push(vec![
        color(shared, "Total", Color::Yellow),
        String::new(),
        color(shared, format_number(total_input), Color::Yellow),
        color(shared, format_number(total_output), Color::Yellow),
        color(shared, format_number(total_reasoning), Color::Yellow),
        color(shared, format_number(total_cached), Color::Yellow),
        color(shared, format_number(total_tokens), Color::Yellow),
        color(shared, format_currency(total_cost), Color::Yellow),
    ]);
    table.print();
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    #[test]
    fn loads_directory_groups_with_date_filter_without_global_event_vector() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("ccusage-codex-groups-{suffix}"));
        let sessions_dir = root.join("sessions");
        fs::create_dir_all(&sessions_dir).unwrap();
        fs::write(
            sessions_dir.join("session.jsonl"),
            [
                r#"{"timestamp":"2026-01-02T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":50,"reasoning_output_tokens":0,"total_tokens":150}}}}"#,
                r#"{"timestamp":"2026-01-03T00:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"model":"gpt-5","last_token_usage":{"input_tokens":200,"cached_input_tokens":20,"output_tokens":75,"reasoning_output_tokens":5,"total_tokens":280}}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let shared = SharedArgs {
            since: Some("20260103".to_string()),
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };

        let groups =
            load_groups_from_directory(&sessions_dir, &shared, AgentReportKind::Daily).unwrap();
        fs::remove_dir_all(root).unwrap();

        assert_eq!(groups.len(), 1);
        let group = groups.get("2026-01-03").unwrap();
        assert_eq!(group.input_tokens, 200);
        assert_eq!(group.cached_input_tokens, 20);
        assert_eq!(group.output_tokens, 75);
        assert_eq!(group.reasoning_output_tokens, 5);
        assert_eq!(group.total_tokens, 280);
    }

    #[test]
    fn reports_non_cached_codex_input_separately_from_cached_input() {
        let pricing = PricingMap::default();
        let report = report_json(
            &[CodexTokenUsageEvent {
                session_id: "session-1".to_string(),
                timestamp: "2026-01-02T00:00:00.000Z".to_string(),
                model: Some("gpt-5".to_string()),
                input_tokens: 100,
                cached_input_tokens: 90,
                output_tokens: 5,
                reasoning_output_tokens: 0,
                total_tokens: 105,
                is_fallback_model: false,
            }],
            AgentReportKind::Daily,
            Some("UTC"),
            &pricing,
            CodexSpeed::Standard,
        )
        .unwrap();

        assert_eq!(report["daily"][0]["inputTokens"], 10);
        assert_eq!(report["daily"][0]["cachedInputTokens"], 90);
        assert_eq!(report["daily"][0]["totalTokens"], 105);
        assert_eq!(report["totals"]["inputTokens"], 10);
        assert_eq!(report["totals"]["cachedInputTokens"], 90);
        assert_eq!(report["totals"]["totalTokens"], 105);
        assert_eq!(report["daily"][0]["models"]["gpt-5"]["inputTokens"], 10);
        assert_eq!(
            report["daily"][0]["models"]["gpt-5"]["cachedInputTokens"],
            90
        );
    }

    #[test]
    fn charges_cached_input_at_input_rate_when_codex_pricing_omits_cache_read_rate() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-test": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010
                }
            }"#,
        );
        let usage = CodexModelUsage {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 105,
            is_fallback: false,
        };

        let cost = calculate_codex_model_cost("gpt-test", &usage, &pricing, CodexSpeed::Standard);

        assert!((cost - 0.00015).abs() < f64::EPSILON);
    }

    #[test]
    fn applies_speed_option_to_codex_cost() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-5.3-codex": {
                    "input_cost_per_token": 0.00000175,
                    "output_cost_per_token": 0.000014,
                    "cache_read_input_token_cost": 0.000000175
                }
            }"#,
        );
        let usage = CodexModelUsage {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 5,
            reasoning_output_tokens: 0,
            total_tokens: 105,
            is_fallback: false,
        };

        let standard =
            calculate_codex_model_cost("gpt-5.3-codex", &usage, &pricing, CodexSpeed::Standard);
        let fast = calculate_codex_model_cost("gpt-5.3-codex", &usage, &pricing, CodexSpeed::Fast);

        assert!((fast - (standard * 2.0)).abs() < f64::EPSILON);
    }

    #[test]
    fn snapshots_codex_reports_for_periods_sessions_costs_and_fallback_models() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-5.3-codex": {
                    "input_cost_per_token": 0.00000175,
                    "output_cost_per_token": 0.000014,
                    "cache_read_input_token_cost": 0.000000175
                },
                "gpt-5-mini": {
                    "input_cost_per_token": 0.00000025,
                    "output_cost_per_token": 0.000002
                }
            }"#,
        );
        let events = vec![
            CodexTokenUsageEvent {
                session_id: "/workspace/api/session-a.jsonl".to_string(),
                timestamp: "2026-01-02T00:00:00.000Z".to_string(),
                model: Some("gpt-5.3-codex".to_string()),
                input_tokens: 140,
                cached_input_tokens: 40,
                output_tokens: 5,
                reasoning_output_tokens: 2,
                total_tokens: 147,
                is_fallback_model: false,
            },
            CodexTokenUsageEvent {
                session_id: "/workspace/api/session-a.jsonl".to_string(),
                timestamp: "2026-01-02T00:05:00.000Z".to_string(),
                model: Some("gpt-5.3-codex".to_string()),
                input_tokens: 70,
                cached_input_tokens: 70,
                output_tokens: 10,
                reasoning_output_tokens: 0,
                total_tokens: 80,
                is_fallback_model: true,
            },
            CodexTokenUsageEvent {
                session_id: "/workspace/web/session-b.jsonl".to_string(),
                timestamp: "2026-01-05T23:59:59.000Z".to_string(),
                model: Some("gpt-5-mini".to_string()),
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 2,
                reasoning_output_tokens: 0,
                total_tokens: 12,
                is_fallback_model: false,
            },
            CodexTokenUsageEvent {
                session_id: "ignored-missing-model".to_string(),
                timestamp: "2026-01-06T00:00:00.000Z".to_string(),
                model: None,
                input_tokens: 999,
                cached_input_tokens: 0,
                output_tokens: 999,
                reasoning_output_tokens: 0,
                total_tokens: 1_998,
                is_fallback_model: false,
            },
        ];

        insta::assert_json_snapshot!(serde_json::json!({
            "daily": report_json(
                &events,
                AgentReportKind::Daily,
                Some("UTC"),
                &pricing,
                CodexSpeed::Standard,
            )
            .unwrap(),
            "weekly": report_json(
                &events,
                AgentReportKind::Weekly,
                Some("UTC"),
                &pricing,
                CodexSpeed::Standard,
            )
            .unwrap(),
            "monthly": report_json(
                &events,
                AgentReportKind::Monthly,
                Some("UTC"),
                &pricing,
                CodexSpeed::Standard,
            )
            .unwrap(),
            "sessionFast": report_json(
                &events,
                AgentReportKind::Session,
                Some("UTC"),
                &pricing,
                CodexSpeed::Fast,
            )
            .unwrap(),
        }));
    }
}
