use std::{
    collections::{BTreeMap, BTreeSet},
    sync::mpsc,
    thread,
};

use serde_json::{json, Value};

use crate::{
    adapter::{
        amp, codebuff, codex, copilot, droid, gemini, goose, hermes, kilo, kimi, openclaw,
        opencode, pi, qwen,
    },
    cli::{AgentCommandArgs, AgentReportKind, CodexSpeed, SharedArgs, SortOrder, WeekDay},
    color, filter_loaded_entries_by_date, format_currency, format_models_multiline, format_number,
    json_float, print_box_title, print_json_or_jq, short_model_name, summarize_by_key,
    summarize_summaries_by_bucket, wants_json, Align, BucketKind, CodexGroup, Color, DateFilter,
    LoadedEntry, ModelBreakdown, PricingMap, Result, SessionAccumulator, SimpleTable, UsageSummary,
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
    metadata: Option<Value>,
    metadata_agents: Option<Vec<&'static str>>,
    agent_breakdowns: Option<Vec<AllRow>>,
    model_breakdowns: Vec<ModelBreakdown>,
}

struct AllLoadResult {
    rows: Vec<AllRow>,
    detected_agents: Vec<&'static str>,
}

struct AgentRows {
    rows: Vec<AllRow>,
    detected: bool,
}

struct AgentLoadSpec<'scope> {
    index: usize,
    agent: &'static str,
    progress_agent: crate::progress::UsageLoadAgent,
    load: Box<dyn FnOnce() -> Result<AgentRows> + Send + 'scope>,
}

struct LoadedAgentRows {
    index: usize,
    agent: &'static str,
    agent_rows: AgentRows,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let result = load_rows(args.kind, &shared)?;
    if wants_json(&shared) {
        return print_json_or_jq(report_json(&result.rows, args.kind), shared.jq.as_deref());
    }
    print_table(&result.rows, args.kind, &shared, &result.detected_agents);
    Ok(())
}

