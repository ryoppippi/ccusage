use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::{
    adapter::{amp, codex, opencode, pi},
    cli::{AgentCommandArgs, AgentReportKind, CodexSpeed, SharedArgs, SortOrder, WeekDay},
    color, filter_loaded_entries_by_date, format_currency, format_models_multiline, format_number,
    json_float, print_box_title, print_json_or_jq, summarize_by_key, summarize_summaries_by_bucket,
    wants_json, Align, BucketKind, CodexGroup, Color, LoadedEntry, PricingMap, Result, SimpleTable,
    UsageSummary,
};

#[derive(Debug, Clone)]
struct AllRow {
    period: String,
    agent: &'static str,
    models_used: Vec<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
    total_cost: f64,
    metadata_agents: Option<Vec<&'static str>>,
    agent_breakdowns: Option<Vec<AllRow>>,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let rows = load_rows(args.kind, &shared)?;
    if wants_json(&shared) {
        return print_json_or_jq(report_json(&rows, args.kind), shared.jq.as_deref());
    }
    print_table(&rows, args.kind, &shared);
    Ok(())
}

fn load_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<Vec<AllRow>> {
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    if kind == AgentReportKind::Session {
        let mut rows = Vec::new();
        rows.extend(load_claude_rows(AgentReportKind::Session, shared)?);
        rows.extend(load_codex_rows(AgentReportKind::Session, shared, &pricing)?);
        rows.extend(load_opencode_rows(AgentReportKind::Session, shared)?);
        rows.extend(load_amp_rows(AgentReportKind::Session, shared, &pricing)?);
        rows.extend(load_pi_rows(AgentReportKind::Session, shared)?);
        sort_rows(&mut rows, &shared.order);
        return Ok(rows);
    }

    let mut rows = Vec::new();
    rows.extend(load_claude_rows(AgentReportKind::Daily, shared)?);
    rows.extend(load_codex_rows(AgentReportKind::Daily, shared, &pricing)?);
    rows.extend(load_opencode_rows(AgentReportKind::Daily, shared)?);
    rows.extend(load_amp_rows(AgentReportKind::Daily, shared, &pricing)?);
    rows.extend(load_pi_rows(AgentReportKind::Daily, shared)?);

    let mut aggregated = aggregate_rows(rows, kind);
    sort_rows(&mut aggregated, &shared.order);
    Ok(aggregated)
}

fn load_claude_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<Vec<AllRow>> {
    let mut entries = crate::load_entries(shared, None)?;
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = summarize_entries(&entries, kind)?;
    Ok(summary_rows("claude", summaries))
}

fn load_codex_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<AllRow>> {
    let mut events = crate::load_codex_events(shared)?;
    codex::filter_events_by_date(&mut events, shared)?;
    let groups = codex::aggregate_events(&events, kind, shared.timezone.as_deref())?;
    let speed = codex::resolve_codex_speed(CodexSpeed::Auto);
    Ok(groups
        .iter()
        .map(|(period, group)| codex_group_row(period, group, &pricing, speed))
        .collect())
}

fn load_opencode_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<Vec<AllRow>> {
    let mut entries = opencode::load_entries(shared)?;
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = opencode::summarize_entries(&entries, kind)?;
    Ok(summary_rows("opencode", summaries))
}

fn load_amp_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<Vec<AllRow>> {
    let mut entries = amp::load_entries(shared, pricing)?;
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = amp::summarize_entries(&entries, kind)?;
    Ok(summary_rows("amp", summaries))
}

fn load_pi_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<Vec<AllRow>> {
    let mut entries = pi::load_entries(shared, None)?;
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = pi::summarize_entries(&entries, kind)?;
    Ok(summary_rows("pi", summaries))
}

fn summarize_entries(entries: &[LoadedEntry], kind: AgentReportKind) -> Result<Vec<UsageSummary>> {
    match kind {
        AgentReportKind::Daily => summarize_by_key(
            entries,
            |entry| entry.date.clone(),
            |date| (date.to_string(), None),
        ),
        AgentReportKind::Monthly => {
            let daily = summarize_entries(entries, AgentReportKind::Daily)?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Monthly,
                WeekDay::Sunday,
            ))
        }
        AgentReportKind::Weekly => {
            let daily = summarize_entries(entries, AgentReportKind::Daily)?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Weekly,
                WeekDay::Monday,
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
    }
}

