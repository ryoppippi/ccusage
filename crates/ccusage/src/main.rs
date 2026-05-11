use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env,
    fs::File,
    io::{self, BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use clap::{Args, Parser, Subcommand, ValueEnum};
use jwalk::WalkDir;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_SESSION_DURATION_HOURS: f64 = 5.0;
const DEFAULT_RECENT_DAYS: i64 = 3;
const BLOCKS_WARNING_THRESHOLD: f64 = 0.8;

#[derive(Parser)]
#[command(
    name = "ccusage",
    version,
    about = "Usage analysis tool for Claude Code"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    #[command(flatten)]
    shared: SharedArgs,
}

#[derive(Subcommand)]
enum Command {
    Daily(DailyArgs),
    Monthly(SharedArgs),
    Weekly(WeeklyArgs),
    Session(SessionArgs),
    Blocks(BlocksArgs),
    Statusline(StatuslineArgs),
}

#[derive(Clone, Args, Default)]
struct SharedArgs {
    #[arg(short, long)]
    since: Option<String>,
    #[arg(short, long)]
    until: Option<String>,
    #[arg(short, long)]
    json: bool,
    #[arg(short, long, value_enum, default_value_t = CostMode::Auto)]
    mode: CostMode,
    #[arg(short, long)]
    debug: bool,
    #[arg(long, default_value_t = 5)]
    debug_samples: usize,
    #[arg(short, long, value_enum, default_value_t = SortOrder::Asc)]
    order: SortOrder,
    #[arg(short, long)]
    breakdown: bool,
    #[arg(short = 'O', long)]
    offline: bool,
    #[arg(long)]
    no_offline: bool,
    #[arg(long)]
    color: bool,
    #[arg(long)]
    no_color: bool,
    #[arg(short = 'z', long)]
    timezone: Option<String>,
    #[arg(short, long, default_value = "en-CA")]
    locale: String,
    #[arg(short = 'q', long)]
    jq: Option<String>,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    compact: bool,
}

#[derive(Clone, Args)]
struct DailyArgs {
    #[command(flatten)]
    shared: SharedArgs,
    #[arg(short = 'i', long)]
    instances: bool,
    #[arg(short, long)]
    project: Option<String>,
    #[arg(long)]
    project_aliases: Option<String>,
}

#[derive(Clone, Args)]
struct WeeklyArgs {
    #[command(flatten)]
    shared: SharedArgs,
    #[arg(short = 'w', long, value_enum, default_value_t = WeekDay::Sunday)]
    start_of_week: WeekDay,
}

#[derive(Clone, Args)]
struct SessionArgs {
    #[command(flatten)]
    shared: SharedArgs,
    #[arg(short, long)]
    id: Option<String>,
}

#[derive(Clone, Args)]
struct BlocksArgs {
    #[command(flatten)]
    shared: SharedArgs,
    #[arg(short, long)]
    active: bool,
    #[arg(short, long)]
    recent: bool,
    #[arg(short = 't', long)]
    token_limit: Option<String>,
    #[arg(short = 'n', long, default_value_t = DEFAULT_SESSION_DURATION_HOURS)]
    session_length: f64,
}

