use std::collections::BTreeMap;

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{json, Value};

use crate::{
    cli::{AgentCommandArgs, AgentReportKind, SharedArgs, WeekDay},
    color, format_currency, format_date_tz, format_number, json_float, json_value_u64,
    load_codex_events, log_level, parse_ts_timestamp, parse_tz, print_json_or_jq, wants_json,
    week_start, Align, CodexGroup, CodexModelUsage, CodexTokenUsageEvent, Color, PricingMap,
    Result, SimpleTable,
};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, log_level() != Some(0));
    let mut events = load_codex_events(&shared)?;
    filter_events_by_date(&mut events, &shared)?;
    let output = report_json(&events, args.kind, shared.timezone.as_deref(), &pricing)?;
    if wants_json(&shared) {
        return print_json_or_jq(output, shared.jq.as_deref());
    }
    print_table(&output, args.kind, &shared);
    Ok(())
}

pub(crate) fn report_json(
    events: &[CodexTokenUsageEvent],
    kind: AgentReportKind,
    timezone: Option<&str>,
    pricing: &PricingMap,
) -> Result<Value> {
    let groups = aggregate_events(events, kind, timezone)?;
    let rows = groups
        .iter()
        .map(|(period, group)| group_json(period, group, kind, pricing))
        .collect::<Vec<_>>();
    let totals = totals_json(groups.values(), pricing);
    Ok(json!({
        rows_key(kind): rows,
        "totals": totals,
    }))
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
    Ok(groups)
}

pub(crate) fn calculate_group_cost(group: &CodexGroup, pricing: &PricingMap) -> f64 {
    group
        .models
        .iter()
        .map(|(model, usage)| calculate_model_cost(model, usage, pricing))
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
) -> Value {
    let cost = calculate_group_cost(group, pricing);
    let mut row = json!({
        period_key(kind): period,
        "inputTokens": group.input_tokens,
        "cachedInputTokens": group.cached_input_tokens,
        "outputTokens": group.output_tokens,
        "reasoningOutputTokens": group.reasoning_output_tokens,
        "totalTokens": group.total_tokens,
        "costUSD": json_float(cost),
        "models": group.models,
    });
    if kind == AgentReportKind::Session {
        row["lastActivity"] = json!(group.last_activity);
        let separator = period.rfind('/');
        row["sessionFile"] = json!(separator.map_or(period, |index| &period[index + 1..]));
        row["directory"] = json!(separator.map_or("", |index| &period[..index]));
    }
    row
}

fn totals_json<'a>(groups: impl Iterator<Item = &'a CodexGroup>, pricing: &PricingMap) -> Value {
    let mut input = 0;
    let mut cached = 0;
    let mut output = 0;
    let mut reasoning = 0;
    let mut total = 0;
    let mut cost = 0.0;
    for group in groups {
        input += group.input_tokens;
        cached += group.cached_input_tokens;
        output += group.output_tokens;
        reasoning += group.reasoning_output_tokens;
        total += group.total_tokens;
        cost += calculate_group_cost(group, pricing);
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

fn calculate_model_cost(model: &str, usage: &CodexModelUsage, pricing: &PricingMap) -> f64 {
    let Some(pricing) = pricing.find(model) else {
        return 0.0;
    };
    let non_cached_input = usage.input_tokens.saturating_sub(usage.cached_input_tokens);
    non_cached_input as f64 * pricing.input
        + usage.cached_input_tokens as f64 * pricing.cache_read
        + usage.output_tokens as f64 * pricing.output
}

fn print_table(output: &Value, kind: AgentReportKind, shared: &SharedArgs) {
    let rows = output
        .get(rows_key(kind))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rows.is_empty() {
        eprintln!("No Codex usage data found.");
        return;
    }
    let first_column = match kind {
        AgentReportKind::Daily => "Date",
        AgentReportKind::Weekly => "Week",
        AgentReportKind::Monthly => "Month",
        AgentReportKind::Session => "Session",
    };
    let mut table = SimpleTable::new(
        vec![
            first_column,
            "Models",
            "Input",
            "Cached Input",
            "Output",
            "Reasoning",
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
    for row in &rows {
        let label = row
            .get(period_key(kind))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let models = row
            .get("models")
            .and_then(Value::as_object)
            .map(|models| {
                models
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        table.push(vec![
            label.to_string(),
            models,
            format_number(json_value_u64(row.get("inputTokens"))),
            format_number(json_value_u64(row.get("cachedInputTokens"))),
            format_number(json_value_u64(row.get("outputTokens"))),
            format_number(json_value_u64(row.get("reasoningOutputTokens"))),
            format_number(json_value_u64(row.get("totalTokens"))),
            format_currency(row.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0)),
        ]);
    }
    table.separator();
    let totals = output.get("totals").unwrap_or(&Value::Null);
    table.push(vec![
        color(shared, "Total", Color::Yellow),
        String::new(),
        color(
            shared,
            format_number(json_value_u64(totals.get("inputTokens"))),
            Color::Yellow,
        ),
        color(
            shared,
            format_number(json_value_u64(totals.get("cachedInputTokens"))),
            Color::Yellow,
        ),
        color(
            shared,
            format_number(json_value_u64(totals.get("outputTokens"))),
            Color::Yellow,
        ),
        color(
            shared,
            format_number(json_value_u64(totals.get("reasoningOutputTokens"))),
            Color::Yellow,
        ),
        color(
            shared,
            format_number(json_value_u64(totals.get("totalTokens"))),
            Color::Yellow,
        ),
        color(
            shared,
            format_currency(totals.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0)),
            Color::Yellow,
        ),
    ]);
    table.print();
}