fn summary_rows(agent: &'static str, summaries: Vec<UsageSummary>) -> Vec<AllRow> {
    summaries
        .into_iter()
        .filter_map(|summary| {
            let period = summary
                .date
                .or(summary.week)
                .or(summary.month)
                .or(summary.session_id)?;
            let total_tokens = summary.input_tokens
                + summary.output_tokens
                + summary.cache_creation_tokens
                + summary.cache_read_tokens;
            Some(AllRow {
                period,
                agent,
                models_used: summary.models_used,
                input_tokens: summary.input_tokens,
                output_tokens: summary.output_tokens,
                cache_creation_tokens: summary.cache_creation_tokens,
                cache_read_tokens: summary.cache_read_tokens,
                total_tokens,
                total_cost: summary.total_cost,
                metadata_agents: Some(vec![agent]),
                agent_breakdowns: None,
            })
        })
        .collect()
}

fn codex_group_row(
    period: &str,
    group: &CodexGroup,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> AllRow {
    AllRow {
        period: period.to_string(),
        agent: "codex",
        models_used: group.models.keys().cloned().collect(),
        input_tokens: group.input_tokens,
        output_tokens: group.output_tokens,
        cache_creation_tokens: 0,
        cache_read_tokens: group.cached_input_tokens,
        total_tokens: group.total_tokens,
        total_cost: codex::calculate_group_cost(group, pricing, speed),
        metadata_agents: Some(vec!["codex"]),
        agent_breakdowns: None,
    }
}

fn aggregate_rows(rows: Vec<AllRow>, kind: AgentReportKind) -> Vec<AllRow> {
    let mut groups = BTreeMap::<String, AllAccumulator>::new();
    for mut row in rows {
        let period = match kind {
            AgentReportKind::Daily => row.period.clone(),
            AgentReportKind::Monthly => row
                .period
                .get(..7)
                .map_or_else(|| row.period.clone(), str::to_string),
            AgentReportKind::Weekly => crate::week_start(&row.period, WeekDay::Monday)
                .unwrap_or_else(|| row.period.clone()),
            AgentReportKind::Session => row.period.clone(),
        };
        row.period = period.clone();
        groups.entry(period).or_default().add(row);
    }
    groups
        .into_iter()
        .map(|(period, group)| group.into_row(period))
        .collect()
}

#[derive(Default)]
struct AllAccumulator {
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
    total_cost: f64,
    models: BTreeSet<String>,
    agents: BTreeSet<&'static str>,
    agent_breakdowns: Vec<AllRow>,
}

impl AllAccumulator {
    fn add(&mut self, row: AllRow) {
        self.input_tokens += row.input_tokens;
        self.output_tokens += row.output_tokens;
        self.cache_creation_tokens += row.cache_creation_tokens;
        self.cache_read_tokens += row.cache_read_tokens;
        self.total_tokens += row.total_tokens;
        self.total_cost += row.total_cost;
        self.models.extend(row.models_used.iter().cloned());
        if let Some(agents) = row.metadata_agents.as_ref() {
            self.agents.extend(agents.iter().copied());
        } else if row.agent != "all" {
            self.agents.insert(row.agent);
        }
        self.agent_breakdowns.push(AllRow {
            metadata_agents: Some(vec![row.agent]),
            agent_breakdowns: None,
            ..row
        });
    }

    fn into_row(self, period: String) -> AllRow {
        let mut agent_breakdowns = self.agent_breakdowns;
        agent_breakdowns.sort_by(|a, b| a.agent.cmp(b.agent));
        AllRow {
            period,
            agent: "all",
            models_used: self.models.into_iter().collect(),
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_creation_tokens: self.cache_creation_tokens,
            cache_read_tokens: self.cache_read_tokens,
            total_tokens: self.total_tokens,
            total_cost: self.total_cost,
            metadata_agents: Some(self.agents.into_iter().collect()),
            agent_breakdowns: Some(agent_breakdowns),
        }
    }
}

fn report_json(rows: &[AllRow], kind: AgentReportKind) -> Value {
    json!({
        rows_key(kind): rows.iter().map(row_json).collect::<Vec<_>>(),
        "totals": totals_json(rows),
    })
}

fn row_json(row: &AllRow) -> Value {
    let mut value = json!({
        "period": row.period,
        "agent": row.agent,
        "modelsUsed": row.models_used,
        "inputTokens": row.input_tokens,
        "outputTokens": row.output_tokens,
        "cacheCreationTokens": row.cache_creation_tokens,
        "cacheReadTokens": row.cache_read_tokens,
        "totalTokens": row.total_tokens,
        "totalCost": json_float(row.total_cost),
    });
    if let (Some(obj), Some(agents)) = (value.as_object_mut(), row.metadata_agents.as_ref()) {
        obj.insert("metadata".to_string(), json!({ "agents": agents }));
    }
    value
}

fn totals_json(rows: &[AllRow]) -> Value {
    json!({
        "inputTokens": rows.iter().map(|row| row.input_tokens).sum::<u64>(),
        "outputTokens": rows.iter().map(|row| row.output_tokens).sum::<u64>(),
        "cacheCreationTokens": rows.iter().map(|row| row.cache_creation_tokens).sum::<u64>(),
        "cacheReadTokens": rows.iter().map(|row| row.cache_read_tokens).sum::<u64>(),
        "totalTokens": rows.iter().map(|row| row.total_tokens).sum::<u64>(),
        "totalCost": json_float(rows.iter().map(|row| row.total_cost).sum::<f64>()),
    })
}

fn rows_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "daily",
        AgentReportKind::Weekly => "weekly",
        AgentReportKind::Monthly => "monthly",
        AgentReportKind::Session => "sessions",
    }
}