fn load_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AllLoadResult> {
    let mut progress = crate::progress::UsageLoadProgress::new(
        crate::log_level() != Some(0)
            && crate::progress::should_show_usage_load_progress(
                shared.json,
                crate::progress::usage_load_output_is_tty(),
            ),
    );
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let load_kind = match kind {
        AgentReportKind::Session => AgentReportKind::Session,
        AgentReportKind::Daily | AgentReportKind::Weekly | AgentReportKind::Monthly => {
            AgentReportKind::Daily
        }
    };
    let loader_shared = SharedArgs {
        json: true,
        ..shared.clone()
    };
    let loaded = load_agent_rows_parallel(
        vec![
            AgentLoadSpec {
                index: 0,
                agent: "claude",
                progress_agent: crate::progress::UsageLoadAgent::Claude,
                load: Box::new(|| load_claude_rows(load_kind, &loader_shared)),
            },
            AgentLoadSpec {
                index: 1,
                agent: "codex",
                progress_agent: crate::progress::UsageLoadAgent::Codex,
                load: Box::new(|| load_codex_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 2,
                agent: "opencode",
                progress_agent: crate::progress::UsageLoadAgent::OpenCode,
                load: Box::new(|| load_opencode_rows(load_kind, &loader_shared)),
            },
            AgentLoadSpec {
                index: 3,
                agent: "amp",
                progress_agent: crate::progress::UsageLoadAgent::Amp,
                load: Box::new(|| load_amp_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 4,
                agent: "droid",
                progress_agent: crate::progress::UsageLoadAgent::Droid,
                load: Box::new(|| load_droid_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 5,
                agent: "codebuff",
                progress_agent: crate::progress::UsageLoadAgent::Codebuff,
                load: Box::new(|| load_codebuff_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 6,
                agent: "hermes",
                progress_agent: crate::progress::UsageLoadAgent::Hermes,
                load: Box::new(|| load_hermes_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 7,
                agent: "pi",
                progress_agent: crate::progress::UsageLoadAgent::Pi,
                load: Box::new(|| load_pi_rows(load_kind, &loader_shared)),
            },
            AgentLoadSpec {
                index: 8,
                agent: "goose",
                progress_agent: crate::progress::UsageLoadAgent::Goose,
                load: Box::new(|| load_goose_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 9,
                agent: "openclaw",
                progress_agent: crate::progress::UsageLoadAgent::OpenClaw,
                load: Box::new(|| load_openclaw_rows(load_kind, &loader_shared)),
            },
            AgentLoadSpec {
                index: 10,
                agent: "kilo",
                progress_agent: crate::progress::UsageLoadAgent::Kilo,
                load: Box::new(|| load_kilo_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 11,
                agent: "copilot",
                progress_agent: crate::progress::UsageLoadAgent::Copilot,
                load: Box::new(|| load_copilot_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 12,
                agent: "gemini",
                progress_agent: crate::progress::UsageLoadAgent::Gemini,
                load: Box::new(|| load_gemini_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 13,
                agent: "kimi",
                progress_agent: crate::progress::UsageLoadAgent::Kimi,
                load: Box::new(|| load_kimi_rows(load_kind, &loader_shared, &pricing)),
            },
            AgentLoadSpec {
                index: 14,
                agent: "qwen",
                progress_agent: crate::progress::UsageLoadAgent::Qwen,
                load: Box::new(|| load_qwen_rows(load_kind, &loader_shared)),
            },
        ],
        &mut progress,
    )?;
    let mut detected_agents = Vec::new();
    let mut rows = Vec::new();
    for loaded in loaded {
        append_agent_rows(
            &mut rows,
            &mut detected_agents,
            loaded.agent,
            loaded.agent_rows,
        );
    }
    if kind == AgentReportKind::Session {
        for row in &mut rows {
            row.metadata_agents = None;
        }
        sort_rows(&mut rows, &shared.order);
        return Ok(AllLoadResult {
            rows,
            detected_agents,
        });
    }

    let mut aggregated = aggregate_rows(rows, kind);
    sort_rows(&mut aggregated, &shared.order);
    Ok(AllLoadResult {
        rows: aggregated,
        detected_agents,
    })
}

fn load_agent_rows_parallel(
    specs: Vec<AgentLoadSpec<'_>>,
    progress: &mut crate::progress::UsageLoadProgress,
) -> Result<Vec<LoadedAgentRows>> {
    for spec in &specs {
        progress.start(spec.progress_agent);
    }

    thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel();
        let mut handles = Vec::with_capacity(specs.len());
        for spec in specs {
            let sender = sender.clone();
            handles.push((
                spec.index,
                spec.progress_agent,
                scope.spawn(move || {
                    let result = (spec.load)();
                    let _ = sender.send((spec.index, spec.agent, spec.progress_agent, result));
                }),
            ));
        }
        drop(sender);

        let mut loaded = Vec::with_capacity(handles.len());
        let mut errors = Vec::new();
        for (index, agent, progress_agent, result) in receiver {
            match result {
                Ok(agent_rows) => {
                    progress.succeed(progress_agent);
                    loaded.push(LoadedAgentRows {
                        index,
                        agent,
                        agent_rows,
                    });
                }
                Err(error) => {
                    progress.fail(progress_agent);
                    errors.push((index, error));
                }
            }
        }

        for (index, progress_agent, handle) in handles {
            if handle.join().is_err() {
                progress.fail(progress_agent);
                errors.push((index, crate::cli_error("agent loader panicked")));
            }
        }

        errors.sort_by_key(|(index, _)| *index);
        if let Some((_, error)) = errors.into_iter().next() {
            return Err(error);
        }

        loaded.sort_by_key(|loaded| loaded.index);
        Ok(loaded)
    })
}

fn append_agent_rows(
    rows: &mut Vec<AllRow>,
    detected_agents: &mut Vec<&'static str>,
    agent: &'static str,
    agent_rows: AgentRows,
) {
    if agent_rows.detected {
        detected_agents.push(agent);
    }
    rows.extend(agent_rows.rows);
}

fn load_summary_agent_rows(
    agent: &'static str,
    kind: AgentReportKind,
    shared: &SharedArgs,
    load_entries: impl FnOnce() -> Result<Vec<LoadedEntry>>,
    summarize_entries: impl FnOnce(&[LoadedEntry], AgentReportKind) -> Result<Vec<UsageSummary>>,
) -> Result<AgentRows> {
    let mut entries = load_entries()?;
    let detected = !entries.is_empty();
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = summarize_entries(&entries, kind)?;
    Ok(AgentRows {
        rows: summary_rows(agent, summaries),
        detected,
    })
}

fn load_claude_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    let mut entries = crate::load_entries(shared, None)?;
    let detected = !entries.is_empty();
    let summaries = if kind == AgentReportKind::Session {
        let mut summaries = summarize_entry_sessions(&entries, shared.timezone.as_deref())?;
        filter_session_summaries(&mut summaries, shared);
        summaries
    } else {
        filter_loaded_entries_by_date(&mut entries, shared);
        summarize_entries(&entries, kind)?
    };
    Ok(AgentRows {
        rows: summary_rows("claude", summaries),
        detected,
    })
}

fn load_codex_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    let mut events = crate::load_codex_events(shared)?;
    let detected = !events.is_empty();
    codex::filter_events_by_date(&mut events, shared)?;
    let groups = codex::aggregate_events(&events, kind, shared.timezone.as_deref())?;
    let speed = codex::resolve_codex_speed(CodexSpeed::Auto);
    Ok(AgentRows {
        rows: groups
            .iter()
            .map(|(period, group)| codex_group_row(period, group, pricing, speed))
            .collect(),
        detected,
    })
}

fn load_opencode_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    load_summary_agent_rows(
        "opencode",
        kind,
        shared,
        || opencode::loader::load_entries(shared),
        opencode::summarize_entries,
    )
}

fn load_amp_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "amp",
        kind,
        shared,
        || amp::load_entries(shared, pricing),
        amp::summarize_entries,
    )
}

fn load_droid_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "droid",
        kind,
        shared,
        || droid::load_entries(shared, pricing),
        droid::summarize_entries,
    )
}

