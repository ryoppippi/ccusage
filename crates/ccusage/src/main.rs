use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env, fs,
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::fd::AsRawFd;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, NaiveDate, TimeZone, Timelike, Utc};
use clap::Parser;
use jiff::{tz::TimeZone as JiffTimeZone, Timestamp as JiffTimestamp};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod cli;

use cli::{
    BlocksArgs, Cli, Command, CostMode, CostSource, DailyArgs, SessionArgs, SharedArgs, SortOrder,
    StatuslineArgs, VisualBurnRate, WeekDay, WeeklyArgs,
};

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEntry {
    session_id: Option<String>,
    timestamp: String,
    version: Option<String>,
    message: UsageMessage,
    #[serde(rename = "costUSD")]
    cost_usd: Option<f64>,
    request_id: Option<String>,
    is_api_error_message: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct UsageMessage {
    usage: TokenUsageRaw,
    model: Option<String>,
    id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
struct TokenUsageRaw {
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    speed: Option<Speed>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Speed {
    Standard,
    Fast,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenCounts {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
}

impl TokenCounts {
    fn add_usage(&mut self, usage: TokenUsageRaw) {
        self.input_tokens += usage.input_tokens;
        self.output_tokens += usage.output_tokens;
        self.cache_creation_tokens += usage.cache_creation_input_tokens;
        self.cache_read_tokens += usage.cache_read_input_tokens;
    }

    fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_creation_tokens + self.cache_read_tokens
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelBreakdown {
    model_name: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    cost: f64,
}

#[derive(Debug, Clone)]
struct LoadedEntry {
    data: UsageEntry,
    timestamp: DateTime<Utc>,
    date: String,
    project: String,
    session_id: String,
    project_path: String,
    cost: f64,
    model: Option<String>,
    usage_limit_reset_time: Option<DateTime<Utc>>,
}

#[derive(Debug)]
struct LoadedFile {
    path: PathBuf,
    timestamp: Option<DateTime<Utc>>,
    entries: Vec<LoadedEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    month: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    week: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_activity: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_cost: f64,
    models_used: Vec<String>,
    model_breakdowns: Vec<ModelBreakdown>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    versions: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct SessionBlock {
    id: String,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
    actual_end_time: Option<DateTime<Utc>>,
    is_active: bool,
    is_gap: bool,
    entries: Vec<LoadedEntry>,
    token_counts: TokenCounts,
    cost_usd: f64,
    models: Vec<String>,
    usage_limit_reset_time: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct BurnRate {
    tokens_per_minute: f64,
    tokens_per_minute_for_indicator: f64,
    cost_per_hour: f64,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Projection {
    total_tokens: u64,
    total_cost: f64,
    remaining_minutes: u64,
}

#[derive(Debug, Clone, Copy)]
struct Pricing {
    input: f64,
    output: f64,
    cache_create: f64,
    cache_read: f64,
    input_above_200k: Option<f64>,
    output_above_200k: Option<f64>,
    cache_create_above_200k: Option<f64>,
    cache_read_above_200k: Option<f64>,
    fast_multiplier: f64,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Daily(args)) => run_daily(args),
        Some(Command::Monthly(shared)) => run_bucket(shared, BucketKind::Monthly),
        Some(Command::Weekly(args)) => run_weekly(args),
        Some(Command::Session(args)) => run_session(args),
        Some(Command::Blocks(args)) => run_blocks(args),
        Some(Command::Statusline(args)) => run_statusline(args),
        None => {
            let args = DailyArgs {
                shared: cli.shared,
                instances: false,
                project: None,
                project_aliases: None,
            };
            run_daily(args)
        }
    }
}

fn run_daily(args: DailyArgs) -> Result<()> {
    let shared = args.shared.clone();
    let entries = load_entries(&shared, args.project.as_deref())?;
    let mut rows = summarize_by_key(
        &entries,
        |entry| {
            if args.instances || args.project.is_some() {
                format!("{}\0{}", entry.date, entry.project)
            } else {
                entry.date.clone()
            }
        },
        |key| {
            let mut parts = key.split('\0');
            (
                parts.next().unwrap_or_default().to_string(),
                parts.next().map(str::to_string),
            )
        },
    )?;
    filter_and_sort_summaries(&mut rows, &shared, |row| {
        row.date.as_deref().unwrap_or_default()
    });

    if wants_json(&shared) {
        if args.instances && rows.iter().any(|row| row.project.is_some()) {
            let output = json!({
                "projects": group_project_output(&rows),
                "totals": totals_json(&rows),
            });
            print_json_or_jq(output, shared.jq.as_deref())?;
        } else {
            let output = json!({
                "daily": rows.iter().map(summary_json).collect::<Vec<_>>(),
                "totals": totals_json(&rows),
            });
            print_json_or_jq(output, shared.jq.as_deref())?;
        }
        return Ok(());
    }

    print_usage_table(
        "Claude Code Token Usage Report - Daily",
        "Date",
        &rows,
        &shared,
        args.instances,
        args.project_aliases.as_deref(),
    );
    Ok(())
}

fn run_bucket(shared: SharedArgs, kind: BucketKind) -> Result<()> {
    let entries = load_entries(&shared, None)?;
    let mut daily = summarize_by_key(
        &entries,
        |entry| entry.date.clone(),
        |key| (key.to_string(), None),
    )?;
    filter_and_sort_summaries(&mut daily, &shared, |row| {
        row.date.as_deref().unwrap_or_default()
    });

    let mut buckets = summarize_summaries_by_bucket(&daily, kind, WeekDay::Sunday);
    sort_summaries(&mut buckets, &shared.order, |row| match kind {
        BucketKind::Monthly => row.month.as_deref().unwrap_or_default(),
        BucketKind::Weekly => row.week.as_deref().unwrap_or_default(),
    });

    if wants_json(&shared) {
        let key = match kind {
            BucketKind::Monthly => "monthly",
            BucketKind::Weekly => "weekly",
        };
        let output = json!({
            key: buckets.iter().map(summary_json).collect::<Vec<_>>(),
            "totals": totals_json(&buckets),
        });
        print_json_or_jq(output, shared.jq.as_deref())?;
        return Ok(());
    }

    let (title, col) = match kind {
        BucketKind::Monthly => ("Claude Code Token Usage Report - Monthly", "Month"),
        BucketKind::Weekly => ("Claude Code Token Usage Report - Weekly", "Week"),
    };
    print_usage_table(title, col, &buckets, &shared, false, None);
    Ok(())
}

fn run_weekly(args: WeeklyArgs) -> Result<()> {
    let shared = args.shared.clone();
    let entries = load_entries(&shared, None)?;
    let mut daily = summarize_by_key(
        &entries,
        |entry| entry.date.clone(),
        |key| (key.to_string(), None),
    )?;
    filter_and_sort_summaries(&mut daily, &shared, |row| {
        row.date.as_deref().unwrap_or_default()
    });
    let mut weekly = summarize_summaries_by_bucket(&daily, BucketKind::Weekly, args.start_of_week);
    sort_summaries(&mut weekly, &shared.order, |row| {
        row.week.as_deref().unwrap_or_default()
    });

    if wants_json(&shared) {
        let output = json!({
            "weekly": weekly.iter().map(summary_json).collect::<Vec<_>>(),
            "totals": totals_json(&weekly),
        });
        print_json_or_jq(output, shared.jq.as_deref())?;
        return Ok(());
    }

    print_usage_table(
        "Claude Code Token Usage Report - Weekly",
        "Week",
        &weekly,
        &shared,
        false,
        None,
    );
    Ok(())
}

fn run_session(args: SessionArgs) -> Result<()> {
    let shared = args.shared.clone();
    if let Some(id) = args.id {
        return run_session_id(&id, &shared);
    }

    let mut session_shared = shared.clone();
    session_shared.order = SortOrder::Desc;
    let entries = load_entries(&session_shared, None)?;
    let mut grouped = Vec::<(String, Vec<&LoadedEntry>)>::new();
    let mut group_indexes = HashMap::<String, usize>::new();
    for entry in &entries {
        let key = format!("{}/{}", entry.project_path, entry.session_id);
        let index = *group_indexes.entry(key.clone()).or_insert_with(|| {
            let index = grouped.len();
            grouped.push((key, Vec::new()));
            index
        });
        grouped[index].1.push(entry);
    }

    let mut rows = Vec::with_capacity(grouped.len());
    for (_, group) in grouped {
        let latest = group
            .iter()
            .max_by_key(|entry| entry.timestamp)
            .context("empty session group")?;
        let mut summary = aggregate_entries(&group);
        summary.session_id = Some(latest.session_id.clone());
        summary.project_path = Some(latest.project_path.clone());
        summary.last_activity = Some(format_date(
            latest.timestamp,
            session_shared.timezone.as_deref(),
        ));
        let versions = group
            .iter()
            .filter_map(|entry| entry.data.version.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        summary.versions = Some(versions);
        rows.push(summary);
    }
    filter_and_sort_summaries(&mut rows, &session_shared, |row| {
        row.last_activity.as_deref().unwrap_or_default()
    });

    if wants_json(&session_shared) {
        let output = json!({
            "sessions": rows.iter().map(session_summary_json).collect::<Vec<_>>(),
            "totals": totals_json(&rows),
        });
        print_json_or_jq(output, session_shared.jq.as_deref())?;
        return Ok(());
    }

    print_usage_table(
        "Claude Code Token Usage Report - By Session",
        "Session",
        &rows,
        &session_shared,
        false,
        None,
    );
    Ok(())
}

fn run_session_id(id: &str, shared: &SharedArgs) -> Result<()> {
    let entries = load_entries(shared, None)?;
    let mut session_entries = entries
        .into_iter()
        .filter(|entry| entry.data.session_id.as_deref() == Some(id) || entry.session_id == id)
        .collect::<Vec<_>>();
    session_entries.sort_by_key(|entry| entry.timestamp);

    if session_entries.is_empty() {
        if wants_json(shared) {
            println!("null");
        } else {
            eprintln!("No session found with ID: {id}");
        }
        return Ok(());
    }

    let total_cost = session_entries.iter().map(|entry| entry.cost).sum::<f64>();
    let total_tokens = session_entries
        .iter()
        .map(|entry| total_usage_tokens(entry.data.message.usage))
        .sum::<u64>();

    if wants_json(shared) {
        let output = json!({
            "sessionId": id,
            "totalCost": total_cost,
            "totalTokens": total_tokens,
            "entries": session_entries.iter().map(|entry| json!({
                "timestamp": entry.data.timestamp,
                "inputTokens": entry.data.message.usage.input_tokens,
                "outputTokens": entry.data.message.usage.output_tokens,
                "cacheCreationTokens": entry.data.message.usage.cache_creation_input_tokens,
                "cacheReadTokens": entry.data.message.usage.cache_read_input_tokens,
                "model": entry.data.message.model.as_deref().unwrap_or("unknown"),
                "costUSD": entry.data.cost_usd.unwrap_or(0.0),
            })).collect::<Vec<_>>(),
        });
        print_json_or_jq(output, shared.jq.as_deref())?;
        return Ok(());
    }

    println!("Claude Code Session Usage - {id}");
    println!("Total Cost: {}", format_currency(total_cost));
    println!("Total Tokens: {}", format_number(total_tokens));
    println!("Total Entries: {}", session_entries.len());
    Ok(())
}

fn run_blocks(args: BlocksArgs) -> Result<()> {
    if args.session_length <= 0.0 {
        bail!("Session length must be a positive number");
    }
    let shared = args.shared.clone();
    let entries = load_entries(&shared, None)?;
    let mut blocks = identify_session_blocks(entries, args.session_length);
    filter_blocks_by_date(&mut blocks, &shared);
    sort_blocks(&mut blocks, &shared.order);

    if args.recent {
        let cutoff = Utc::now() - chrono::Duration::days(DEFAULT_RECENT_DAYS);
        blocks.retain(|block| block.start_time >= cutoff || block.is_active);
    }

    if args.active {
        blocks.retain(|block| block.is_active);
    }

    let max_tokens = blocks
        .iter()
        .filter(|block| !block.is_gap && !block.is_active)
        .map(|block| block.token_counts.total())
        .max()
        .unwrap_or(0);

    if wants_json(&shared) {
        let output = json!({
            "blocks": blocks.iter().map(|block| block_json(block, args.token_limit.as_deref(), max_tokens)).collect::<Vec<_>>(),
        });
        print_json_or_jq(output, shared.jq.as_deref())?;
        return Ok(());
    }

    if args.active && blocks.is_empty() {
        println!("No active session block found.");
        return Ok(());
    }
    if args.active && blocks.len() == 1 {
        print_active_block_detail(&blocks[0], args.token_limit.as_deref(), max_tokens, &shared);
        return Ok(());
    }
    print_blocks_table(&blocks, args.token_limit.as_deref(), max_tokens, &shared);
    Ok(())
}

fn run_statusline(args: StatuslineArgs) -> Result<()> {
    if args.context_low_threshold >= args.context_medium_threshold {
        bail!(
            "Context low threshold ({}) must be less than medium threshold ({})",
            args.context_low_threshold,
            args.context_medium_threshold
        );
    }

    let mut stdin = String::new();
    io::stdin().read_to_string(&mut stdin)?;
    if stdin.trim().is_empty() {
        println!("❌ No input provided");
        return Ok(());
    }

    let hook: StatuslineHook =
        serde_json::from_str(stdin.trim()).context("Invalid input format")?;
    let shared = SharedArgs {
        offline: args.offline && !args.no_offline,
        ..SharedArgs::default()
    };

    let session_cost = match args.cost_source {
        CostSource::Cc => hook.cost.as_ref().map(|cost| cost.total_cost_usd),
        CostSource::Ccusage => calculate_session_cost(&hook.session_id, &shared).ok(),
        CostSource::Auto => hook
            .cost
            .as_ref()
            .map(|cost| cost.total_cost_usd)
            .or_else(|| calculate_session_cost(&hook.session_id, &shared).ok()),
        CostSource::Both => None,
    };

    let ccusage_cost = if args.cost_source == CostSource::Both {
        calculate_session_cost(&hook.session_id, &shared).ok()
    } else {
        None
    };
    let cc_cost = if args.cost_source == CostSource::Both {
        hook.cost.as_ref().map(|cost| cost.total_cost_usd)
    } else {
        None
    };

    let today = Utc::now().format("%Y%m%d").to_string();
    let today_shared = SharedArgs {
        since: Some(today.clone()),
        until: Some(today),
        offline: shared.offline,
        ..SharedArgs::default()
    };
    let today_cost = load_entries(&today_shared, None)
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    entry.date.replace('-', "") == today_shared.since.as_deref().unwrap_or_default()
                })
                .map(|entry| entry.cost)
                .sum::<f64>()
        })
        .unwrap_or(0.0);

    let blocks = load_entries(&shared, None)
        .map(|entries| identify_session_blocks(entries, DEFAULT_SESSION_DURATION_HOURS))
        .unwrap_or_default();
    let active_block = blocks.iter().find(|block| block.is_active && !block.is_gap);
    let (block_info, burn_rate_info) = if let Some(block) = active_block {
        let remaining = (block.end_time - Utc::now()).num_minutes().max(0);
        let mut burn = String::new();
        if let Some(rate) = calculate_burn_rate(block) {
            let mut segments = vec![format!("{}/hr", format_currency(rate.cost_per_hour))];
            let status = if rate.tokens_per_minute_for_indicator < 2000.0 {
                ("🟢", "Normal")
            } else if rate.tokens_per_minute_for_indicator < 5000.0 {
                ("⚠️", "Moderate")
            } else {
                ("🚨", "High")
            };
            if matches!(
                args.visual_burn_rate,
                VisualBurnRate::Emoji | VisualBurnRate::EmojiText
            ) {
                segments.push(status.0.to_string());
            }
            if matches!(
                args.visual_burn_rate,
                VisualBurnRate::Text | VisualBurnRate::EmojiText
            ) {
                segments.push(format!("({})", status.1));
            }
            burn = format!(" | 🔥 {}", segments.join(" "));
        }
        (
            format!(
                "{} block ({})",
                format_currency(block.cost_usd),
                format_remaining_time(remaining)
            ),
            burn,
        )
    } else {
        ("No active block".to_string(), String::new())
    };

    let context_info = hook
        .context_window
        .as_ref()
        .map(|context| format_context(context.total_input_tokens, context.context_window_size));

    let session_display = if args.cost_source == CostSource::Both {
        format!(
            "({} cc / {} ccusage)",
            cc_cost
                .map(format_currency)
                .unwrap_or_else(|| "N/A".to_string()),
            ccusage_cost
                .map(format_currency)
                .unwrap_or_else(|| "N/A".to_string())
        )
    } else {
        session_cost
            .map(format_currency)
            .unwrap_or_else(|| "N/A".to_string())
    };

    println!(
        "🤖 {} | 💰 {} session / {} today / {}{} | 🧠 {}",
        hook.model.display_name,
        session_display,
        format_currency(today_cost),
        block_info,
        burn_rate_info,
        context_info.unwrap_or_else(|| "N/A".to_string())
    );
    Ok(())
}

fn calculate_session_cost(session_id: &str, shared: &SharedArgs) -> Result<f64> {
    Ok(load_entries(shared, None)?
        .into_iter()
        .filter(|entry| {
            entry.data.session_id.as_deref() == Some(session_id) || entry.session_id == session_id
        })
        .map(|entry| entry.cost)
        .sum())
}

fn load_entries(shared: &SharedArgs, project_filter: Option<&str>) -> Result<Vec<LoadedEntry>> {
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

    let tz = parse_tz(shared.timezone.as_deref());
    let mode = shared.mode;
    let mut loaded_files = if shared.single_thread {
        files
            .iter()
            .map(|file| read_usage_file(file, tz.as_ref(), mode))
            .collect::<Vec<_>>()
    } else {
        files
            .par_iter()
            .map(|file| read_usage_file(file, tz.as_ref(), mode))
            .collect::<Vec<_>>()
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

    let mut deduped_indexes: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<LoadedEntry> =
        Vec::with_capacity(loaded_files.iter().map(|file| file.entries.len()).sum());
    for loaded_file in loaded_files {
        for entry in loaded_file.entries {
            if let Some(filter) = project_filter {
                if entry.project != filter {
                    continue;
                }
            }
            if let (Some(message_id), Some(request_id)) =
                (&entry.data.message.id, &entry.data.request_id)
            {
                let key = format!("{message_id}:{request_id}");
                if let Some(index) = deduped_indexes.get(&key).copied() {
                    if should_replace_deduped_entry(&entry.data, &deduped[index].data) {
                        deduped[index] = entry;
                    }
                    continue;
                }
                deduped_indexes.insert(key, deduped.len());
            }
            deduped.push(entry);
        }
    }
    debug_log(
        shared,
        format!("Kept {} usage entries after deduplication", deduped.len()),
    );
    Ok(deduped)
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

fn read_usage_file(path: &Path, tz: Option<&JiffTimeZone>, mode: CostMode) -> LoadedFile {
    let project = extract_project(path);
    let (session_id, project_path) = extract_session_parts(path);
    let mut loaded_file = LoadedFile {
        path: path.to_path_buf(),
        timestamp: None,
        entries: Vec::new(),
    };
    let Ok(content) = fs::read_to_string(path) else {
        return loaded_file;
    };

    for line in content.lines() {
        if !line.contains("\"input_tokens\"") {
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
        let Ok(timestamp) = DateTime::parse_from_rfc3339(&data.timestamp) else {
            continue;
        };
        let timestamp = timestamp.with_timezone(&Utc);
        update_loaded_file_timestamp(&mut loaded_file, timestamp);
        if !is_valid_usage_entry(&data) || !is_ts_timestamp(&data.timestamp) {
            continue;
        }
        let date = format_date_tz(timestamp, tz);
        let cost = calculate_cost(&data, mode);
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
            project: project.clone(),
            session_id: session_id.clone(),
            project_path: project_path.clone(),
            cost,
            model,
            usage_limit_reset_time,
        });
    }
    loaded_file
}

fn update_loaded_file_timestamp(loaded_file: &mut LoadedFile, timestamp: DateTime<Utc>) {
    loaded_file.timestamp = Some(
        loaded_file
            .timestamp
            .map_or(timestamp, |current| current.min(timestamp)),
    );
}

fn is_ts_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    let valid_base = bytes.len() == 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'Z'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[17..19].iter().all(u8::is_ascii_digit);
    let valid_millis = bytes.len() == 24
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[14..16].iter().all(u8::is_ascii_digit)
        && bytes[17..19].iter().all(u8::is_ascii_digit)
        && bytes[20..23].iter().all(u8::is_ascii_digit);
    valid_base || valid_millis
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

    let home = env::var("HOME").context("HOME is not set")?;
    let xdg = env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(&home).join(".config"));
    for path in [xdg.join("claude"), PathBuf::from(home).join(".claude")] {
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
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            files.push(path);
        } else if file_type.is_dir() {
            collect_usage_files(&path, files);
        }
    }
}

fn timestamp_from_line(line: &str) -> Option<DateTime<Utc>> {
    let start = line.find("\"timestamp\":\"")? + "\"timestamp\":\"".len();
    let end = line[start..].find('"')? + start;
    DateTime::parse_from_rfc3339(&line[start..end])
        .ok()
        .and_then(|value| DateTime::from_timestamp_millis(value.timestamp_millis()))
}

fn earliest_timestamp_from_line(line: &str) -> Option<DateTime<Utc>> {
    if let Some(timestamp) = timestamp_from_line(line) {
        return Some(timestamp);
    }
    if !line.contains("\"timestamp\"") {
        return None;
    }
    let value = serde_json::from_str::<Value>(line).ok()?;
    let timestamp = value.get("timestamp")?.as_str()?;
    DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .and_then(|value| DateTime::from_timestamp_millis(value.timestamp_millis()))
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

fn parse_tz(timezone: Option<&str>) -> Option<JiffTimeZone> {
    timezone.and_then(|value| JiffTimeZone::get(value).ok())
}

fn format_date(timestamp: DateTime<Utc>, timezone: Option<&str>) -> String {
    format_date_tz(timestamp, parse_tz(timezone).as_ref())
}

fn format_date_tz(timestamp: DateTime<Utc>, timezone: Option<&JiffTimeZone>) -> String {
    let Ok(timestamp) = JiffTimestamp::from_millisecond(timestamp.timestamp_millis()) else {
        return timestamp.format("%Y-%m-%d").to_string();
    };
    let timezone = timezone.cloned().unwrap_or_else(JiffTimeZone::system);
    timestamp
        .to_zoned(timezone)
        .strftime("%Y-%m-%d")
        .to_string()
}

fn calculate_cost(data: &UsageEntry, mode: CostMode) -> f64 {
    match mode {
        CostMode::Display => data.cost_usd.unwrap_or(0.0),
        CostMode::Auto => data
            .cost_usd
            .unwrap_or_else(|| calculate_cost_from_tokens(data)),
        CostMode::Calculate => calculate_cost_from_tokens(data),
    }
}

fn calculate_cost_from_tokens(data: &UsageEntry) -> f64 {
    let Some(model) = data.message.model.as_deref() else {
        return 0.0;
    };
    let Some(pricing) = pricing_for_model(model) else {
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

fn pricing_for_model(model: &str) -> Option<Pricing> {
    let normalized = model
        .strip_prefix("anthropic/")
        .or_else(|| model.strip_prefix("claude-"))
        .unwrap_or(model);
    let model = if model.starts_with("claude-") {
        model
    } else {
        normalized
    };
    if model.contains("opus-4-5") || model.contains("opus-4-6") || model.contains("opus-4-7") {
        Some(Pricing {
            input: 5e-6,
            output: 25e-6,
            cache_create: 6.25e-6,
            cache_read: 0.5e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: if model.contains("opus-4-6") || model.contains("opus-4-7") {
                6.0
            } else {
                1.0
            },
        })
    } else if model.contains("haiku-4-5") {
        Some(Pricing {
            input: 1e-6,
            output: 5e-6,
            cache_create: 1.25e-6,
            cache_read: 0.1e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("opus-4") {
        Some(Pricing {
            input: 15e-6,
            output: 75e-6,
            cache_create: 18.75e-6,
            cache_read: 1.5e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("sonnet-4-6") {
        Some(Pricing {
            input: 3e-6,
            output: 15e-6,
            cache_create: 3.75e-6,
            cache_read: 0.3e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("sonnet-4") {
        Some(Pricing {
            input: 3e-6,
            output: 15e-6,
            cache_create: 3.75e-6,
            cache_read: 0.3e-6,
            input_above_200k: Some(6e-6),
            output_above_200k: Some(22.5e-6),
            cache_create_above_200k: Some(7.5e-6),
            cache_read_above_200k: Some(0.6e-6),
            fast_multiplier: 1.0,
        })
    } else if model.contains("haiku-4") || model.contains("haiku-3-5") {
        Some(Pricing {
            input: 0.8e-6,
            output: 4e-6,
            cache_create: 1.0e-6,
            cache_read: 0.08e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("opus-3") {
        Some(Pricing {
            input: 15e-6,
            output: 75e-6,
            cache_create: 18.75e-6,
            cache_read: 1.5e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("sonnet-3") {
        Some(Pricing {
            input: 3e-6,
            output: 15e-6,
            cache_create: 3.75e-6,
            cache_read: 0.3e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else if model.contains("haiku-3") {
        Some(Pricing {
            input: 0.25e-6,
            output: 1.25e-6,
            cache_create: 0.3e-6,
            cache_read: 0.03e-6,
            input_above_200k: None,
            output_above_200k: None,
            cache_create_above_200k: None,
            cache_read_above_200k: None,
            fast_multiplier: 1.0,
        })
    } else {
        None
    }
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
    let mut groups: BTreeMap<String, Vec<&LoadedEntry>> = BTreeMap::new();
    for entry in entries {
        groups.entry(key_fn(entry)).or_default().push(entry);
    }

    let mut rows = Vec::with_capacity(groups.len());
    for (key, group) in groups {
        let (date, project) = meta_fn(&key);
        let mut summary = aggregate_entries(&group);
        summary.date = Some(date);
        summary.project = project;
        rows.push(summary);
    }
    Ok(rows)
}

fn aggregate_entries(entries: &[&LoadedEntry]) -> UsageSummary {
    let mut counts = TokenCounts::default();
    let mut cost = 0.0;
    let mut models = Vec::new();
    let mut seen_models = HashSet::new();
    let mut breakdowns = Vec::<ModelBreakdown>::new();
    let mut breakdown_indexes = HashMap::<String, usize>::new();

    for entry in entries {
        let usage = entry.data.message.usage;
        counts.add_usage(usage);
        cost += entry.cost;
        if let Some(model) = &entry.model {
            if seen_models.insert(model.clone()) {
                models.push(model.clone());
            }
            let index = *breakdown_indexes.entry(model.clone()).or_insert_with(|| {
                let index = breakdowns.len();
                breakdowns.push(ModelBreakdown {
                    model_name: model.clone(),
                    ..ModelBreakdown::default()
                });
                index
            });
            let breakdown = &mut breakdowns[index];
            breakdown.input_tokens += usage.input_tokens;
            breakdown.output_tokens += usage.output_tokens;
            breakdown.cache_creation_tokens += usage.cache_creation_input_tokens;
            breakdown.cache_read_tokens += usage.cache_read_input_tokens;
            breakdown.cost += entry.cost;
        }
    }

    breakdowns.sort_by(|a, b| b.cost.total_cmp(&a.cost));

    UsageSummary {
        date: None,
        month: None,
        week: None,
        session_id: None,
        project_path: None,
        last_activity: None,
        input_tokens: counts.input_tokens,
        output_tokens: counts.output_tokens,
        cache_creation_tokens: counts.cache_creation_tokens,
        cache_read_tokens: counts.cache_read_tokens,
        total_cost: cost,
        models_used: models,
        model_breakdowns: breakdowns,
        project: None,
        versions: None,
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
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let start_num = match start {
        WeekDay::Sunday => 0,
        WeekDay::Monday => 1,
        WeekDay::Tuesday => 2,
        WeekDay::Wednesday => 3,
        WeekDay::Thursday => 4,
        WeekDay::Friday => 5,
        WeekDay::Saturday => 6,
    };
    let day = date.weekday().num_days_from_sunday() as i64;
    let shift = (day - start_num + 7) % 7;
    Some(
        (date - chrono::Duration::days(shift))
            .format("%Y-%m-%d")
            .to_string(),
    )
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
    }
    value
}

fn session_summary_json(row: &UsageSummary) -> Value {
    json!({
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
    })
}

fn totals_json(rows: &[UsageSummary]) -> Value {
    let input = rows.iter().map(|row| row.input_tokens).sum::<u64>();
    let output = rows.iter().map(|row| row.output_tokens).sum::<u64>();
    let cache_create = rows
        .iter()
        .map(|row| row.cache_creation_tokens)
        .sum::<u64>();
    let cache_read = rows.iter().map(|row| row.cache_read_tokens).sum::<u64>();
    json!({
        "inputTokens": input,
        "outputTokens": output,
        "cacheCreationTokens": cache_create,
        "cacheReadTokens": cache_read,
        "totalTokens": input + output + cache_create + cache_read,
        "totalCost": rows.iter().map(|row| row.total_cost).sum::<f64>(),
    })
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
    let compact = shared.compact || terminal_width() < USAGE_COMPACT_WIDTH_THRESHOLD;
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
    let mut table = SimpleTable::new(headers, aligns, shared);
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
            colour(shared, "Total", Colour::Yellow),
            String::new(),
            colour(shared, format_number(input), Colour::Yellow),
            colour(shared, format_number(output), Colour::Yellow),
            colour(shared, format_currency(total_cost), Colour::Yellow),
        ]
    } else {
        vec![
            colour(shared, "Total", Colour::Yellow),
            String::new(),
            colour(shared, format_number(input), Colour::Yellow),
            colour(shared, format_number(output), Colour::Yellow),
            colour(shared, format_number(cache_create), Colour::Yellow),
            colour(shared, format_number(cache_read), Colour::Yellow),
            colour(
                shared,
                format_number(input + output + cache_create + cache_read),
                Colour::Yellow,
            ),
            colour(shared, format_currency(total_cost), Colour::Yellow),
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
    let session_duration =
        chrono::Duration::milliseconds((session_duration_hours * 60.0 * 60.0 * 1000.0) as i64);
    entries.sort_by_key(|entry| entry.timestamp);
    let now = Utc::now();
    let mut blocks = Vec::new();
    let mut current_start: Option<DateTime<Utc>> = None;
    let mut current_entries = Vec::new();

    for entry in entries {
        if let Some(start) = current_start {
            let last_time = current_entries
                .last()
                .map(|entry: &LoadedEntry| entry.timestamp)
                .unwrap_or(start);
            let since_start = entry.timestamp - start;
            let since_last = entry.timestamp - last_time;
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

fn floor_to_hour(timestamp: DateTime<Utc>) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(
        timestamp.year(),
        timestamp.month(),
        timestamp.day(),
        timestamp.hour(),
        0,
        0,
    )
    .single()
    .unwrap_or(timestamp)
}

fn create_block(
    start: DateTime<Utc>,
    entries: Vec<LoadedEntry>,
    now: DateTime<Utc>,
    duration: chrono::Duration,
) -> SessionBlock {
    let end = start + duration;
    let actual_end = entries.last().map(|entry| entry.timestamp);
    let is_active = actual_end.is_some_and(|last| now - last < duration && now < end);
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
        id: start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
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

fn create_gap_block(
    last: DateTime<Utc>,
    next: DateTime<Utc>,
    duration: chrono::Duration,
) -> SessionBlock {
    let start = last + duration;
    SessionBlock {
        id: format!(
            "gap-{}",
            start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        ),
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
) -> Option<DateTime<Utc>> {
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
    Utc.timestamp_opt(timestamp, 0).single()
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
        "startTime": block.start_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "endTime": block.end_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "actualEndTime": block.actual_end_time.map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
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
        value["usageLimitResetTime"] =
            json!(reset_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
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

enum Colour {
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
}

impl<'a> SimpleTable<'a> {
    fn new(headers: Vec<&str>, aligns: Vec<Align>, shared: &'a SharedArgs) -> Self {
        Self {
            headers: headers.into_iter().map(str::to_string).collect(),
            aligns,
            rows: Vec::new(),
            shared,
        }
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
        println!(
            "{}",
            table_line(
                &self
                    .headers
                    .iter()
                    .map(|header| colour(self.shared, header, Colour::Blue))
                    .collect::<Vec<_>>(),
                &self.aligns,
                &widths,
            )
        );
        println!("{}", border('├', '┼', '┤', &widths));
        for row in &self.rows {
            match row {
                Some(row) => {
                    for physical_row in expand_multiline_row(row, self.headers.len()) {
                        println!("{}", table_line(&physical_row, &self.aligns, &widths));
                    }
                }
                None => println!("{}", border('├', '┼', '┤', &widths)),
            }
        }
        println!("{}", border('└', '┴', '┘', &widths));
    }

    fn column_widths(&self) -> Vec<usize> {
        let mut widths = self
            .headers
            .iter()
            .enumerate()
            .map(|(index, header)| {
                let minimum = if self.aligns.get(index) == Some(&Align::Right) {
                    11
                } else if index == 1 {
                    15
                } else {
                    10
                };
                visible_width(header).max(minimum)
            })
            .collect::<Vec<_>>();
        for row in self.rows.iter().flatten() {
            for (index, cell) in row.iter().enumerate() {
                let max_line_width = cell.lines().map(visible_width).max().unwrap_or_default();
                if let Some(width) = widths.get_mut(index) {
                    *width = (*width).max(max_line_width + 2);
                }
            }
        }
        widths
    }
}

fn project_header_row(column_count: usize, project: &str, shared: &SharedArgs) -> Vec<String> {
    let mut row = vec![String::new(); column_count];
    if let Some(first) = row.first_mut() {
        *first = colour(shared, format!("Project: {project}"), Colour::Blue);
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
                colour(
                    shared,
                    format!("  └─ {}", short_model_name(&breakdown.model_name)),
                    Colour::Grey,
                ),
                String::new(),
                colour(shared, format_number(breakdown.input_tokens), Colour::Grey),
                colour(shared, format_number(breakdown.output_tokens), Colour::Grey),
                colour(shared, format_currency(breakdown.cost), Colour::Grey),
            ]
        } else {
            vec![
                colour(
                    shared,
                    format!("  └─ {}", short_model_name(&breakdown.model_name)),
                    Colour::Grey,
                ),
                String::new(),
                colour(shared, format_number(breakdown.input_tokens), Colour::Grey),
                colour(shared, format_number(breakdown.output_tokens), Colour::Grey),
                colour(
                    shared,
                    format_number(breakdown.cache_creation_tokens),
                    Colour::Grey,
                ),
                colour(
                    shared,
                    format_number(breakdown.cache_read_tokens),
                    Colour::Grey,
                ),
                colour(shared, format_number(total), Colour::Grey),
                colour(shared, format_currency(breakdown.cost), Colour::Grey),
            ]
        };
        if include_last_activity {
            values.push(String::new());
        }
        table.push(values);
    }
}

fn expand_multiline_row(row: &[String], column_count: usize) -> Vec<Vec<String>> {
    let cells = (0..column_count)
        .map(|index| {
            row.get(index)
                .map(|cell| cell.lines().map(str::to_string).collect::<Vec<_>>())
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

fn table_line(cells: &[String], aligns: &[Align], widths: &[usize]) -> String {
    let mut line = String::from("│");
    for (index, width) in widths.iter().enumerate() {
        let cell = cells.get(index).map(String::as_str).unwrap_or("");
        line.push(' ');
        line.push_str(&pad_cell(
            cell,
            width.saturating_sub(2),
            aligns.get(index).copied().unwrap_or(Align::Left),
        ));
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
        width += if ch.len_utf8() > 1 { 2 } else { 1 };
        index += ch.len_utf8();
    }
    width
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
    println!("┌{}┐", "─".repeat(title.len() + 2));
    println!("│ {} │", colour(shared, title, Colour::Blue));
    println!("└{}┘", "─".repeat(title.len() + 2));
}

fn colour(shared: &SharedArgs, value: impl AsRef<str>, colour: Colour) -> String {
    let value = value.as_ref();
    if !use_colour(shared) {
        return value.to_string();
    }
    let code = match colour {
        Colour::Blue => 34,
        Colour::Green => 32,
        Colour::Grey => 90,
        Colour::Red => 31,
        Colour::Yellow => 33,
    };
    format!("\x1b[{code}m{value}\x1b[0m")
}

fn use_colour(shared: &SharedArgs) -> bool {
    if shared.no_color || env::var_os("NO_COLOR").is_some() {
        return false;
    }
    shared.color || env::var_os("FORCE_COLOR").is_some() || io::stdout().is_terminal()
}

fn format_models_display(models: &[String]) -> String {
    let mut models = models
        .iter()
        .map(|model| short_model_name(model))
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models.join(", ")
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
    if compact {
        format!(
            "{}\n{}",
            block.start_time.format("%Y-%m-%d"),
            block.start_time.format("%H:%M")
        )
    } else {
        block.start_time.format("%Y-%m-%d %H:%M").to_string()
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
    let compact = shared.compact || terminal_width() < BLOCKS_COMPACT_WIDTH_THRESHOLD;
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
    let mut table = SimpleTable::new(headers, aligns, shared);
    for block in blocks {
        if block.is_gap {
            let mut row = vec![
                colour(shared, format_block_time(block, compact), Colour::Grey),
                colour(shared, "(inactive)", Colour::Grey),
                colour(shared, "-", Colour::Grey),
                colour(shared, "-", Colour::Grey),
            ];
            if actual_limit.is_some_and(|limit| limit > 0) {
                row.push(colour(shared, "-", Colour::Grey));
            }
            row.push(colour(shared, "-", Colour::Grey));
            table.push(row);
            continue;
        }
        let total = block.token_counts.total();
        let mut row = vec![
            format_block_time(block, compact),
            if block.is_active {
                colour(shared, "ACTIVE", Colour::Green)
            } else {
                String::new()
            },
            format_models_display(&block.models),
            format_number(total),
        ];
        if let Some(limit) = actual_limit.filter(|limit| *limit > 0) {
            let percentage = total as f64 / limit as f64 * 100.0;
            let percent_text = format!("{percentage:.1}%");
            row.push(if percentage > 100.0 {
                colour(shared, percent_text, Colour::Red)
            } else {
                percent_text
            });
        }
        row.push(format_currency(block.cost_usd));
        table.push(row);

        if block.is_active {
            if let Some(limit) = actual_limit.filter(|limit| *limit > 0) {
                let remaining = limit.saturating_sub(total);
                let remaining_percent = (limit.saturating_sub(total) as f64 / limit as f64) * 100.0;
                let mut remaining_row = vec![
                    colour(
                        shared,
                        format!("(assuming {} token limit)", format_number(limit)),
                        Colour::Grey,
                    ),
                    colour(shared, "REMAINING", Colour::Blue),
                    String::new(),
                    if remaining > 0 {
                        format_number(remaining)
                    } else {
                        colour(shared, "0", Colour::Red)
                    },
                ];
                remaining_row.push(if remaining_percent > 0.0 {
                    format!("{remaining_percent:.1}%")
                } else {
                    colour(shared, "0.0%", Colour::Red)
                });
                remaining_row.push(String::new());
                table.push(remaining_row);
            }

            if let Some(projection) = project_block_usage(block) {
                let mut projected_row = vec![
                    colour(shared, "(assuming current burn rate)", Colour::Grey),
                    colour(shared, "PROJECTED", Colour::Yellow),
                    String::new(),
                    match actual_limit {
                        Some(limit) if limit > 0 && projection.total_tokens > limit => {
                            colour(shared, format_number(projection.total_tokens), Colour::Red)
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
    let now = Utc::now();
    let elapsed = (now - block.start_time).num_minutes().max(0);
    let remaining = (block.end_time - now).num_minutes().max(0);
    println!(
        "Block Started:   {}",
        block.start_time.format("%Y-%m-%d %H:%M:%S")
    );
    println!(
        "Time Elapsed:    {}h {}m",
        elapsed / 60,
        elapsed.rem_euclid(60)
    );
    println!(
        "Time Remaining:  {}",
        colour(
            shared,
            format!("{}h {}m", remaining / 60, remaining.rem_euclid(60)),
            Colour::Green,
        )
    );
    println!();
    println!("{}", colour(shared, "Current Usage:", Colour::Blue));
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
        println!("{}", colour(shared, "Burn Rate:", Colour::Blue));
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
            colour(
                shared,
                "Projected Usage (if current rate continues):",
                Colour::Blue
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
                colour(shared, "EXCEEDS LIMIT", Colour::Red)
            } else if projection.total_tokens as f64 > limit as f64 * BLOCKS_WARNING_THRESHOLD {
                colour(shared, "WARNING", Colour::Yellow)
            } else {
                colour(shared, "OK", Colour::Green)
            };
            println!();
            println!("{}", colour(shared, "Token Limit Status:", Colour::Blue));
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
    let duration_minutes = (last - first).num_milliseconds() as f64 / 60_000.0;
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
        ((block.end_time - Utc::now()).num_milliseconds().max(0) as f64 / 60_000.0).round();
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

#[derive(Debug, Deserialize)]
struct StatuslineHook {
    session_id: String,
    model: HookModel,
    cost: Option<HookCost>,
    context_window: Option<HookContext>,
}

#[derive(Debug, Deserialize)]
struct HookModel {
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct HookCost {
    total_cost_usd: f64,
}

#[derive(Debug, Deserialize)]
struct HookContext {
    total_input_tokens: u64,
    context_window_size: u64,
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
    fn extracts_compact_jsonl_timestamp() {
        let timestamp =
            timestamp_from_line(r#"{"timestamp":"2026-05-11T12:34:56.789Z","message":{}}"#)
                .unwrap();

        assert_eq!(timestamp.to_rfc3339(), "2026-05-11T12:34:56.789+00:00");
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
    fn extracts_usage_limit_reset_time_from_raw_line() {
        let line = r#"{"timestamp":"2025-01-10T10:00:00.000Z","isApiErrorMessage":true,"message":{"content":[{"text":"Claude AI usage limit reached|1736503200 remaining"}],"usage":{"input_tokens":0,"output_tokens":0}}}"#;
        let reset_time = usage_limit_reset_time_from_line(line, Some(true)).unwrap();

        assert_eq!(reset_time.to_rfc3339(), "2025-01-10T10:00:00+00:00");
        assert!(usage_limit_reset_time_from_line(line, Some(false)).is_none());
        assert!(usage_limit_reset_time_from_line(
            r#"{"message":{"content":[{"text":"Claude AI usage limit reached|0"}]}}"#,
            Some(true)
        )
        .is_none());
    }
}
