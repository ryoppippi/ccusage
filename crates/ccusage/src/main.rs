use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    env,
    fs::{self, File},
    io::{self, BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Datelike, Local, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use clap::Parser;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod cli;
mod pricing;
mod terminal;

use cli::{
    BlocksArgs, Cli, Command, CostMode, CostSource, DailyArgs, SessionArgs, SharedArgs, SortOrder,
    StatuslineArgs, VisualBurnRate, WeekDay, WeeklyArgs,
};
use pricing::{calculate_cost, PricingRegistry};
use terminal::{color_enabled, print_box, Align, Cell, Table};

const DEFAULT_SESSION_DURATION_HOURS: f64 = 5.0;
const DEFAULT_RECENT_DAYS: i64 = 3;
const BLOCKS_WARNING_THRESHOLD: f64 = 0.8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageEntry {
    pub(crate) session_id: Option<String>,
    pub(crate) timestamp: String,
    pub(crate) version: Option<String>,
    pub(crate) message: UsageMessage,
    #[serde(rename = "costUSD")]
    pub(crate) cost_usd: Option<f64>,
    pub(crate) request_id: Option<String>,
    pub(crate) is_api_error_message: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct UsageMessage {
    pub(crate) usage: TokenUsageRaw,
    pub(crate) model: Option<String>,
    pub(crate) id: Option<String>,
    pub(crate) content: Option<Vec<ContentPart>>,
}

#[derive(Debug, Clone, Deserialize)]
struct ContentPart {
    text: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub(crate) struct TokenUsageRaw {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    #[serde(default)]
    pub(crate) cache_creation_input_tokens: u64,
    #[serde(default)]
    pub(crate) cache_read_input_tokens: u64,
    pub(crate) speed: Option<Speed>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Speed {
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
    let entries = load_entries(&shared, args.project.as_deref()).await?;
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
        false,
    );
    Ok(())
}

async fn run_bucket(shared: SharedArgs, kind: BucketKind) -> Result<()> {
    let entries = load_entries(&shared, None).await?;
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
    print_usage_table(title, col, &buckets, &shared, false);
    Ok(())
}

async fn run_weekly(args: WeeklyArgs) -> Result<()> {
    let shared = args.shared.clone();
    let entries = load_entries(&shared, None).await?;
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
    );
    Ok(())
}

async fn run_session(args: SessionArgs) -> Result<()> {
    let shared = args.shared.clone();
    if let Some(id) = args.id {
        return run_session_id(&id, &shared).await;
    }

    let mut session_shared = shared.clone();
    session_shared.order = SortOrder::Desc;
    let entries = load_entries(&session_shared, None).await?;
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
        true,
    );
    Ok(())
}

async fn run_session_id(id: &str, shared: &SharedArgs) -> Result<()> {
    let entries = load_entries(shared, None).await?;
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
    let entries = load_entries(&shared, None).await?;
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
    print_blocks_table(&blocks, args.token_limit.as_deref(), max_tokens, &shared);
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
        CostSource::Ccusage => calculate_session_cost(&hook.session_id, &shared).await.ok(),
        CostSource::Auto => {
            if let Some(cost) = hook.cost.as_ref() {
                Some(cost.total_cost_usd)
            } else {
                calculate_session_cost(&hook.session_id, &shared).await.ok()
            }
        }
        CostSource::Both => None,
    };

    let ccusage_cost = if args.cost_source == CostSource::Both {
        calculate_session_cost(&hook.session_id, &shared).await.ok()
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
    let today_cost = match load_entries(&today_shared, None).await {
        Ok(entries) => entries
            .iter()
            .filter(|entry| {
                entry.date.replace('-', "") == today_shared.since.as_deref().unwrap_or_default()
            })
            .map(|entry| entry.cost)
            .sum::<f64>(),
        Err(_) => 0.0,
    };

    let blocks = load_entries(&shared, None)
        .await
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

async fn calculate_session_cost(session_id: &str, shared: &SharedArgs) -> Result<f64> {
    Ok(load_entries(shared, None)
        .await?
        .into_iter()
        .filter(|entry| {
            entry.data.session_id.as_deref() == Some(session_id) || entry.session_id == session_id
        })
        .map(|entry| entry.cost)
        .sum())
}

async fn load_entries(
    shared: &SharedArgs,
    project_filter: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    let paths = claude_paths()?;
    let files = sorted_usage_files(&paths);
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = files
        .par_iter()
        .enumerate()
        .flat_map_iter(|(file_index, file)| read_usage_file(file, tz, file_index))
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
            if entry.project != filter {
                continue;
            }
        }
        deduped.push(entry);
    }
    assign_costs(&mut deduped, shared).await;
    Ok(deduped)
}