fn print_table(rows: &[AllRow], kind: AgentReportKind, shared: &SharedArgs) {
    if rows.is_empty() {
        eprintln!("No usage data found.");
        return;
    }
    let terminal_width = crate::terminal_width();
    let compact = shared.compact || terminal_width < crate::USAGE_COMPACT_WIDTH_THRESHOLD;
    print_box_title(&all_report_title(kind, rows), shared);
    let (headers, aligns) = all_table_columns(kind, compact);
    let mut table = SimpleTable::new(headers, aligns, shared)
        .with_terminal_width(terminal_width)
        .with_date_compaction(true);

    for row in rows {
        table.push(all_table_row(row, compact, false));
        if let Some(breakdowns) = row.agent_breakdowns.as_ref() {
            for breakdown in breakdowns {
                table.push(all_table_row(breakdown, compact, true));
            }
        }
    }
    table.separator();
    let totals = totals_json(rows);
    if compact {
        table.push(vec![
            color(shared, "Total", Color::Yellow),
            String::new(),
            String::new(),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("inputTokens"))),
                Color::Yellow,
            ),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("outputTokens"))),
                Color::Yellow,
            ),
            color(
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
        table.push(vec![
            color(shared, "Total", Color::Yellow),
            String::new(),
            String::new(),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("inputTokens"))),
                Color::Yellow,
            ),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("outputTokens"))),
                Color::Yellow,
            ),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("cacheCreationTokens"))),
                Color::Yellow,
            ),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("cacheReadTokens"))),
                Color::Yellow,
            ),
            color(
                shared,
                format_number(crate::json_value_u64(totals.get("totalTokens"))),
                Color::Yellow,
            ),
            color(
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
    if compact {
        eprintln!("\nRunning in Compact Mode");
        eprintln!("Expand terminal width to see cache metrics and total tokens");
    }
}

fn all_report_title(kind: AgentReportKind, rows: &[AllRow]) -> String {
    format!(
        "Coding (Agent) CLI Usage Report - {}\nDetected: {}",
        match kind {
            AgentReportKind::Daily => "Daily",
            AgentReportKind::Weekly => "Weekly",
            AgentReportKind::Monthly => "Monthly",
            AgentReportKind::Session => "Session",
        },
        detected_agent_labels(rows)
    )
}