fn load_codebuff_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "codebuff",
        kind,
        shared,
        || codebuff::load_entries(shared, pricing),
        codebuff::summarize_entries,
    )
}

fn load_hermes_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "hermes",
        kind,
        shared,
        || hermes::load_entries(shared, pricing),
        hermes::summarize_entries,
    )
}

fn load_pi_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    let mut entries = pi::load_entries(shared, None)?;
    let detected = !entries.is_empty();
    let summaries = if kind == AgentReportKind::Session {
        let mut summaries = summarize_entry_sessions(&entries, shared.timezone.as_deref())?;
        filter_session_summaries(&mut summaries, shared);
        summaries
    } else {
        filter_loaded_entries_by_date(&mut entries, shared);
        pi::summarize_entries(&entries, kind)?
    };
    Ok(AgentRows {
        rows: summary_rows("pi", summaries),
        detected,
    })
}

fn load_goose_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "goose",
        kind,
        shared,
        || goose::load_entries(shared, pricing),
        goose::summarize_entries,
    )
}

fn load_openclaw_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    load_summary_agent_rows(
        "openclaw",
        kind,
        shared,
        || openclaw::load_entries(shared, None),
        openclaw::summarize_entries,
    )
}

fn load_copilot_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "copilot",
        kind,
        shared,
        || copilot::load_entries(shared, pricing),
        copilot::summarize_entries,
    )
}

fn load_kilo_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "kilo",
        kind,
        shared,
        || kilo::load_entries(shared, pricing),
        kilo::summarize_entries,
    )
}

fn load_gemini_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "gemini",
        kind,
        shared,
        || gemini::load_entries(shared, pricing),
        gemini::summarize_entries,
    )
}

fn load_kimi_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        "kimi",
        kind,
        shared,
        || kimi::load_entries(shared, pricing),
        kimi::summarize_entries,
    )
}

fn load_qwen_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    let mut entries = qwen::load_entries(shared)?;
    let detected = !entries.is_empty() || qwen::has_data();
    if kind == AgentReportKind::Session {
        let mut summaries = qwen::summarize_entries(&entries, kind)?;
        filter_session_summaries(&mut summaries, shared);
        return Ok(AgentRows {
            rows: summary_rows("qwen", summaries),
            detected,
        });
    }
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = qwen::summarize_entries(&entries, kind)?;
    Ok(AgentRows {
        rows: summary_rows("qwen", summaries),
        detected,
    })
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