async fn assign_costs(entries: &mut [LoadedEntry], shared: &SharedArgs) {
    if shared.mode == CostMode::Display
        || (shared.mode == CostMode::Auto
            && entries.iter().all(|entry| entry.data.cost_usd.is_some()))
    {
        for entry in entries {
            entry.cost = entry.data.cost_usd.unwrap_or(0.0);
        }
        return;
    }

    let pricing =
        PricingRegistry::load(shared.offline && !shared.no_offline, wants_json(shared)).await;
    for entry in entries {
        entry.cost = calculate_cost(&entry.data, shared.mode, &pricing);
    }
}

fn read_usage_file_with(path: &Path, tz: Option<Tz>, file_index: usize) -> Vec<LoadedEntry> {
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
            let value = serde_json::from_str::<Value>(&line).ok()?;
            if !is_ts_usage_value(&value) {
                return None;
            }
            let data = serde_json::from_value::<UsageEntry>(value).ok()?;
            if !is_valid_usage_entry(&data) {
                return None;
            }
            let timestamp = DateTime::parse_from_rfc3339(&data.timestamp)
                .ok()?
                .with_timezone(&Utc);
            let date = format_date_tz(timestamp, tz);
            let model = data.message.model.as_ref().and_then(|model| {
                if model == "<synthetic>" {
                    None
                } else if matches!(data.message.usage.speed, Some(Speed::Fast)) {
                    Some(format!("{model}-fast"))
                } else {
                    Some(model.clone())
                }
            });
            Some(LoadedEntry {
                data,
                timestamp,
                date,
                project: project.clone(),
                session_id: session_id.clone(),
                project_path: project_path.clone(),
                cost: 0.0,
                model,
                file_index,
                line_number,
            })
        })
        .collect()
}

fn is_ts_usage_value(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if !optional_string(object, "cwd")
        || !optional_string(object, "sessionId")
        || !optional_string(object, "version")
        || !optional_string(object, "requestId")
        || !optional_number(object, "costUSD")
        || !optional_bool(object, "isApiErrorMessage")
    {
        return false;
    }
    if object
        .get("version")
        .and_then(Value::as_str)
        .is_some_and(|version| !is_semver_prefix(version))
    {
        return false;
    }
    let Some(timestamp) = object.get("timestamp").and_then(Value::as_str) else {
        return false;
    };
    if !is_ts_timestamp(timestamp) {
        return false;
    }
    let Some(message) = object.get("message").and_then(Value::as_object) else {
        return false;
    };
    if !optional_string(message, "model") || !optional_string(message, "id") {
        return false;
    }
    if let Some(content) = message.get("content") {
        let Some(parts) = content.as_array() else {
            return false;
        };
        for part in parts {
            let Some(part) = part.as_object() else {
                return false;
            };
            if !optional_string(part, "text") {
                return false;
            }
        }
    }
    let Some(usage) = message.get("usage").and_then(Value::as_object) else {
        return false;
    };
    usage.get("input_tokens").is_some_and(Value::is_number)
        && usage.get("output_tokens").is_some_and(Value::is_number)
        && optional_number(usage, "cache_creation_input_tokens")
        && optional_number(usage, "cache_read_input_tokens")
        && usage
            .get("speed")
            .is_none_or(|speed| matches!(speed.as_str(), Some("standard" | "fast")))
}

fn optional_string(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    object.get(key).is_none_or(Value::is_string)
}

fn optional_number(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    object.get(key).is_none_or(Value::is_number)
}