fn detected_agent_labels(rows: &[AllRow]) -> String {
    let mut agents = BTreeSet::new();
    for row in rows {
        if let Some(metadata_agents) = row.metadata_agents.as_ref() {
            agents.extend(metadata_agents.iter().copied());
        } else if row.agent != "all" {
            agents.insert(row.agent);
        }
        if let Some(breakdowns) = row.agent_breakdowns.as_ref() {
            agents.extend(breakdowns.iter().map(|breakdown| breakdown.agent));
        }
    }
    if agents.is_empty() {
        return "None".to_string();
    }
    agents.into_iter().map(agent_label).collect::<Vec<_>>().join(", ")
}

fn all_table_row(row: &AllRow, compact: bool, breakdown: bool) -> Vec<String> {
    let period = if breakdown {
        String::new()
    } else {
        row.period.clone()
    };
    let agent = if breakdown {
        format!("- {}", agent_label(row.agent))
    } else if row.agent_breakdowns.is_some() {
        "All".to_string()
    } else {
        agent_label(row.agent).to_string()
    };
    let models = if row.agent_breakdowns.is_some() {
        String::new()
    } else {
        format_models_multiline(&row.models_used)
    };

    if compact {
        return vec![
            period,
            agent,
            models,
            format_number(row.input_tokens),
            format_number(row.output_tokens),
            format_currency(row.total_cost),
        ];
    }

    vec![
        period,
        agent,
        models,
        format_number(row.input_tokens),
        format_number(row.output_tokens),
        format_number(row.cache_creation_tokens),
        format_number(row.cache_read_tokens),
        format_number(row.total_tokens),
        format_currency(row.total_cost),
    ]
}

fn all_table_columns(kind: AgentReportKind, compact: bool) -> (Vec<&'static str>, Vec<Align>) {
    if compact {
        return (
            vec![
                first_column(kind),
                "Agent",
                "Models",
                "Input",
                "Output",
                "Cost (USD)",
            ],
            vec![
                Align::Left,
                Align::Left,
                Align::Left,
                Align::Right,
                Align::Right,
                Align::Right,
            ],
        );
    }

    (
        vec![
            first_column(kind),
            "Agent",
            "Models",
            "Input",
            "Output",
            "Cache Create",
            "Cache Read",
            "Total Tokens",
            "Cost (USD)",
        ],
        vec![
            Align::Left,
            Align::Left,
            Align::Left,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
            Align::Right,
        ],
    )
}

fn sort_rows(rows: &mut [AllRow], order: &SortOrder) {
    rows.sort_by(|a, b| match a.period.cmp(&b.period) {
        std::cmp::Ordering::Equal => a.agent.cmp(b.agent),
        order => order,
    });
    if *order == SortOrder::Desc {
        rows.reverse();
    }
}

fn first_column(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "Date",
        AgentReportKind::Weekly => "Week",
        AgentReportKind::Monthly => "Month",
        AgentReportKind::Session => "Session",
    }
}

