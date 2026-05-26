use serde_json::{json, Value};

use crate::{
    cli::{AgentReportKind, SortOrder, WeekDay},
    sort_summaries, summarize_by_key, summarize_summaries_by_bucket, totals_json, BucketKind,
    LoadedEntry, Result,
};

pub(crate) fn report_json(
    entries: &[LoadedEntry],
    kind: AgentReportKind,
    order: &SortOrder,
) -> Result<Value> {
    let mut rows = summarize_entries(entries, kind)?;
    sort_summaries(&mut rows, order, |row| summary_period(row));
    Ok(report_from_rows(&rows, kind))
}

fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| agent_summary_json(row, kind, false))
        .collect::<Vec<_>>();
    json!({
        rows_key(kind): rows_json,
        "totals": totals_json(rows),
    })
}

pub(crate) fn agent_summary_json(
    row: &crate::UsageSummary,
    kind: AgentReportKind,
    include_session_metadata: bool,
) -> Value {
    let mut value = json!({
        period_key(kind): summary_period(row),
        "inputTokens": row.input_tokens,
        "outputTokens": row.output_tokens,
        "cacheCreationTokens": row.cache_creation_tokens,
        "cacheReadTokens": row.cache_read_tokens,
        "totalTokens": row.total_tokens(),
        "totalCost": row.total_cost,
        "modelsUsed": row.models_used,
    });
    if let (Some(obj), Some(credits)) = (value.as_object_mut(), row.credits) {
        obj.insert("credits".to_string(), json!(credits));
    }
    if let (Some(obj), Some(message_count)) = (value.as_object_mut(), row.message_count) {
        obj.insert("messageCount".to_string(), json!(message_count));
    }
    if include_session_metadata {
        if let Some(obj) = value.as_object_mut() {
            obj.insert(
                "firstActivity".to_string(),
                row.first_activity
                    .as_ref()
                    .map_or(Value::Null, |value| json!(value)),
            );
            obj.insert(
                "lastActivity".to_string(),
                row.last_activity
                    .as_ref()
                    .map_or(Value::Null, |value| json!(value)),
            );
            obj.insert(
                "projectPath".to_string(),
                row.project_path
                    .as_ref()
                    .map_or(Value::Null, |value| json!(value)),
            );
        }
    }
    value
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
        AgentReportKind::Weekly => {
            let daily = summarize_by_key(
                entries,
                |entry| entry.date.clone(),
                |date| (date.to_string(), None),
            )?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                BucketKind::Weekly,
                WeekDay::Monday,
            ))
        }
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

fn period_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "date",
        AgentReportKind::Weekly => "week",
        AgentReportKind::Monthly => "month",
        AgentReportKind::Session => "sessionId",
    }
}

pub(crate) fn first_column(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "Date",
        AgentReportKind::Weekly => "Week",
        AgentReportKind::Monthly => "Month",
        AgentReportKind::Session => "Session",
    }
}

pub(crate) fn summary_period(row: &crate::UsageSummary) -> &str {
    row.date
        .as_deref()
        .or(row.week.as_deref())
        .or(row.month.as_deref())
        .or(row.session_id.as_deref())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cli::AgentReportKind, ModelBreakdown, UsageSummary};

    #[test]
    fn snapshots_agent_summary_json_period_keys_and_session_metadata() {
        let daily = snapshot_row();
        let mut weekly = snapshot_row();
        weekly.date = None;
        weekly.month = None;
        let mut monthly = snapshot_row();
        monthly.date = None;
        monthly.week = None;
        let mut session = snapshot_row();
        session.date = None;
        session.week = None;
        session.month = None;

        insta::assert_json_snapshot!(serde_json::json!({
            "daily": agent_summary_json(&daily, AgentReportKind::Daily, false),
            "weekly": agent_summary_json(&weekly, AgentReportKind::Weekly, false),
            "monthly": agent_summary_json(&monthly, AgentReportKind::Monthly, false),
            "session": agent_summary_json(&session, AgentReportKind::Session, true),
            "dailyReport": report_from_rows(std::slice::from_ref(&daily), AgentReportKind::Daily),
            "sessionReport": report_from_rows(&[session], AgentReportKind::Session),
        }));
    }

    fn snapshot_row() -> UsageSummary {
        UsageSummary {
            date: Some("2026-01-02".to_string()),
            month: Some("2026-01".to_string()),
            week: Some("2025-12-29".to_string()),
            session_id: Some("session-a".to_string()),
            project_path: Some("/workspace/api".to_string()),
            first_activity: None,
            last_activity: Some("2026-01-02".to_string()),
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_tokens: 10,
            cache_read_tokens: 5,
            extra_total_tokens: 7,
            total_cost: 0.25,
            credits: Some(1.5),
            message_count: Some(3),
            models_used: vec![
                "gpt-5.2-codex".to_string(),
                "claude-sonnet-4-20250514".to_string(),
            ],
            model_breakdowns: vec![ModelBreakdown {
                model_name: "gpt-5.2-codex".to_string(),
                input_tokens: 100,
                output_tokens: 50,
                cache_creation_tokens: 10,
                cache_read_tokens: 5,
                extra_total_tokens: 7,
                cost: 0.25,
            }],
            project: None,
            versions: Some(vec!["1.0.0".to_string()]),
        }
    }
}