#[derive(Clone, Args)]
struct StatuslineArgs {
    #[arg(short = 'O', long, default_value_t = true)]
    offline: bool,
    #[arg(long)]
    no_offline: bool,
    #[arg(short = 'B', long, value_enum, default_value_t = VisualBurnRate::Off)]
    visual_burn_rate: VisualBurnRate,
    #[arg(long, value_enum, default_value_t = CostSource::Auto)]
    cost_source: CostSource,
    #[arg(long, default_value_t = true)]
    cache: bool,
    #[arg(long)]
    no_cache: bool,
    #[arg(long, default_value_t = 1)]
    refresh_interval: u64,
    #[arg(long, default_value_t = 50)]
    context_low_threshold: u8,
    #[arg(long, default_value_t = 80)]
    context_medium_threshold: u8,
    #[arg(long)]
    config: Option<PathBuf>,
    #[arg(long)]
    debug: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
enum CostMode {
    #[default]
    Auto,
    Calculate,
    Display,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
enum SortOrder {
    Desc,
    #[default]
    Asc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum WeekDay {
    Sunday,
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum VisualBurnRate {
    Off,
    Emoji,
    Text,
    EmojiText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum CostSource {
    Auto,
    Ccusage,
    Cc,
    Both,
}

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
    content: Option<Vec<ContentPart>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ContentPart {
    text: Option<String>,
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
    file_index: usize,
    line_number: usize,
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

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Daily(args)) => run_daily(args).await,
        Some(Command::Monthly(shared)) => run_bucket(shared, BucketKind::Monthly).await,
        Some(Command::Weekly(args)) => run_weekly(args).await,
        Some(Command::Session(args)) => run_session(args).await,
        Some(Command::Blocks(args)) => run_blocks(args).await,
        Some(Command::Statusline(args)) => run_statusline(args).await,
        None => {
            let args = DailyArgs {
                shared: cli.shared,
                instances: false,
                project: None,
                project_aliases: None,
            };
            run_daily(args).await
        }
    }
}

async fn run_daily(args: DailyArgs) -> Result<()> {
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

    print_usage_table("Claude Code Token Usage Report - Daily", "Date", &rows);
    Ok(())
}

async fn run_bucket(shared: SharedArgs, kind: BucketKind) -> Result<()> {
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
    print_usage_table(title, col, &buckets);
    Ok(())
}

async fn run_weekly(args: WeeklyArgs) -> Result<()> {
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

    print_usage_table("Claude Code Token Usage Report - Weekly", "Week", &weekly);
    Ok(())
}

async fn run_session(args: SessionArgs) -> Result<()> {
    let shared = args.shared.clone();
    if let Some(id) = args.id {
        return run_session_id(&id, &shared).await;
    }

    let entries = load_entries(&shared, None)?;
    let mut grouped: BTreeMap<String, Vec<&LoadedEntry>> = BTreeMap::new();
    for entry in &entries {
        grouped
            .entry(format!("{}/{}", entry.project_path, entry.session_id))
            .or_default()
            .push(entry);
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
        summary.last_activity = Some(format_date(latest.timestamp, shared.timezone.as_deref()));
        let versions = group
            .iter()
            .filter_map(|entry| entry.data.version.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        summary.versions = Some(versions);
        rows.push(summary);
    }
    filter_and_sort_summaries(&mut rows, &shared, |row| {
        row.last_activity.as_deref().unwrap_or_default()
    });

    if wants_json(&shared) {
        let output = json!({
            "sessions": rows.iter().map(session_summary_json).collect::<Vec<_>>(),
            "totals": totals_json(&rows),
        });
        print_json_or_jq(output, shared.jq.as_deref())?;
        return Ok(());
    }

    print_usage_table(
        "Claude Code Token Usage Report - By Session",
        "Session",
        &rows,
    );
    Ok(())
}

async fn run_session_id(id: &str, shared: &SharedArgs) -> Result<()> {
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

async fn run_blocks(args: BlocksArgs) -> Result<()> {
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
    print_blocks_table(&blocks, args.token_limit.as_deref(), max_tokens);
    Ok(())
}

async fn run_statusline(args: StatuslineArgs) -> Result<()> {
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
    let files = sorted_usage_files(&paths);
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let tz = parse_tz(shared.timezone.as_deref());
    let mode = shared.mode;
    let mut entries = files
        .par_iter()
        .enumerate()
        .flat_map_iter(|(file_index, file)| read_usage_file(file, tz, mode, file_index))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (entry.file_index, entry.line_number));

    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(entries.len());
    for entry in entries {
        if let (Some(message_id), Some(request_id)) =
            (&entry.data.message.id, &entry.data.request_id)
        {
            if !seen.insert(format!("{message_id}:{request_id}")) {
                continue;
            }
        }
        if let Some(filter) = project_filter {
            if entry.project != filter && !entry.project.contains(filter) {
                continue;
            }
        }
        deduped.push(entry);
    }
    Ok(deduped)
}

fn read_usage_file_with(
    path: &Path,
    tz: Option<Tz>,
    mode: CostMode,
    file_index: usize,
) -> Vec<LoadedEntry> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let project = extract_project(path);
    let (session_id, project_path) = extract_session_parts(path);
    let reader = BufReader::new(file);
    reader
        .lines()
        .enumerate()
        .filter_map(|(line_number, line)| line.ok().map(|line| (line_number, line)))
        .filter_map(|(line_number, line)| {
            if line.trim().is_empty() {
                return None;
            }
            let data = serde_json::from_str::<UsageEntry>(&line).ok()?;
            if !is_valid_usage_entry(&data) {
                return None;
            }
            let timestamp = DateTime::parse_from_rfc3339(&data.timestamp)
                .ok()?
                .with_timezone(&Utc);
            let date = format_date_tz(timestamp, tz);
            let cost = calculate_cost(&data, mode);
            let model = data
                .message
                .model
                .clone()
                .filter(|model| model != "<synthetic>");
            Some(LoadedEntry {
                data,
                timestamp,
                date,
                project: project.clone(),
                session_id: session_id.clone(),
                project_path: project_path.clone(),
                cost,
                model,
                file_index,
                line_number,
            })
        })
        .collect()
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

fn read_usage_file(
    path: &Path,
    tz: Option<Tz>,
    mode: CostMode,
    file_index: usize,
) -> Vec<LoadedEntry> {
    read_usage_file_with(path, tz, mode, file_index)
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
    paths
        .par_iter()
        .flat_map_iter(|path| {
            let projects = path.join("projects");
            WalkDir::new(projects)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
                .collect::<Vec<_>>()
        })
        .collect()
}

fn sorted_usage_files(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut files = usage_files(paths)
        .into_par_iter()
        .map(|file| {
            let timestamp = earliest_timestamp(&file);
            (file, timestamp)
        })
        .collect::<Vec<_>>();
    files.sort_by(|(a_file, a_timestamp), (b_file, b_timestamp)| {
        match (a_timestamp, b_timestamp) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a_file.cmp(b_file),
        }
    });
    files.into_iter().map(|(file, _)| file).collect()
}

fn earliest_timestamp(path: &Path) -> Option<DateTime<Utc>> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);
    reader
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| {
            let value = serde_json::from_str::<Value>(&line).ok()?;
            let timestamp = value.get("timestamp")?.as_str()?;
            DateTime::parse_from_rfc3339(timestamp)
                .ok()
                .map(|value| value.with_timezone(&Utc))
        })
        .min()
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
    let session_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown")
        .to_string();
    let project_path = if relative.len() > 1 {
        relative[..relative.len() - 1].join(std::path::MAIN_SEPARATOR_STR)
    } else {
        "Unknown Project".to_string()
    };
    (session_id, project_path)
}