fn agent_label(agent: &str) -> &str {
    match agent {
        "all" => "All",
        "claude" => "Claude",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "amp" => "Amp",
        "pi" => "pi-agent",
        _ => agent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregates_daily_agent_rows_by_period() {
        let rows = aggregate_rows(
            vec![
                AllRow {
                    period: "2026-01-02".to_string(),
                    agent: "codex",
                    models_used: vec!["gpt-5".to_string()],
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 10,
                    total_tokens: 120,
                    total_cost: 0.01,
                    metadata_agents: Some(vec!["codex"]),
                    agent_breakdowns: None,
                },
                AllRow {
                    period: "2026-01-02".to_string(),
                    agent: "claude",
                    models_used: vec!["claude-sonnet-4-20250514".to_string()],
                    input_tokens: 50,
                    output_tokens: 25,
                    cache_creation_tokens: 5,
                    cache_read_tokens: 3,
                    total_tokens: 83,
                    total_cost: 0.02,
                    metadata_agents: Some(vec!["claude"]),
                    agent_breakdowns: None,
                },
            ],
            AgentReportKind::Daily,
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].period, "2026-01-02");
        assert_eq!(rows[0].agent, "all");
        assert_eq!(rows[0].input_tokens, 150);
        assert_eq!(rows[0].output_tokens, 45);
        assert_eq!(rows[0].cache_read_tokens, 13);
        assert_eq!(rows[0].total_tokens, 203);
        assert_eq!(
            rows[0].models_used,
            vec!["claude-sonnet-4-20250514".to_string(), "gpt-5".to_string()]
        );
        assert_eq!(rows[0].metadata_agents, Some(vec!["claude", "codex"]));
        let breakdowns = rows[0].agent_breakdowns.as_ref().unwrap();
        assert_eq!(breakdowns.len(), 2);
        assert_eq!(breakdowns[0].agent, "claude");
        assert_eq!(breakdowns[0].period, "2026-01-02");
        assert_eq!(breakdowns[1].agent, "codex");
    }

    #[test]
    fn renders_all_report_json_with_period_and_agent_metadata() {
        let rows = vec![AllRow {
            period: "2026-01-02".to_string(),
            agent: "all",
            models_used: vec!["gpt-5".to_string()],
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_tokens: 0,
            cache_read_tokens: 10,
            total_tokens: 130,
            total_cost: 0.01,
            metadata_agents: Some(vec!["codex"]),
            agent_breakdowns: None,
        }];

        let report = report_json(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["period"], "2026-01-02");
        assert_eq!(report["daily"][0]["agent"], "all");
        assert_eq!(report["daily"][0]["metadata"]["agents"], json!(["codex"]));
        assert_eq!(report["totals"]["totalTokens"], 130);
    }

    #[test]
    fn all_table_rows_match_main_agent_breakdown_display() {
        let row = AllRow {
            period: "2026-01-02".to_string(),
            agent: "all",
            models_used: vec!["gpt-5".to_string()],
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_tokens: 0,
            cache_read_tokens: 10,
            total_tokens: 130,
            total_cost: 0.01,
            metadata_agents: Some(vec!["codex"]),
            agent_breakdowns: Some(vec![AllRow {
                period: "2026-01-02".to_string(),
                agent: "codex",
                models_used: vec!["gpt-5".to_string()],
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_tokens: 0,
                cache_read_tokens: 10,
                total_tokens: 130,
                total_cost: 0.01,
                metadata_agents: Some(vec!["codex"]),
                agent_breakdowns: None,
            }]),
        };

        assert_eq!(
            all_table_row(&row, true, false),
            vec!["2026-01-02", "All", "", "100", "20", "$0.01"]
        );
        assert_eq!(
            all_table_row(row.agent_breakdowns.as_ref().unwrap().first().unwrap(), true, true),
            vec!["", "- Codex", "- gpt-5", "100", "20", "$0.01"]
        );
    }

    #[test]
    fn all_report_title_lists_detected_agents() {
        let row = AllRow {
            period: "2026-01-02".to_string(),
            agent: "all",
            models_used: Vec::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            total_tokens: 0,
            total_cost: 0.0,
            metadata_agents: Some(vec!["claude", "codex"]),
            agent_breakdowns: None,
        };

        assert_eq!(
            all_report_title(AgentReportKind::Daily, &[row]),
            "Coding (Agent) CLI Usage Report - Daily\nDetected: Claude, Codex"
        );
    }

    #[test]
    fn compact_table_columns_omit_cache_and_total_token_metrics() {
        let (headers, aligns) = all_table_columns(AgentReportKind::Daily, true);

        assert_eq!(
            headers,
            vec!["Date", "Agent", "Models", "Input", "Output", "Cost (USD)"]
        );
        assert_eq!(
            aligns,
            vec![
                Align::Left,
                Align::Left,
                Align::Left,
                Align::Right,
                Align::Right,
                Align::Right,
            ]
        );
    }

    #[test]
    fn full_table_columns_include_cache_and_total_token_metrics() {
        let (headers, aligns) = all_table_columns(AgentReportKind::Daily, false);

        assert_eq!(
            headers,
            vec![
                "Date",
                "Agent",
                "Models",
                "Input",
                "Output",
                "Cache Create",
                "Cache Read",
                "Total Tokens",
                "Cost (USD)",
            ]
        );
        assert_eq!(headers.len(), aligns.len());
    }
}