fn optional_bool(object: &serde_json::Map<String, Value>, key: &str) -> bool {
    object.get(key).is_none_or(Value::is_boolean)
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

fn read_usage_file(path: &Path, tz: Option<Tz>, file_index: usize) -> Vec<LoadedEntry> {
    read_usage_file_with(path, tz, file_index)
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
    let entries = entries.filter_map(Result::ok).collect::<Vec<_>>();

    for entry in &entries {
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            files.push(path);
        }
    }

    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_usage_files(&path, files);
        }
    }
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
                .and_then(|value| DateTime::from_timestamp_millis(value.timestamp_millis()))
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
    let mut obj = serde_json::Map::new();
    if let Some(date) = &row.date {
        obj.insert("date".to_string(), json!(date));
    }
    if let Some(month) = &row.month {
        obj.insert("month".to_string(), json!(month));
    }
    if let Some(week) = &row.week {
        obj.insert("week".to_string(), json!(week));
    }
    obj.insert("inputTokens".to_string(), json!(row.input_tokens));
    obj.insert("outputTokens".to_string(), json!(row.output_tokens));
    obj.insert(
        "cacheCreationTokens".to_string(),
        json!(row.cache_creation_tokens),
    );
    obj.insert("cacheReadTokens".to_string(), json!(row.cache_read_tokens));
    obj.insert("totalTokens".to_string(), json!(total));
    obj.insert("totalCost".to_string(), json!(row.total_cost));
    obj.insert("modelsUsed".to_string(), json!(row.models_used));
    obj.insert("modelBreakdowns".to_string(), json!(row.model_breakdowns));
    if let Some(project) = &row.project {
        obj.insert("project".to_string(), json!(project));
    }
    Value::Object(obj)
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
        "totalCost": rows.iter().map(|row| row.total_cost).sum::<f64>(),
        "totalTokens": input + output + cache_create + cache_read,
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
    include_last_activity: bool,
) {
    if rows.is_empty() {
        eprintln!("No Claude usage data found.");
        return;
    }
    let color = color_enabled(shared.no_color, shared.color);
    print_box(title);
    let mut headers = vec![
        first_column,
        "Models",
        "Input",
        "Output",
        "Cache\nCreate",
        "Cache\nRead",
        "Total\nTokens",
        "Cost\n(USD)",
    ];
    let mut aligns = vec![
        Align::Left,
        Align::Left,
        Align::Right,
        Align::Right,
        Align::Right,
        Align::Right,
        Align::Right,
        Align::Right,
    ];
    if include_last_activity {
        headers.push("Last Activity");
        aligns.push(Align::Left);
    }
    let mut table = Table::new(headers, aligns, color);
    for row in rows {
        let mut label = row
            .date
            .as_deref()
            .or(row.month.as_deref())
            .or(row.week.as_deref())
            .or(row.session_id.as_deref())
            .unwrap_or("")
            .to_string();
        if first_column == "Session" {
            label = session_display_label(&label);
        } else if should_compact_table_date(shared) {
            label = compact_date_label(&label);
        }
        let mut cells = usage_cells(
            label,
            format_models_display_multiline(&row.models_used),
            row.input_tokens,
            row.output_tokens,
            row.cache_creation_tokens,
            row.cache_read_tokens,
            row.total_cost,
        );
        if include_last_activity {
            cells.push(Cell::new(row.last_activity.as_deref().unwrap_or("")));
        }
        table.push(cells);
        if shared.breakdown {
            for breakdown in &row.model_breakdowns {
                let mut cells = usage_cells(
                    format!("  └─ {}", format_model_name(&breakdown.model_name)),
                    String::new(),
                    breakdown.input_tokens,
                    breakdown.output_tokens,
                    breakdown.cache_creation_tokens,
                    breakdown.cache_read_tokens,
                    breakdown.cost,
                );
                if include_last_activity {
                    cells.push(Cell::new(""));
                }
                table.push(cells);
            }
        }
    }

    let input = rows.iter().map(|row| row.input_tokens).sum();
    let output = rows.iter().map(|row| row.output_tokens).sum();
    let cache_create = rows.iter().map(|row| row.cache_creation_tokens).sum();
    let cache_read = rows.iter().map(|row| row.cache_read_tokens).sum();
    let total_cost = rows.iter().map(|row| row.total_cost).sum();
    let mut totals = usage_cells(
        "Total".to_string(),
        String::new(),
        input,
        output,
        cache_create,
        cache_read,
        total_cost,
    );
    if include_last_activity {
        totals.push(Cell::new(""));
    }
    table.push(totals);
    println!("{}", table.render());
}

fn usage_cells(
    first: String,
    models: String,
    input: u64,
    output: u64,
    cache_create: u64,
    cache_read: u64,
    cost: f64,
) -> Vec<Cell> {
    vec![
        Cell::new(first),
        Cell::new(models),
        Cell::new(format_number(input)),
        Cell::new(format_number(output)),
        Cell::new(format_number(cache_create)),
        Cell::new(format_number(cache_read)),
        Cell::new(format_number(input + output + cache_create + cache_read)),
        Cell::new(format_currency(cost)),
    ]
}