fn parse_tz(timezone: Option<&str>) -> Option<Tz> {
    timezone.and_then(|value| value.parse::<Tz>().ok())
}

fn format_date(timestamp: DateTime<Utc>, timezone: Option<&str>) -> String {
    format_date_tz(timestamp, parse_tz(timezone))
}

fn format_date_tz(timestamp: DateTime<Utc>, timezone: Option<Tz>) -> String {
    if let Some(tz) = timezone {
        timestamp.with_timezone(&tz).format("%Y-%m-%d").to_string()
    } else {
        timestamp
            .with_timezone(&Local)
            .format("%Y-%m-%d")
            .to_string()
    }
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
    let mut models = BTreeSet::new();
    let mut breakdowns: HashMap<String, ModelBreakdown> = HashMap::new();

    for entry in entries {
        let usage = entry.data.message.usage;
        counts.add_usage(usage);
        cost += entry.cost;
        if let Some(model) = &entry.model {
            models.insert(model.clone());
            let breakdown = breakdowns
                .entry(model.clone())
                .or_insert_with(|| ModelBreakdown {
                    model_name: model.clone(),
                    ..ModelBreakdown::default()
                });
            breakdown.input_tokens += usage.input_tokens;
            breakdown.output_tokens += usage.output_tokens;
            breakdown.cache_creation_tokens += usage.cache_creation_input_tokens;
            breakdown.cache_read_tokens += usage.cache_read_input_tokens;
            breakdown.cost += entry.cost;
        }
    }

    let mut model_breakdowns = breakdowns.into_values().collect::<Vec<_>>();
    model_breakdowns.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| a.model_name.cmp(&b.model_name))
    });

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
        models_used: models.into_iter().collect(),
        model_breakdowns,
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
    let mut models = BTreeSet::new();
    let mut breakdowns: HashMap<String, ModelBreakdown> = HashMap::new();

    for row in rows {
        summary.input_tokens += row.input_tokens;
        summary.output_tokens += row.output_tokens;
        summary.cache_creation_tokens += row.cache_creation_tokens;
        summary.cache_read_tokens += row.cache_read_tokens;
        summary.total_cost += row.total_cost;
        models.extend(row.models_used.iter().cloned());
        for item in &row.model_breakdowns {
            let breakdown = breakdowns
                .entry(item.model_name.clone())
                .or_insert_with(|| ModelBreakdown {
                    model_name: item.model_name.clone(),
                    ..ModelBreakdown::default()
                });
            breakdown.input_tokens += item.input_tokens;
            breakdown.output_tokens += item.output_tokens;
            breakdown.cache_creation_tokens += item.cache_creation_tokens;
            breakdown.cache_read_tokens += item.cache_read_tokens;
            breakdown.cost += item.cost;
        }
    }
    summary.models_used = models.into_iter().collect();
    summary.model_breakdowns = breakdowns.into_values().collect();
    summary.model_breakdowns.sort_by(|a, b| {
        b.cost
            .total_cmp(&a.cost)
            .then_with(|| a.model_name.cmp(&b.model_name))
    });
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