fn summarize_entry_sessions(
    entries: &[LoadedEntry],
    timezone: Option<&str>,
) -> Result<Vec<UsageSummary>> {
    let mut groups = BTreeMap::<(String, String), SessionAccumulator>::new();
    for entry in entries {
        groups
            .entry((entry.project_path.to_string(), entry.session_id.to_string()))
            .or_default()
            .add_entry(entry);
    }
    groups
        .into_values()
        .map(|group| group.into_summary(timezone))
        .collect()
}

fn filter_session_summaries(rows: &mut Vec<UsageSummary>, shared: &SharedArgs) {
    let date_filter = DateFilter::new(shared.since.as_deref(), shared.until.as_deref());
    if !date_filter.is_empty() {
        rows.retain(|row| {
            let date = row
                .last_activity
                .as_deref()
                .unwrap_or_default()
                .replace('-', "");
            date_filter.contains_compact_date(&date)
        });
    }
}

fn summary_rows(agent: &'static str, summaries: Vec<UsageSummary>) -> Vec<AllRow> {
    summaries
        .into_iter()
        .filter_map(|summary| {
            let period = summary
                .date
                .as_ref()
                .or(summary.week.as_ref())
                .or(summary.month.as_ref())
                .or(summary.session_id.as_ref())?
                .clone();
            let total_tokens = summary.total_tokens();
            if total_tokens == 0 {
                return None;
            }
            let metadata = summary_metadata(agent, &summary);
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
                metadata,
                metadata_agents: Some(vec![agent]),
                agent_breakdowns: None,
                model_breakdowns: summary.model_breakdowns,
            })
        })
        .collect()
}

fn summary_metadata(agent: &'static str, summary: &UsageSummary) -> Option<Value> {
    let mut metadata = serde_json::Map::new();
    if let Some(credits) = summary.credits {
        metadata.insert("credits".to_string(), json_float(credits));
    }
    if summary.session_id.is_some() {
        if let Some(last_activity) = summary.last_activity.as_ref() {
            metadata.insert("lastActivity".to_string(), json!(last_activity));
        }
        if agent == "pi" {
            if let Some(project_path) = summary.project_path.as_ref() {
                metadata.insert("projectPath".to_string(), json!(project_path));
            }
        }
    }
    if metadata.is_empty() {
        None
    } else {
        Some(Value::Object(metadata))
    }
}

fn codex_group_row(
    period: &str,
    group: &CodexGroup,
    pricing: &PricingMap,
    speed: CodexSpeed,
) -> AllRow {
    let mut model_breakdowns: Vec<ModelBreakdown> = group
        .models
        .iter()
        .map(|(model, usage)| {
            let input =
                codex::non_cached_input_tokens(usage.input_tokens, usage.cached_input_tokens);
            ModelBreakdown {
                model_name: model.clone(),
                input_tokens: input,
                output_tokens: usage.output_tokens,
                cache_creation_tokens: 0,
                cache_read_tokens: usage.cached_input_tokens,
                extra_total_tokens: 0,
                cost: codex::calculate_codex_model_cost(model, usage, pricing, speed),
            }
        })
        .collect();
    model_breakdowns.sort_by(|a, b| b.cost.total_cmp(&a.cost));
    AllRow {
        period: period.to_string(),
        agent: "codex",
        models_used: group.models.keys().cloned().collect(),
        input_tokens: codex::non_cached_input_tokens(group.input_tokens, group.cached_input_tokens),
        output_tokens: group.output_tokens,
        cache_creation_tokens: 0,
        cache_read_tokens: group.cached_input_tokens,
        total_tokens: group.total_tokens,
        total_cost: codex::calculate_group_cost(group, pricing, speed),
        metadata: Some(json!({
            "lastActivity": group.last_activity,
            "reasoningOutputTokens": group.reasoning_output_tokens,
        })),
        metadata_agents: Some(vec!["codex"]),
        agent_breakdowns: None,
        model_breakdowns,
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
        let mut model_breakdowns = aggregate_model_breakdowns(&agent_breakdowns);
        model_breakdowns.sort_by(|a, b| b.cost.total_cmp(&a.cost));
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
            metadata: None,
            metadata_agents: Some(self.agents.into_iter().collect()),
            agent_breakdowns: Some(agent_breakdowns),
            model_breakdowns,
        }
    }
}

