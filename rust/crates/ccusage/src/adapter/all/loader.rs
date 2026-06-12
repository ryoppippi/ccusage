use std::{collections::BTreeMap, sync::mpsc, thread};

use serde_json::{json, Value};

use crate::{
    adapter::{
        amp, claude, codebuff, codex, copilot, droid, gemini, goose, hermes, kilo, kimi, openclaw,
        opencode, pi, qwen,
    },
    cli::{AgentReportKind, CodexSpeed, SharedArgs, WeekDay},
    filter_loaded_entries_by_date, CodexGroup, LoadedEntry, ModelBreakdown, PricingMap, Result,
    SessionAccumulator, UsageSummary,
};

use super::{
    report::sort_rows,
    types::{AgentLoadSpec, AgentRows, AllAccumulator, AllLoadResult, AllRow, LoadedAgentRows},
};

pub(super) fn load_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AllLoadResult> {
    let mut progress = crate::progress::UsageLoadProgress::new(
        crate::log_level() != Some(0)
            && crate::progress::should_show_usage_load_progress(
                shared.json,
                crate::progress::usage_load_output_is_tty(),
            ),
    );
    let pricing = PricingMap::load_with_overrides(
        shared.offline,
        crate::log_level() != Some(0),
        shared.pricing_overrides.iter(),
    );
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
                load: Box::new(|| {
                    load_summary_agent_rows(
                        "opencode",
                        load_kind,
                        &loader_shared,
                        || opencode::loader::load_entries(&loader_shared),
                        opencode::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 3,
                agent: "amp",
                progress_agent: crate::progress::UsageLoadAgent::Amp,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "amp",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        amp::load_entries,
                        amp::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 4,
                agent: "droid",
                progress_agent: crate::progress::UsageLoadAgent::Droid,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "droid",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        droid::load_entries,
                        droid::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 5,
                agent: "codebuff",
                progress_agent: crate::progress::UsageLoadAgent::Codebuff,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "codebuff",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        codebuff::load_entries,
                        codebuff::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 6,
                agent: "hermes",
                progress_agent: crate::progress::UsageLoadAgent::Hermes,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "hermes",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        hermes::load_entries,
                        hermes::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 7,
                agent: "pi",
                progress_agent: crate::progress::UsageLoadAgent::Pi,
                load: Box::new(|| {
                    load_session_capable_summary_agent_rows(
                        "pi",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        pi::load_entries,
                        pi::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 8,
                agent: "goose",
                progress_agent: crate::progress::UsageLoadAgent::Goose,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "goose",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        goose::load_entries,
                        goose::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 9,
                agent: "openclaw",
                progress_agent: crate::progress::UsageLoadAgent::OpenClaw,
                load: Box::new(|| {
                    load_summary_agent_rows(
                        "openclaw",
                        load_kind,
                        &loader_shared,
                        || openclaw::load_entries(&loader_shared, None, Some(&pricing)),
                        openclaw::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 10,
                agent: "kilo",
                progress_agent: crate::progress::UsageLoadAgent::Kilo,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "kilo",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        kilo::load_entries,
                        kilo::summarize_entries,
                    )
                }),
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
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "gemini",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        gemini::load_entries,
                        gemini::summarize_entries,
                    )
                }),
            },
            AgentLoadSpec {
                index: 13,
                agent: "kimi",
                progress_agent: crate::progress::UsageLoadAgent::Kimi,
                load: Box::new(|| {
                    load_priced_summary_agent_rows(
                        "kimi",
                        load_kind,
                        &loader_shared,
                        &pricing,
                        kimi::load_entries,
                        kimi::summarize_entries,
                    )
                }),
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
        finalize_session_mode_rows(&mut rows);
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

/// Post-process session-mode rows before rendering: clear `metadata_agents`
/// so the renderer's `build_row_metadata` does not inject an `"agents"` key
/// into per-session `--all --json` output. Without this clear, session-mode
/// rows (which carry per-row metadata like `lastActivity`/`projectPath`)
/// would gain a new `"agents"` JSON key after the `build_row_metadata`
/// merge refactor — a user-observable JSON-shape change for every
/// non-Copilot adapter's session report. Pinned by
/// `finalize_session_mode_rows_clears_metadata_agents`.
pub(super) fn finalize_session_mode_rows(rows: &mut [AllRow]) {
    for row in rows {
        row.metadata_agents = None;
    }
}

pub(super) fn load_agent_rows_parallel(
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

fn load_session_capable_summary_agent_rows(
    agent: &'static str,
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
    load_entries: impl FnOnce(
        &SharedArgs,
        Option<&str>,
        Option<&PricingMap>,
    ) -> Result<Vec<LoadedEntry>>,
    summarize_entries: impl FnOnce(&[LoadedEntry], AgentReportKind) -> Result<Vec<UsageSummary>>,
) -> Result<AgentRows> {
    let mut entries = load_entries(shared, None, Some(pricing))?;
    let detected = !entries.is_empty();
    let summaries = if kind == AgentReportKind::Session {
        let mut summaries = summarize_entry_sessions(&entries)?;
        filter_session_summaries(&mut summaries, shared);
        summaries
    } else {
        filter_loaded_entries_by_date(&mut entries, shared);
        summarize_entries(&entries, kind)?
    };
    Ok(AgentRows {
        rows: summary_rows(agent, summaries),
        detected,
    })
}

fn load_claude_rows(kind: AgentReportKind, shared: &SharedArgs) -> Result<AgentRows> {
    if kind == AgentReportKind::Session {
        let entries = claude::load_entries(shared, None)?;
        let detected = !entries.is_empty();
        let mut summaries = summarize_entry_sessions(&entries)?;
        filter_session_summaries(&mut summaries, shared);
        return Ok(AgentRows {
            rows: summary_rows("claude", summaries),
            detected,
        });
    }

    let mut summaries = claude::load_daily_summaries(shared, None, false)?;
    let detected = !summaries.is_empty();
    filter_daily_summaries_by_date(&mut summaries, shared);
    Ok(AgentRows {
        rows: summary_rows("claude", summaries),
        detected,
    })
}

fn filter_daily_summaries_by_date(rows: &mut Vec<UsageSummary>, shared: &SharedArgs) {
    if shared.since.is_none() && shared.until.is_none() {
        return;
    }
    rows.retain(|row| {
        let date = row.date.as_deref().unwrap_or_default().replace('-', "");
        shared.since.as_ref().is_none_or(|since| &date >= since)
            && shared.until.as_ref().is_none_or(|until| &date <= until)
    });
}

fn load_codex_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    if shared.since.is_none() && shared.until.is_none() {
        let groups = codex::load_groups(shared, kind)?;
        let detected = !groups.is_empty();
        let speed = codex::resolve_codex_speed(CodexSpeed::Auto);
        return Ok(AgentRows {
            rows: groups
                .iter()
                .map(|(period, group)| codex_group_row(period, group, pricing, speed))
                .collect(),
            detected,
        });
    }

    let mut events = codex::load_codex_events(shared)?;
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

fn load_priced_summary_agent_rows(
    agent: &'static str,
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
    load_entries: impl FnOnce(&SharedArgs, &PricingMap) -> Result<Vec<LoadedEntry>>,
    summarize_entries: impl FnOnce(&[LoadedEntry], AgentReportKind) -> Result<Vec<UsageSummary>>,
) -> Result<AgentRows> {
    load_summary_agent_rows(
        agent,
        kind,
        shared,
        || load_entries(shared, pricing),
        summarize_entries,
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

/// Copilot's `load_entries_inner` pre-filters the `Vec<CopilotUsageEntry>`
/// by `--since`/`--until` BEFORE the content-keyed dedup HashMap collapse
/// (required to keep in-range credit-only rows from being silently dropped
/// when they share `(session, model, naiu)` with an out-of-range row — see
/// `adapter/copilot/loader.rs::load_entries_inner` and the README section
/// "Date filter must run before dedup"). A side-effect is that
/// `!entries.is_empty()` after `load_entries` returns no longer reflects
/// on-disk presence — it reflects post-filter presence. We restore the
/// on-disk signal by OR-ing the lightweight `copilot::has_data()` sentinel
/// into `detected`, mirroring the established `qwen::has_data()` pattern.
/// This preserves the invariant that "copilot" appears in the `Detected:`
/// report header whenever any session-state file exists on disk, even when
/// the active date filter narrows the row set to empty.
fn load_copilot_rows(
    kind: AgentReportKind,
    shared: &SharedArgs,
    pricing: &PricingMap,
) -> Result<AgentRows> {
    let mut entries = copilot::load_entries(shared, pricing)?;
    let detected = !entries.is_empty() || copilot::has_data();
    filter_loaded_entries_by_date(&mut entries, shared);
    let summaries = copilot::summarize_entries(&entries, kind)?;
    Ok(AgentRows {
        rows: summary_rows("copilot", summaries),
        detected,
    })
}

fn summarize_entry_sessions(entries: &[LoadedEntry]) -> Result<Vec<UsageSummary>> {
    let mut groups = BTreeMap::<(String, String), SessionAccumulator>::new();
    for entry in entries {
        groups
            .entry((entry.project_path.to_string(), entry.session_id.to_string()))
            .or_default()
            .add_entry(entry);
    }
    groups
        .into_values()
        .map(|group| group.into_summary())
        .collect()
}

fn filter_session_summaries(rows: &mut Vec<UsageSummary>, shared: &SharedArgs) {
    if shared.since.is_some() || shared.until.is_some() {
        rows.retain(|row| {
            let date = row
                .last_activity
                .as_deref()
                .unwrap_or_default()
                .replace('-', "");
            shared.since.as_ref().is_none_or(|since| &date >= since)
                && shared.until.as_ref().is_none_or(|until| &date <= until)
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
            // Drop only fully-empty summaries (zero tokens AND zero cost
            // AND zero/absent credits). The previous filter rejected any
            // summary with `total_tokens == 0`, silently omitting
            // post-cutover Copilot AI-Credit-only sessions. This relaxed
            // predicate preserves the phantom-row guard while exposing
            // genuine non-token billing — correct for any adapter that
            // bills outside the token channel, not just Copilot.
            // `total_cost == 0.0`: costs are non-negative; exact-zero
            // only via all-zero terms (do not weaken to an epsilon).
            if total_tokens == 0
                && summary.total_cost == 0.0
                && summary.credits.unwrap_or(0.0) == 0.0
            {
                return None;
            }
            let credits = summary.credits;
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
                credits,
                metadata,
                metadata_agents: Some(vec![agent]),
                agent_breakdowns: None,
                model_breakdowns: summary.model_breakdowns,
            })
        })
        .collect()
}

/// Builds the per-row `metadata` JSON object for session-mode rows.
///
/// Note: `credits` is intentionally NOT included here — it's a first-class
/// field on `AllRow` (and `AllAccumulator` aggregates it). The renderer
/// (`report::row_json`) injects `credits` into the emitted `metadata`
/// object at serialization time, so aggregated `--all` rows surface
/// summed credits even though their `metadata` field is `None`. Keeping
/// `credits` out of the loader-side metadata map prevents a stale
/// per-source value from out-living the aggregator (which is what
/// originally dropped credits from `daily --all --json`).
fn summary_metadata(agent: &'static str, summary: &UsageSummary) -> Option<Value> {
    let mut metadata = serde_json::Map::new();
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

pub(super) fn codex_group_row(
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
                missing_pricing: codex::codex_model_missing_pricing(model, usage, pricing),
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
        credits: None,
        metadata: Some(json!({
            "lastActivity": group.last_activity,
            "reasoningOutputTokens": group.reasoning_output_tokens,
        })),
        metadata_agents: Some(vec!["codex"]),
        agent_breakdowns: None,
        model_breakdowns,
    }
}

pub(super) fn aggregate_rows(rows: Vec<AllRow>, kind: AgentReportKind) -> Vec<AllRow> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_summary(date: &str, input_tokens: u64) -> UsageSummary {
        UsageSummary {
            date: Some(date.to_string()),
            month: None,
            week: None,
            session_id: None,
            project_path: None,
            last_activity: None,
            first_activity: None,
            input_tokens,
            output_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            extra_total_tokens: 0,
            total_cost: 0.0,
            credits: None,
            message_count: None,
            models_used: Vec::new(),
            model_breakdowns: Vec::new(),
            project: None,
            versions: None,
        }
    }

    #[test]
    fn filters_daily_summaries_with_compact_date_bounds() {
        let mut rows = vec![
            usage_summary("2026-01-01", 10),
            usage_summary("2026-01-02", 20),
            usage_summary("2026-01-03", 30),
        ];
        let shared = SharedArgs {
            since: Some("20260102".to_string()),
            until: Some("20260102".to_string()),
            ..SharedArgs::default()
        };

        filter_daily_summaries_by_date(&mut rows, &shared);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date.as_deref(), Some("2026-01-02"));
        assert_eq!(rows[0].input_tokens, 20);
    }

    #[test]
    fn summary_rows_keeps_zero_token_summaries_when_cost_or_credits_present() {
        // Regression: pre-fix `summary_rows` dropped any summary whose
        // `total_tokens == 0`, silently omitting Copilot credit-only
        // periods/sessions (zero tokens but positive `totalNanoAiu` →
        // positive cost AND credits) from `ccusage daily --all` /
        // `weekly --all` / `monthly --all` / `session --all` reports. The
        // direct `ccusage copilot ...` reports surfaced them. The
        // asymmetry was the bug. The relaxed predicate drops only
        // fully-empty summaries (zero tokens AND zero cost AND
        // zero/absent credits), restoring `--all` parity with the agent's
        // own reports for any non-token billing channel.

        let credit_only_with_cost = UsageSummary {
            total_cost: 1.54481,
            credits: Some(154.481),
            ..usage_summary("2026-05-15", 0)
        };
        let credit_only_credits_no_cost = UsageSummary {
            total_cost: 0.0,
            credits: Some(2.5),
            ..usage_summary("2026-05-16", 0)
        };
        let cost_only_no_credits = UsageSummary {
            total_cost: 0.04,
            credits: None,
            ..usage_summary("2026-05-17", 0)
        };
        let fully_empty = usage_summary("2026-05-18", 0);
        let token_only = usage_summary("2026-05-19", 100);

        let kept = summary_rows(
            "copilot",
            vec![
                credit_only_with_cost,
                credit_only_credits_no_cost,
                cost_only_no_credits,
                fully_empty,
                token_only,
            ],
        );

        let periods: Vec<&str> = kept.iter().map(|r| r.period.as_str()).collect();
        assert_eq!(
            periods,
            vec![
                "2026-05-15", // credit-only with cost + credits — kept
                "2026-05-16", // credit-only with credits, $0 cost — kept (Display mode)
                "2026-05-17", // cost > 0 with no credits — kept (codebuff-shape forward-compat)
                "2026-05-19", // token-bearing — kept (pre-existing behavior preserved)
            ],
            "fully-empty summary (2026-05-18) must still be dropped; \
             any summary with non-zero tokens, cost, or credits must survive",
        );
    }

    #[test]
    fn summary_rows_treats_zero_credits_same_as_absent_credits() {
        // Belt-and-suspenders: `Some(0.0)` credits + zero tokens + zero
        // cost still drops the summary. Without this, a future bug that
        // populates `credits = Some(0.0)` (instead of `None`) on a
        // phantom row would re-surface the all-zero summary in `--all`.

        let zero_credits = UsageSummary {
            total_cost: 0.0,
            credits: Some(0.0),
            ..usage_summary("2026-05-20", 0)
        };

        let kept = summary_rows("copilot", vec![zero_credits]);

        assert!(
            kept.is_empty(),
            "zero-tokens + zero-cost + Some(0.0) credits must be treated \
             as fully empty and dropped",
        );
    }

    #[test]
    fn summary_rows_relaxed_filter_applies_uniformly_across_non_copilot_agents() {
        // Cross-agent behavior change pinned: the relaxation of
        // `summary_rows` (from `total_tokens == 0 → drop` to
        // `total_tokens == 0 && total_cost == 0.0 && credits.unwrap_or(0.0) == 0.0
        //  → drop`) is INTENTIONALLY agent-agnostic. Pre-fix, any
        // non-Copilot adapter producing a zero-token + positive-cost
        // summary had its row silently dropped from `ccusage daily --all`
        // / `--all --json` totals.
        //
        // Which adapters could realistically emit this shape:
        // - **Claude** preserves cost via per-entry `costUSD` (the
        //   `cost_usd: Option<f64>` field on `DailyUsageEntry` in
        //   `claude::daily`, fed into `calculate_cost_for_usage`). The
        //   `is_valid_daily_usage_entry` skip predicate rejects only on
        //   version/session_id/request_id/message.id/message.model
        //   metadata fields — never on zero tokens — so a `usage: {}`
        //   line with a nonzero `costUSD` survives parsing.
        // - **Hermes** explicitly preserves zero-token rows when cost
        //   is positive (`hermes::parser` short-circuits only when ALL
        //   of tokens AND cost are zero), so its `actual_cost` /
        //   `estimated_cost` channel can produce zero-token +
        //   positive-cost rows directly.
        // - **Pi** / **OpenCode** parsers actually drop zero-token
        //   entries upstream (zero-token short-circuits in
        //   `pi::parser` and `opencode::parser`), so they could NOT
        //   produce this shape in production today — but the filter
        //   still treats them uniformly, which is the agent-agnostic
        //   invariant this test pins.
        //
        // Run the same shape (zero tokens + positive cost + no credits)
        // through three labels — claude and hermes (genuine producers
        // of the shape today) and `future-cost-only-agent` (a synthetic
        // label that emphasizes filter agent-agnosticism beyond any
        // currently-shipping adapter) — and assert all three survive.
        // Companion loop asserts the still-fully-empty row drops
        // uniformly across the same labels (phantom-row guard fires
        // cross-agent).

        let agents: &[&'static str] = &["claude", "hermes", "future-cost-only-agent"];
        for agent in agents {
            let cost_only = UsageSummary {
                total_cost: 0.0234,
                credits: None,
                ..usage_summary("2026-05-20", 0)
            };
            let kept = summary_rows(agent, vec![cost_only]);
            assert_eq!(
                kept.len(),
                1,
                "agent={agent}: zero-token + positive-cost row must \
                 survive `summary_rows` (relaxed filter applies \
                 cross-agent, not just to Copilot)",
            );
            assert_eq!(kept[0].agent, *agent);
            assert!((kept[0].total_cost - 0.0234).abs() < 1e-9);
            assert_eq!(kept[0].credits, None);
        }

        // Companion: still-fully-empty row drops regardless of agent.
        for agent in agents {
            let fully_empty = usage_summary("2026-05-21", 0);
            let kept = summary_rows(agent, vec![fully_empty]);
            assert!(
                kept.is_empty(),
                "agent={agent}: fully-empty row (zero tokens + zero cost \
                 + no credits) must still be dropped — the phantom-row \
                 guard fires uniformly cross-agent",
            );
        }
    }

    #[test]
    fn load_copilot_rows_keeps_copilot_in_detected_when_date_filter_excludes_all_data() {
        // Regression: `load_entries_inner` pre-filters
        // `Vec<CopilotUsageEntry>` by `--since`/`--until` BEFORE the
        // content-keyed dedup HashMap collapse (required so credit-only
        // rows that collide on `credit-shutdown:{session}:{model}:{naiu}`
        // don't lose the in-range row to last-wins ordering). Side-effect:
        // after `load_entries` returns, `!entries.is_empty()` no longer
        // reflects on-disk presence — it reflects post-filter presence.
        // Without a sentinel, `ccusage daily --all --since=<future>` would
        // silently drop "copilot" from the "Detected:" report header even
        // when `~/.copilot/session-state/*/events.jsonl` files exist on
        // disk. `load_copilot_rows` OR-s `copilot::has_data()` into
        // `detected` to restore the on-disk signal, mirroring the
        // established `qwen::has_data()` pattern.
        let _guard = ccusage_test_support::acquire_env_test_lock();
        let fixture = ccusage_test_support::Fixture::new();
        let session_uuid = "session-detected-when-filtered-out";
        let event = serde_json::json!({
            "type": "session.shutdown",
            "id": "evt-credit-only",
            "timestamp": "2026-05-15T10:00:00.000Z",
            "data": {"modelMetrics": {
                "claude-opus-4.7-1m-internal": {
                    "usage": {
                        "inputTokens": 0u64,
                        "outputTokens": 0u64,
                        "cacheReadTokens": 0u64,
                        "cacheWriteTokens": 0u64,
                        "reasoningTokens": 0u64
                    },
                    "requests": {"count": 0u64, "cost": 0},
                    "totalNanoAiu": 154_481_000_000u64
                }
            }}
        });
        let _ = fixture.write_file(
            format!("session-state/{session_uuid}/events.jsonl"),
            format!("{event}\n"),
        );
        let _env = ccusage_test_support::EnvScope::new(&[(
            copilot::COPILOT_CONFIG_DIR_ENV,
            Some(fixture.root().to_str().unwrap()),
        )]);

        // `--since` set far in the future excludes the 2026-05-15 row.
        let shared = SharedArgs {
            json: true,
            offline: true,
            mode: crate::cli::CostMode::Auto,
            since: Some("21000101".to_string()),
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let pricing = PricingMap::default();
        let agent_rows = load_copilot_rows(AgentReportKind::Daily, &shared, &pricing).unwrap();

        assert!(
            agent_rows.rows.is_empty(),
            "the date filter should have excluded all rows; got {} rows",
            agent_rows.rows.len(),
        );
        assert!(
            agent_rows.detected,
            "Copilot MUST remain in `detected` so the `Detected:` report \
             header still lists it even when the date filter narrows the \
             row set to empty. Pre-fix this was `false` because the \
             loader pre-filter made `!entries.is_empty()` no longer \
             reflect on-disk presence.",
        );
    }

    #[test]
    fn load_copilot_rows_reports_not_detected_when_no_session_state_files_exist() {
        // Companion to the above: if there's GENUINELY no Copilot data
        // on disk, `detected` must be `false` (otherwise "copilot" would
        // appear in `Detected:` for users who've never run the Copilot
        // CLI, which is misleading).
        let _guard = ccusage_test_support::acquire_env_test_lock();
        let fixture = ccusage_test_support::Fixture::new();
        // Fixture root exists, but no session-state directory.
        let _env = ccusage_test_support::EnvScope::new(&[(
            copilot::COPILOT_CONFIG_DIR_ENV,
            Some(fixture.root().to_str().unwrap()),
        )]);

        let shared = SharedArgs {
            json: true,
            offline: true,
            mode: crate::cli::CostMode::Auto,
            ..SharedArgs::default()
        };
        let pricing = PricingMap::default();
        let agent_rows = load_copilot_rows(AgentReportKind::Daily, &shared, &pricing).unwrap();

        assert!(agent_rows.rows.is_empty());
        assert!(
            !agent_rows.detected,
            "with no Copilot data on disk, `detected` must be false so \
             `Detected:` does not falsely list copilot",
        );
    }
}