fn print_usage_table(title: &str, first_column: &str, rows: &[UsageSummary]) {
    if rows.is_empty() {
        eprintln!("No Claude usage data found.");
        return;
    }
    println!("{title}");
    println!(
        "{:<16} {:>12} {:>12} {:>12} {:>12} {:>12} {:>12}  Models",
        first_column, "Input", "Output", "CacheCreate", "CacheRead", "Total", "Cost"
    );
    for row in rows {
        let label = row
            .date
            .as_deref()
            .or(row.month.as_deref())
            .or(row.week.as_deref())
            .or(row.session_id.as_deref())
            .unwrap_or("");
        println!(
            "{:<16} {:>12} {:>12} {:>12} {:>12} {:>12} {:>12}  {}",
            label,
            format_number(row.input_tokens),
            format_number(row.output_tokens),
            format_number(row.cache_creation_tokens),
            format_number(row.cache_read_tokens),
            format_number(
                row.input_tokens
                    + row.output_tokens
                    + row.cache_creation_tokens
                    + row.cache_read_tokens
            ),
            format_currency(row.total_cost),
            row.models_used.join(", ")
        );
    }
    println!(
        "{:<16} {:>12} {:>12} {:>12} {:>12} {:>12} {:>12}",
        "Total",
        format_number(rows.iter().map(|row| row.input_tokens).sum()),
        format_number(rows.iter().map(|row| row.output_tokens).sum()),
        format_number(rows.iter().map(|row| row.cache_creation_tokens).sum()),
        format_number(rows.iter().map(|row| row.cache_read_tokens).sum()),
        format_number(
            rows.iter()
                .map(|row| row.input_tokens
                    + row.output_tokens
                    + row.cache_creation_tokens
                    + row.cache_read_tokens)
                .sum()
        ),
        format_currency(rows.iter().map(|row| row.total_cost).sum())
    );
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
    let mut models = BTreeSet::new();
    let mut usage_limit_reset_time = None;
    for entry in &entries {
        token_counts.add_usage(entry.data.message.usage);
        cost += entry.cost;
        if let Some(model) = &entry.model {
            models.insert(model.clone());
        }
        usage_limit_reset_time =
            usage_limit_reset_time.or_else(|| usage_limit_reset_time_from_entry(&entry.data));
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
        models: models.into_iter().collect(),
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

fn usage_limit_reset_time_from_entry(entry: &UsageEntry) -> Option<DateTime<Utc>> {
    if entry.is_api_error_message != Some(true) {
        return None;
    }
    let text = entry
        .message
        .content
        .as_ref()?
        .iter()
        .find_map(|part| part.text.as_deref())?;
    let timestamp = text
        .split('|')
        .nth(1)?
        .split_whitespace()
        .next()?
        .parse::<i64>()
        .ok()?;
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
		let limit = parse_token_limit(token_limit, max_tokens)?;
		let percent = projection.total_tokens as f64 / limit as f64 * 100.0;
		Some(json!({
			"limit": limit,
			"projectedUsage": projection.total_tokens,
			"percentUsed": percent,
			"status": if projection.total_tokens > limit { "exceeds" } else if projection.total_tokens as f64 > limit as f64 * BLOCKS_WARNING_THRESHOLD { "warning" } else { "ok" },
		}))
	});
    json!({
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
        "costUSD": block.cost_usd,
        "models": block.models,
        "burnRate": burn_rate,
        "projection": projection,
        "tokenLimitStatus": token_limit_status,
        "usageLimitResetTime": block.usage_limit_reset_time.map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    })
}

fn print_blocks_table(blocks: &[SessionBlock], token_limit: Option<&str>, max_tokens: u64) {
    if blocks.is_empty() {
        eprintln!("No Claude usage data found.");
        return;
    }
    let actual_limit = parse_token_limit(token_limit, max_tokens);
    println!("Claude Code Token Usage Report - Session Blocks");
    println!(
        "{:<25} {:<12} {:<30} {:>12} {:>8} {:>12}",
        "Block Start", "Status", "Models", "Tokens", "%", "Cost"
    );
    for block in blocks {
        if block.is_gap {
            println!(
                "{:<25} {:<12} {:<30} {:>12} {:>8} {:>12}",
                block.start_time, "(inactive)", "-", "-", "-", "-"
            );
            continue;
        }
        let total = block.token_counts.total();
        let percent = actual_limit
            .map(|limit| format!("{:.1}%", total as f64 / limit as f64 * 100.0))
            .unwrap_or_else(|| "-".to_string());
        println!(
            "{:<25} {:<12} {:<30} {:>12} {:>8} {:>12}",
            block.start_time.format("%Y-%m-%d %H:%M"),
            if block.is_active { "ACTIVE" } else { "" },
            block.models.join(", "),
            format_number(total),
            percent,
            format_currency(block.cost_usd)
        );
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
}