fn aggregate_model_breakdowns(rows: &[AllRow]) -> Vec<ModelBreakdown> {
    use std::collections::HashMap;
    let mut indexes: HashMap<String, usize> = HashMap::new();
    let mut breakdowns: Vec<ModelBreakdown> = Vec::new();
    for row in rows {
        for item in &row.model_breakdowns {
            let index = *indexes.entry(item.model_name.clone()).or_insert_with(|| {
                let i = breakdowns.len();
                breakdowns.push(ModelBreakdown {
                    model_name: item.model_name.clone(),
                    ..ModelBreakdown::default()
                });
                i
            });
            let b = &mut breakdowns[index];
            b.input_tokens += item.input_tokens;
            b.output_tokens += item.output_tokens;
            b.cache_creation_tokens += item.cache_creation_tokens;
            b.cache_read_tokens += item.cache_read_tokens;
            b.extra_total_tokens += item.extra_total_tokens;
            b.cost += item.cost;
        }
    }
    breakdowns
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
        "modelBreakdowns": row.model_breakdowns,
    });
    if let (Some(obj), Some(agents)) = (value.as_object_mut(), row.metadata_agents.as_ref()) {
        obj.insert(
            "metadata".to_string(),
            row.metadata
                .clone()
                .unwrap_or_else(|| json!({ "agents": agents })),
        );
    } else if let (Some(obj), Some(metadata)) = (value.as_object_mut(), row.metadata.as_ref()) {
        obj.insert("metadata".to_string(), metadata.clone());
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
        AgentReportKind::Session => "session",
    }
}