fn should_compact_table_date(shared: &SharedArgs) -> bool {
    shared.compact
        || env::var("COLUMNS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .is_none_or(|width| width < 140)
}

fn compact_date_label(value: &str) -> String {
    if value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
    {
        format!("{}\n{}", &value[..4], &value[5..])
    } else {
        value.to_string()
    }
}

fn session_display_label(value: &str) -> String {
    let parts = value.split('-').collect::<Vec<_>>();
    if parts.len() >= 2 {
        parts[parts.len() - 2..].join("-")
    } else {
        value.to_string()
    }
}

fn format_models_display_multiline(models: &[String]) -> String {
    models
        .iter()
        .map(|model| format_model_name(model))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|model| format!("- {model}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_model_name(model: &str) -> String {
    if let Some(rest) = model.strip_prefix("[pi] ") {
        return format!("[pi] {}", format_model_name(rest));
    }
    if let Some(rest) = model.strip_prefix("anthropic/claude-") {
        if rest.chars().last().is_some_and(|ch| ch.is_ascii_digit()) && rest.contains('.') {
            return rest.to_string();
        }
    }
    if let Some(rest) = model.strip_prefix("claude-") {
        let parts = rest.split('-').collect::<Vec<_>>();
        if parts
            .last()
            .is_some_and(|part| part.len() == 8 && part.chars().all(|ch| ch.is_ascii_digit()))
            && parts.len() >= 3
        {
            return parts[..parts.len() - 1].join("-");
        }
        if parts.len() >= 2 {
            return rest.to_string();
        }
    }
    model.to_string()
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
    let actual_limit = parse_token_limit(token_limit, max_tokens);
    let color = color_enabled(shared.no_color, shared.color);
    print_box("Claude Code Token Usage Report - Session Blocks");
    let mut headers = vec!["Block Start", "Duration/Status", "Models", "Tokens"];
    let mut aligns = vec![Align::Left, Align::Left, Align::Left, Align::Right];
    if actual_limit.is_some() {
        headers.push("%");
        aligns.push(Align::Right);
    }
    headers.push("Cost");
    aligns.push(Align::Right);
    let mut table = Table::new(headers, aligns, color);
    for block in blocks {
        if block.is_gap {
            let mut cells = vec![
                Cell::new(format_block_time(block)),
                Cell::new("(inactive)"),
                Cell::new("-"),
                Cell::new("-"),
            ];
            if actual_limit.is_some() {
                cells.push(Cell::new("-"));
            }
            cells.push(Cell::new("-"));
            table.push(cells);
            continue;
        }
        let total = block.token_counts.total();
        let mut cells = vec![
            Cell::new(format_block_time(block)),
            Cell::new(if block.is_active { "ACTIVE" } else { "" }),
            Cell::new(format_models_display_multiline(&block.models)),
            Cell::new(format_number(total)),
        ];
        if let Some(limit) = actual_limit {
            cells.push(Cell::new(format!(
                "{:.1}%",
                total as f64 / limit as f64 * 100.0
            )));
        }
        cells.push(Cell::new(format_currency(block.cost_usd)));
        table.push(cells);
    }
    println!("{}", table.render());
}

fn format_block_time(block: &SessionBlock) -> String {
    let start = block.start_time.with_timezone(&Local);
    if block.is_gap {
        let end = block.end_time.with_timezone(&Local);
        let duration = (block.end_time - block.start_time).num_hours();
        return format!(
            "{} - {}\n({duration}h gap)",
            start.format("%-m/%-d/%Y, %-I:%M:%S %p"),
            end.format("%-m/%-d/%Y, %-I:%M:%S %p")
        );
    }
    let duration = block
        .actual_end_time
        .map(|end| (end - block.start_time).num_minutes())
        .unwrap_or(0);
    if block.is_active {
        let elapsed = (Utc::now() - block.start_time).num_minutes().max(0);
        let remaining = (block.end_time - Utc::now()).num_minutes().max(0);
        return format!(
            "{}\n({}h {}m elapsed, {}h {}m remaining)",
            start.format("%-m/%-d/%Y, %-I:%M:%S %p"),
            elapsed / 60,
            elapsed % 60,
            remaining / 60,
            remaining % 60
        );
    }
    format!(
        "{}\n({}h {}m)",
        start.format("%-m/%-d/%Y, %-I:%M:%S %p"),
        duration / 60,
        duration % 60
    )
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
