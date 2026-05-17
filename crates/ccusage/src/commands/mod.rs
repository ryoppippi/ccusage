use std::{
    collections::HashMap,
    io::{self, Read},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::json;

use crate::{
    block_json, calculate_burn_rate,
    cli::{
        BlocksArgs, CostSource, DailyArgs, SessionArgs, SharedArgs, SortOrder, StatuslineArgs,
        VisualBurnRate, WeekDay, WeeklyArgs,
    },
    filter_and_sort_summaries, filter_blocks_by_date, format_compact_utc_date, format_context,
    format_currency, format_number, format_remaining_time, group_project_output,
    identify_session_blocks, load_entries, print_active_block_detail, print_blocks_table,
    print_json_or_jq, print_usage_table, session_summary_json, sort_blocks, sort_summaries,
    summarize_by_key, summarize_summaries_by_bucket, summary_json, total_usage_tokens, totals_json,
    utc_now, wants_json, BucketKind, Context, Result, SessionAccumulator, TimestampMs,
    DEFAULT_RECENT_DAYS, DEFAULT_SESSION_DURATION_HOURS, MILLIS_PER_DAY, MILLIS_PER_MINUTE,
};

pub(crate) fn run_daily(args: DailyArgs) -> Result<()> {
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

pub(crate) fn run_bucket(shared: SharedArgs, kind: BucketKind) -> Result<()> {
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

pub(crate) fn run_weekly(args: WeeklyArgs) -> Result<()> {
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

pub(crate) fn run_session(args: SessionArgs) -> Result<()> {
    let shared = args.shared.clone();
    if let Some(id) = args.id {
        return run_session_id(&id, &shared);
    }

    let mut session_shared = shared.clone();
    session_shared.order = SortOrder::Desc;
    let entries = load_entries(&session_shared, None)?;
    let mut grouped = Vec::<SessionAccumulator>::new();
    let mut group_indexes = HashMap::<(Arc<str>, Arc<str>), usize>::new();
    for entry in &entries {
        let key = (
            Arc::clone(&entry.project_path),
            Arc::clone(&entry.session_id),
        );
        let index = *group_indexes.entry(key).or_insert_with(|| {
            let index = grouped.len();
            grouped.push(SessionAccumulator::default());
            index
        });
        grouped[index].add_entry(entry);
    }

    let mut rows = Vec::with_capacity(grouped.len());
    for group in grouped {
        rows.push(group.into_summary(session_shared.timezone.as_deref())?);
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
        .filter(|entry| {
            entry.data.session_id.as_deref() == Some(id) || entry.session_id.as_ref() == id
        })
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

pub(crate) fn run_blocks(args: BlocksArgs) -> Result<()> {
    if args.session_length <= 0.0 {
        return Err(crate::cli_error("Session length must be a positive number"));
    }
    let shared = args.shared.clone();
    let entries = load_entries(&shared, None)?;
    let mut blocks = identify_session_blocks(entries, args.session_length);
    filter_blocks_by_date(&mut blocks, &shared);
    sort_blocks(&mut blocks, &shared.order);

    if args.recent {
        let cutoff = utc_now()
            .checked_sub_millis(DEFAULT_RECENT_DAYS * MILLIS_PER_DAY)
            .unwrap_or(TimestampMs::UNIX_EPOCH);
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

pub(crate) fn run_statusline(args: StatuslineArgs) -> Result<()> {
    if args.context_low_threshold >= args.context_medium_threshold {
        return Err(crate::cli_error(format!(
            "Context low threshold ({}) must be less than medium threshold ({})",
            args.context_low_threshold, args.context_medium_threshold
        )));
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

    let today = format_compact_utc_date(utc_now());
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
        let remaining = block.end_time.duration_since(utc_now()) / MILLIS_PER_MINUTE;
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
            entry.data.session_id.as_deref() == Some(session_id)
                || entry.session_id.as_ref() == session_id
        })
        .map(|entry| entry.cost)
        .sum())
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