fn print_table(
    rows: &[AllRow],
    kind: AgentReportKind,
    shared: &SharedArgs,
    detected_agents: &[&'static str],
) {
    print_box_title(&all_report_title(kind, rows, detected_agents), shared);
    if rows.is_empty() {
        eprintln!("No usage data found.");
        return;
    }
    let terminal_width = crate::terminal_width();
    let compact = shared.compact || terminal_width < crate::USAGE_COMPACT_WIDTH_THRESHOLD;
    let (headers, aligns) = all_table_columns(kind, compact);
    let mut table = SimpleTable::new(headers, aligns, shared)
        .with_terminal_width(terminal_width)
        .with_date_compaction(true);

    for row in rows {
        table.push(all_table_row(row, compact, false));
        if let Some(agent_breakdowns) = row.agent_breakdowns.as_ref() {
            for breakdown in agent_breakdowns {
                table.push(all_table_row(breakdown, compact, true));
                if shared.breakdown && !breakdown.model_breakdowns.is_empty() {
                    push_model_breakdown_rows(
                        &mut table,
                        &breakdown.model_breakdowns,
                        compact,
                        shared,
                    );
                }
            }
        } else if shared.breakdown && !row.model_breakdowns.is_empty() {
            push_model_breakdown_rows(&mut table, &row.model_breakdowns, compact, shared);
        }
    }
    table.separator();
    let totals = totals_json(rows);
    let table_total_tokens = rows.iter().map(table_total_tokens).sum::<u64>();
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
            color(shared, format_number(table_total_tokens), Color::Yellow),
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

fn all_report_title(
    kind: AgentReportKind,
    rows: &[AllRow],
    detected_agents: &[&'static str],
) -> String {
    format!(
        "Coding (Agent) CLI Usage Report - {}\nDetected: {}",
        match kind {
            AgentReportKind::Daily => "Daily",
            AgentReportKind::Weekly => "Weekly",
            AgentReportKind::Monthly => "Monthly",
            AgentReportKind::Session => "Session",
        },
        detected_agent_labels(rows, detected_agents)
    )
}

fn detected_agent_labels(rows: &[AllRow], detected_agents: &[&'static str]) -> String {
    let mut agents = BTreeSet::new();
    if detected_agents.is_empty() {
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
    } else {
        agents.extend(detected_agents.iter().copied());
    }
    if agents.is_empty() {
        return "None".to_string();
    }
    agents
        .into_iter()
        .map(agent_label)
        .collect::<Vec<_>>()
        .join(", ")
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
        format_number(table_total_tokens(row)),
        format_currency(row.total_cost),
    ]
}

fn table_total_tokens(row: &AllRow) -> u64 {
    row.input_tokens
        .saturating_add(row.output_tokens)
        .saturating_add(row.cache_creation_tokens)
        .saturating_add(row.cache_read_tokens)
}

fn push_model_breakdown_rows(
    table: &mut SimpleTable,
    breakdowns: &[ModelBreakdown],
    compact: bool,
    shared: &SharedArgs,
) {
    for b in breakdowns {
        let total =
            b.input_tokens + b.output_tokens + b.cache_creation_tokens + b.cache_read_tokens;
        let model = color(
            shared,
            format!("- {}", short_model_name(&b.model_name)),
            Color::Grey,
        );
        if compact {
            table.push(vec![
                String::new(),
                String::new(),
                model,
                color(shared, format_number(b.input_tokens), Color::Grey),
                color(shared, format_number(b.output_tokens), Color::Grey),
                color(shared, format_currency(b.cost), Color::Grey),
            ]);
        } else {
            table.push(vec![
                String::new(),
                String::new(),
                model,
                color(shared, format_number(b.input_tokens), Color::Grey),
                color(shared, format_number(b.output_tokens), Color::Grey),
                color(shared, format_number(b.cache_creation_tokens), Color::Grey),
                color(shared, format_number(b.cache_read_tokens), Color::Grey),
                color(shared, format_number(total), Color::Grey),
                color(shared, format_currency(b.cost), Color::Grey),
            ]);
        }
    }
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
        "droid" => "Droid",
        "codebuff" => "Codebuff",
        "hermes" => "Hermes",
        "pi" => "pi-agent",
        "goose" => "Goose",
        "openclaw" => "OpenClaw",
        "kilo" => "Kilo",
        "copilot" => "GitHub Copilot CLI",
        "gemini" => "Gemini CLI",
        "kimi" => "Kimi",
        "qwen" => "Qwen",
        _ => agent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexModelUsage;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    fn test_agent_rows(agent: &'static str) -> AgentRows {
        AgentRows {
            rows: vec![AllRow {
                period: "2026-01-02".to_string(),
                agent,
                models_used: Vec::new(),
                input_tokens: 1,
                output_tokens: 0,
                cache_creation_tokens: 0,
                cache_read_tokens: 0,
                total_tokens: 1,
                total_cost: 0.0,
                metadata: None,
                metadata_agents: Some(vec![agent]),
                agent_breakdowns: None,
                model_breakdowns: Vec::new(),
            }],
            detected: true,
        }
    }

    #[test]
    fn loads_agent_rows_concurrently() {
        let active_loaders = Arc::new(AtomicUsize::new(0));
        let specs = [
            ("claude", crate::progress::UsageLoadAgent::Claude),
            ("codex", crate::progress::UsageLoadAgent::Codex),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (agent, progress_agent))| {
            let active_loaders = Arc::clone(&active_loaders);
            AgentLoadSpec {
                index,
                agent,
                progress_agent,
                load: Box::new(move || {
                    active_loaders.fetch_add(1, Ordering::AcqRel);
                    let started = Instant::now();
                    while active_loaders.load(Ordering::Acquire) < 2 {
                        if started.elapsed() > Duration::from_secs(1) {
                            return Err(crate::cli_error("agent loaders did not overlap"));
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Ok(test_agent_rows(agent))
                }),
            }
        })
        .collect();
        let mut progress = crate::progress::UsageLoadProgress::new(false);

        let loaded = load_agent_rows_parallel(specs, &mut progress).unwrap();

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].agent, "claude");
        assert_eq!(loaded[1].agent, "codex");
    }

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
                    metadata: None,
                    metadata_agents: Some(vec!["codex"]),
                    agent_breakdowns: None,
                    model_breakdowns: Vec::new(),
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
                    metadata: None,
                    metadata_agents: Some(vec!["claude"]),
                    agent_breakdowns: None,
                    model_breakdowns: Vec::new(),
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
            metadata: None,
            metadata_agents: Some(vec!["codex"]),
            agent_breakdowns: None,
            model_breakdowns: Vec::new(),
        }];

        let report = report_json(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["period"], "2026-01-02");
        assert_eq!(report["daily"][0]["agent"], "all");
        assert_eq!(report["daily"][0]["metadata"]["agents"], json!(["codex"]));
        assert_eq!(report["totals"]["totalTokens"], 130);
    }

    #[test]
    fn uses_non_cached_codex_input_tokens_in_all_rows() {
        let mut group = CodexGroup {
            input_tokens: 100,
            cached_input_tokens: 90,
            output_tokens: 5,
            total_tokens: 105,
            ..CodexGroup::default()
        };
        group.models.insert(
            "gpt-5".to_string(),
            CodexModelUsage {
                input_tokens: 100,
                cached_input_tokens: 90,
                output_tokens: 5,
                total_tokens: 105,
                ..CodexModelUsage::default()
            },
        );
        let row = codex_group_row(
            "2026-01-02",
            &group,
            &PricingMap::default(),
            CodexSpeed::Standard,
        );

        assert_eq!(row.input_tokens, 10);
        assert_eq!(row.cache_read_tokens, 90);
        assert_eq!(row.total_tokens, 105);
    }

    #[test]
    fn includes_codex_model_breakdowns_in_all_rows() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-5": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010,
                    "cache_read_input_token_cost": 0.0000001
                },
                "gpt-5-mini": {
                    "input_cost_per_token": 0.0000001,
                    "output_cost_per_token": 0.000001,
                    "cache_read_input_token_cost": 0.00000001
                }
            }"#,
        );
        let mut group = CodexGroup {
            input_tokens: 300,
            cached_input_tokens: 100,
            output_tokens: 50,
            total_tokens: 350,
            ..CodexGroup::default()
        };
        group.models.insert(
            "gpt-5-mini".to_string(),
            CodexModelUsage {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
                total_tokens: 110,
                ..CodexModelUsage::default()
            },
        );
        group.models.insert(
            "gpt-5".to_string(),
            CodexModelUsage {
                input_tokens: 200,
                cached_input_tokens: 80,
                output_tokens: 40,
                total_tokens: 240,
                ..CodexModelUsage::default()
            },
        );

        let row = codex_group_row("2026-01-02", &group, &pricing, CodexSpeed::Standard);

        assert_eq!(row.model_breakdowns.len(), 2);
        assert_eq!(row.model_breakdowns[0].model_name, "gpt-5");
        assert_eq!(row.model_breakdowns[0].input_tokens, 120);
        assert_eq!(row.model_breakdowns[0].cache_read_tokens, 80);
        assert_eq!(row.model_breakdowns[0].output_tokens, 40);
        assert_eq!(row.model_breakdowns[1].model_name, "gpt-5-mini");
    }

    #[test]
    fn aggregates_model_breakdowns_across_agents() {
        let rows = aggregate_rows(
            vec![
                AllRow {
                    period: "2026-01-02".to_string(),
                    agent: "codex",
                    models_used: vec!["gpt-5".to_string()],
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_creation_tokens: 0,
                    cache_read_tokens: 2,
                    total_tokens: 17,
                    total_cost: 0.03,
                    metadata: None,
                    metadata_agents: Some(vec!["codex"]),
                    agent_breakdowns: None,
                    model_breakdowns: vec![ModelBreakdown {
                        model_name: "gpt-5".to_string(),
                        input_tokens: 10,
                        output_tokens: 5,
                        cache_creation_tokens: 0,
                        cache_read_tokens: 2,
                        cost: 0.03,
                        ..ModelBreakdown::default()
                    }],
                },
                AllRow {
                    period: "2026-01-02".to_string(),
                    agent: "claude",
                    models_used: vec!["gpt-5".to_string(), "claude-sonnet-4-20250514".to_string()],
                    input_tokens: 30,
                    output_tokens: 20,
                    cache_creation_tokens: 3,
                    cache_read_tokens: 4,
                    total_tokens: 57,
                    total_cost: 0.07,
                    metadata: None,
                    metadata_agents: Some(vec!["claude"]),
                    agent_breakdowns: None,
                    model_breakdowns: vec![
                        ModelBreakdown {
                            model_name: "gpt-5".to_string(),
                            input_tokens: 8,
                            output_tokens: 3,
                            cache_creation_tokens: 1,
                            cache_read_tokens: 2,
                            cost: 0.01,
                            ..ModelBreakdown::default()
                        },
                        ModelBreakdown {
                            model_name: "claude-sonnet-4-20250514".to_string(),
                            input_tokens: 22,
                            output_tokens: 17,
                            cache_creation_tokens: 2,
                            cache_read_tokens: 2,
                            cost: 0.06,
                            ..ModelBreakdown::default()
                        },
                    ],
                },
            ],
            AgentReportKind::Daily,
        );

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model_breakdowns.len(), 2);
        assert_eq!(
            rows[0].model_breakdowns[0].model_name,
            "claude-sonnet-4-20250514"
        );
        assert_eq!(rows[0].model_breakdowns[0].cost, 0.06);
        assert_eq!(rows[0].model_breakdowns[1].model_name, "gpt-5");
        assert_eq!(rows[0].model_breakdowns[1].input_tokens, 18);
        assert_eq!(rows[0].model_breakdowns[1].output_tokens, 8);
        assert_eq!(rows[0].model_breakdowns[1].cache_creation_tokens, 1);
        assert_eq!(rows[0].model_breakdowns[1].cache_read_tokens, 4);
        assert_eq!(rows[0].model_breakdowns[1].cost, 0.04);
    }

    #[test]
    fn displays_total_tokens_with_cache_tokens_like_typescript_table() {
        let row = AllRow {
            period: "2026-01-02".to_string(),
            agent: "codex",
            models_used: vec!["gpt-5".to_string()],
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_tokens: 0,
            cache_read_tokens: 10,
            total_tokens: 120,
            total_cost: 0.01,
            metadata: None,
            metadata_agents: Some(vec!["codex"]),
            agent_breakdowns: None,
            model_breakdowns: Vec::new(),
        };

        let cells = all_table_row(&row, false, false);

        assert_eq!(cells[7], "130");
    }

    #[test]
    fn report_title_uses_detected_agents_even_when_filtered_rows_are_sparse() {
        let rows = vec![AllRow {
            period: "2026-01-02".to_string(),
            agent: "all",
            models_used: vec!["gpt-5".to_string()],
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_tokens: 0,
            cache_read_tokens: 10,
            total_tokens: 120,
            total_cost: 0.01,
            metadata: None,
            metadata_agents: Some(vec!["codex"]),
            agent_breakdowns: None,
            model_breakdowns: Vec::new(),
        }];

        let title = all_report_title(
            AgentReportKind::Daily,
            &rows,
            &["amp", "claude", "codex", "opencode", "pi"],
        );

        assert_eq!(
            title,
            "Coding (Agent) CLI Usage Report - Daily\nDetected: Amp, Claude, Codex, OpenCode, pi-agent"
        );
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
            metadata: None,
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
                metadata: None,
                metadata_agents: Some(vec!["codex"]),
                agent_breakdowns: None,
                model_breakdowns: Vec::new(),
            }]),
            model_breakdowns: Vec::new(),
        };

        assert_eq!(
            all_table_row(&row, true, false),
            vec!["2026-01-02", "All", "", "100", "20", "$0.01"]
        );
        assert_eq!(
            all_table_row(
                row.agent_breakdowns.as_ref().unwrap().first().unwrap(),
                true,
                true
            ),
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
            metadata: None,
            metadata_agents: Some(vec!["claude", "codex"]),
            agent_breakdowns: None,
            model_breakdowns: Vec::new(),
        };

        assert_eq!(
            all_report_title(AgentReportKind::Daily, &[row], &[]),
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
