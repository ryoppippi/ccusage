use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    adapter::opencode, calculate_cost, cli::AgentCommandArgs, cli::AgentReportKind, cli::CostMode,
    cli::WeekDay, collect_files_with_extension, filter_loaded_entries_by_date, format_currency,
    format_date_tz, format_models_multiline, format_number, json_value_u64, non_empty_json_string,
    parse_tz, print_box_title, print_json_or_jq, sort_summaries, summarize_by_key,
    summarize_summaries_by_bucket, totals_json, wants_json, Align, BucketKind, Color, LoadedEntry,
    PricingMap, Result, SimpleTable, TokenUsageRaw, UsageEntry, UsageMessage,
};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, |row| {
        opencode::summary_period(row)
    });
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    print_table(args.kind, &rows, &shared);
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| opencode::agent_summary_json(row, kind, false))
        .collect::<Vec<_>>();
    json!({
        rows_key(kind): rows_json,
        "totals": totals_json(rows),
    })
}

pub(crate) fn summarize_entries(
    entries: &[LoadedEntry],
    kind: AgentReportKind,
) -> Result<Vec<crate::UsageSummary>> {
    match kind {
        AgentReportKind::Daily => summarize_by_key(
            entries,
            |entry| entry.date.clone(),
            |date| (date.to_string(), None),
        ),
        AgentReportKind::Monthly => {
            let daily = summarize_by_key(
                entries,
                |entry| entry.date.clone(),
                |date| (date.to_string(), None),
            )?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Monthly,
                WeekDay::Sunday,
            ))
        }
        AgentReportKind::Session => summarize_by_key(
            entries,
            |entry| entry.session_id.to_string(),
            |session_id| (session_id.to_string(), None),
        )
        .map(|mut rows| {
            for row in &mut rows {
                row.session_id = row.date.take();
            }
            rows
        }),
        AgentReportKind::Weekly => Ok(Vec::new()),
    }
}

fn rows_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "daily",
        AgentReportKind::Weekly => "weekly",
        AgentReportKind::Monthly => "monthly",
        AgentReportKind::Session => "sessions",
    }
}

pub(crate) fn load_entries(
    shared: &crate::cli::SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Amp, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(
    shared: &crate::cli::SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<LoadedEntry>> {
    let mut entries = Vec::new();
    let tz = parse_tz(shared.timezone.as_deref());
    for path in paths()? {
        let threads_dir = path.join("threads");
        let mut files = Vec::new();
        collect_files_with_extension(&threads_dir, "json", &mut files);
        for file in files {
            entries.extend(read_thread_file(
                &file,
                tz.as_ref(),
                shared.mode,
                Some(pricing),
            )?);
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Ok(env_paths) = env::var("AMP_DATA_DIR") {
        for raw in env_paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            let path = PathBuf::from(raw);
            if path.is_dir() && seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        return Ok(paths);
    }

    let home =
        crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
    let path = home.join(".local/share/amp");
    if path.is_dir() && seen.insert(path.clone()) {
        paths.push(path);
    }
    Ok(paths)
}

pub(crate) fn read_thread_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Result<Vec<LoadedEntry>> {
    let content = fs::read_to_string(path)?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(Vec::new());
    };
    let Some(thread_id) = non_empty_json_string(value.get("id")) else {
        return Ok(Vec::new());
    };
    let cache_tokens = cache_tokens_by_message_id(value.get("messages"));
    let Some(events) = value
        .get("usageLedger")
        .and_then(|ledger| ledger.get("events"))
        .and_then(Value::as_array)
    else {
        return Ok(Vec::new());
    };

    let mut entries = Vec::new();
    for event in events {
        let Some(timestamp_text) = non_empty_json_string(event.get("timestamp")) else {
            continue;
        };
        let Some(timestamp) = crate::parse_ts_timestamp(&timestamp_text) else {
            continue;
        };
        let Some(model) = non_empty_json_string(event.get("model")) else {
            continue;
        };
        let Some(tokens) = event.get("tokens") else {
            continue;
        };
        let cache = event
            .get("toMessageId")
            .and_then(Value::as_i64)
            .and_then(|id| cache_tokens.get(&id).copied())
            .unwrap_or_default();
        let usage = TokenUsageRaw {
            input_tokens: json_value_u64(tokens.get("input")),
            output_tokens: json_value_u64(tokens.get("output")),
            cache_creation_input_tokens: cache.0,
            cache_read_input_tokens: cache.1,
            speed: None,
        };
        if usage.input_tokens == 0
            && usage.output_tokens == 0
            && usage.cache_creation_input_tokens == 0
            && usage.cache_read_input_tokens == 0
        {
            continue;
        }
        let data = UsageEntry {
            session_id: Some(thread_id.clone()),
            timestamp: timestamp_text,
            version: None,
            message: UsageMessage {
                usage,
                model: Some(model.clone()),
                id: non_empty_json_string(event.get("id")),
            },
            cost_usd: None,
            request_id: None,
            is_api_error_message: None,
        };
        let cost = calculate_cost(&data, mode, pricing);
        entries.push(LoadedEntry {
            date: format_date_tz(timestamp, tz),
            timestamp,
            project: Arc::from("amp"),
            session_id: Arc::from(thread_id.as_str()),
            project_path: Arc::from("Amp"),
            cost,
            credits: json_value_f64(event.get("credits")),
            model: Some(model),
            usage_limit_reset_time: None,
            extra_total_tokens: 0,
            data,
        });
    }
    Ok(entries)
}

fn cache_tokens_by_message_id(messages: Option<&Value>) -> HashMap<i64, (u64, u64)> {
    let mut cache_tokens = HashMap::new();
    let Some(messages) = messages.and_then(Value::as_array) else {
        return cache_tokens;
    };
    for message in messages {
        if message.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message_id) = message.get("messageId").and_then(Value::as_i64) else {
            continue;
        };
        let usage = message.get("usage");
        cache_tokens.insert(
            message_id,
            (
                json_value_u64(usage.and_then(|usage| usage.get("cacheCreationInputTokens"))),
                json_value_u64(usage.and_then(|usage| usage.get("cacheReadInputTokens"))),
            ),
        );
    }
    cache_tokens
}

fn json_value_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

fn print_table(
    kind: AgentReportKind,
    rows: &[crate::UsageSummary],
    shared: &crate::cli::SharedArgs,
) {
    if rows.is_empty() {
        eprintln!("No Amp usage data found.");
        return;
    }
    let terminal_width = crate::terminal_width();
    let compact = shared.compact || terminal_width < crate::USAGE_COMPACT_WIDTH_THRESHOLD;
    print_box_title(
        &format!("Amp Token Usage Report - {}", agent_report_label(kind)),
        shared,
    );
    let first_column = opencode::first_column(kind);
    let mut table = if compact {
        SimpleTable::new(
            vec![
                first_column,
                "Models",
                "Input",
                "Output",
                "Credits",
                "Cost (USD)",
            ],
            vec![
                Align::Left,
                Align::Left,
                Align::Right,
                Align::Right,
                Align::Right,
                Align::Right,
            ],
            shared,
        )
    } else {
        SimpleTable::new(
            vec![
                first_column,
                "Models",
                "Input",
                "Output",
                "Cache Create",
                "Cache Read",
                "Total Tokens",
                "Credits",
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
                Align::Right,
            ],
            shared,
        )
    }
    .with_terminal_width(terminal_width)
    .with_date_compaction(true);

    for row in rows {
        let label = row
            .date
            .as_deref()
            .or(row.month.as_deref())
            .or(row.session_id.as_deref())
            .unwrap_or("");
        let models = format_models_multiline(&row.models_used);
        if compact {
            table.push(vec![
                label.to_string(),
                models,
                format_number(row.input_tokens),
                format_number(row.output_tokens),
                format!("{:.2}", row.credits.unwrap_or_default()),
                format_currency(row.total_cost),
            ]);
        } else {
            table.push(vec![
                label.to_string(),
                models,
                format_number(row.input_tokens),
                format_number(row.output_tokens),
                format_number(row.cache_creation_tokens),
                format_number(row.cache_read_tokens),
                format_number(
                    row.input_tokens
                        + row.output_tokens
                        + row.cache_creation_tokens
                        + row.cache_read_tokens,
                ),
                format!("{:.2}", row.credits.unwrap_or_default()),
                format_currency(row.total_cost),
            ]);
        }
    }

    let totals = totals_json(rows);
    table.separator();
    let credits = totals
        .get("credits")
        .and_then(Value::as_f64)
        .unwrap_or_default();
    if compact {
        table.push(vec![
            crate::color(shared, "Total", Color::Yellow),
            String::new(),
            crate::color(
                shared,
                format_number(json_value_u64(totals.get("inputTokens"))),
                Color::Yellow,
            ),
            crate::color(
                shared,
                format_number(json_value_u64(totals.get("outputTokens"))),
                Color::Yellow,
            ),
            crate::color(shared, format!("{credits:.2}"), Color::Yellow),
            crate::color(
                shared,
                format_currency(
                    totals
                        .get("totalCost")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                ),
                Color::Yellow,
            ),
        ]);
    } else {
        let input = json_value_u64(totals.get("inputTokens"));
        let output = json_value_u64(totals.get("outputTokens"));
        let cache_create = json_value_u64(totals.get("cacheCreationTokens"));
        let cache_read = json_value_u64(totals.get("cacheReadTokens"));
        table.push(vec![
            crate::color(shared, "Total", Color::Yellow),
            String::new(),
            crate::color(shared, format_number(input), Color::Yellow),
            crate::color(shared, format_number(output), Color::Yellow),
            crate::color(shared, format_number(cache_create), Color::Yellow),
            crate::color(shared, format_number(cache_read), Color::Yellow),
            crate::color(
                shared,
                format_number(input + output + cache_create + cache_read),
                Color::Yellow,
            ),
            crate::color(shared, format!("{credits:.2}"), Color::Yellow),
            crate::color(
                shared,
                format_currency(
                    totals
                        .get("totalCost")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0),
                ),
                Color::Yellow,
            ),
        ]);
    }
    table.print();
}

fn agent_report_label(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "Daily",
        AgentReportKind::Weekly => "Weekly",
        AgentReportKind::Monthly => "Monthly",
        AgentReportKind::Session => "Session",
    }
}
