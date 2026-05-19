use std::{
    collections::BTreeMap,
    io::{BufWriter, Write},
};

use serde_json::{json, Value};

use crate::{
    cli::SharedArgs, cli_error, color, format_project_name, parse_project_aliases, print_box_title,
    short_model_name, terminal_width, Align, Color, Result, SimpleTable, UsageSummary,
    USAGE_COMPACT_WIDTH_THRESHOLD,
};

pub(crate) fn wants_json(shared: &SharedArgs) -> bool {
    shared.json || shared.jq.is_some()
}

pub(crate) fn summary_json(row: &UsageSummary) -> Value {
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
        if let Some(credits) = row.credits {
            obj.insert("credits".to_string(), json!(credits));
        }
    }
    value
}

pub(crate) fn session_summary_json(row: &UsageSummary) -> Value {
    let mut value = json!({
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
    });
    if let (Some(obj), Some(credits)) = (value.as_object_mut(), row.credits) {
        obj.insert("credits".to_string(), json!(credits));
    }
    value
}

pub(crate) fn totals_json(rows: &[UsageSummary]) -> Value {
    let input = rows.iter().map(|row| row.input_tokens).sum::<u64>();
    let output = rows.iter().map(|row| row.output_tokens).sum::<u64>();
    let cache_create = rows
        .iter()
        .map(|row| row.cache_creation_tokens)
        .sum::<u64>();
    let cache_read = rows.iter().map(|row| row.cache_read_tokens).sum::<u64>();
    let mut value = json!({
        "inputTokens": input,
        "outputTokens": output,
        "cacheCreationTokens": cache_create,
        "cacheReadTokens": cache_read,
        "totalTokens": input + output + cache_create + cache_read,
        "totalCost": rows.iter().map(|row| row.total_cost).sum::<f64>(),
    });
    let credits = rows.iter().filter_map(|row| row.credits).sum::<f64>();
    if credits > 0.0 {
        value["credits"] = json!(credits);
    }
    value
}

pub(crate) fn group_project_output(rows: &[UsageSummary]) -> Value {
    let mut projects: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for row in rows {
        projects
            .entry(row.project.clone().unwrap_or_else(|| "unknown".to_string()))
            .or_default()
            .push(summary_json(row));
    }
    json!(projects)
}

pub(crate) fn print_json_or_jq(value: Value, jq: Option<&str>) -> Result<()> {
    if let Some(filter) = jq {
        let mut child = std::process::Command::new("jq")
            .arg(filter)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::inherit())
            .spawn()
            .map_err(|error| cli_error(format!("failed to run jq: {error}")))?;
        if let Some(stdin) = child.stdin.take() {
            let mut stdin = BufWriter::new(stdin);
            serde_json::to_writer(&mut stdin, &value)?;
            stdin.write_all(b"\n")?;
            stdin.flush()?;
        }
        let status = child.wait()?;
        if !status.success() {
            return Err(cli_error("jq failed"));
        }
    } else {
        let stdout = std::io::stdout();
        let mut stdout = BufWriter::new(stdout.lock());
        serde_json::to_writer_pretty(&mut stdout, &value)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

pub(crate) fn print_usage_table(
    title: &str,
    first_column: &str,
    rows: &[UsageSummary],
    shared: &SharedArgs,
    group_projects: bool,
    project_aliases: Option<&str>,
) {
    if rows.is_empty() {
        eprintln!("{}", empty_usage_table_message());
        return;
    }
    let terminal_width = terminal_width();
    let compact = shared.compact || terminal_width < USAGE_COMPACT_WIDTH_THRESHOLD;
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
    let mut table = SimpleTable::new(headers, aligns, shared)
        .with_terminal_width(terminal_width)
        .with_date_compaction(true);
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
            color(shared, "Total", Color::Yellow),
            String::new(),
            color(shared, format_number(input), Color::Yellow),
            color(shared, format_number(output), Color::Yellow),
            color(shared, format_currency(total_cost), Color::Yellow),
        ]
    } else {
        vec![
            color(shared, "Total", Color::Yellow),
            String::new(),
            color(shared, format_number(input), Color::Yellow),
            color(shared, format_number(output), Color::Yellow),
            color(shared, format_number(cache_create), Color::Yellow),
            color(shared, format_number(cache_read), Color::Yellow),
            color(
                shared,
                format_number(input + output + cache_create + cache_read),
                Color::Yellow,
            ),
            color(shared, format_currency(total_cost), Color::Yellow),
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

fn empty_usage_table_message() -> &'static str {
    "No usage data found."
}

pub(crate) fn json_float(value: f64) -> Value {
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

fn project_header_row(column_count: usize, project: &str, shared: &SharedArgs) -> Vec<String> {
    let mut row = vec![String::new(); column_count];
    if let Some(first) = row.first_mut() {
        *first = color(shared, format!("Project: {project}"), Color::Blue);
    }
    row
}

fn push_breakdown_rows(
    table: &mut SimpleTable,
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
                color(
                    shared,
                    format!("  └─ {}", short_model_name(&breakdown.model_name)),
                    Color::Grey,
                ),
                String::new(),
                color(shared, format_number(breakdown.input_tokens), Color::Grey),
                color(shared, format_number(breakdown.output_tokens), Color::Grey),
                color(shared, format_currency(breakdown.cost), Color::Grey),
            ]
        } else {
            vec![
                color(
                    shared,
                    format!("  └─ {}", short_model_name(&breakdown.model_name)),
                    Color::Grey,
                ),
                String::new(),
                color(shared, format_number(breakdown.input_tokens), Color::Grey),
                color(shared, format_number(breakdown.output_tokens), Color::Grey),
                color(
                    shared,
                    format_number(breakdown.cache_creation_tokens),
                    Color::Grey,
                ),
                color(
                    shared,
                    format_number(breakdown.cache_read_tokens),
                    Color::Grey,
                ),
                color(shared, format_number(total), Color::Grey),
                color(shared, format_currency(breakdown.cost), Color::Grey),
            ]
        };
        if include_last_activity {
            values.push(String::new());
        }
        table.push(values);
    }
}

pub(crate) fn format_models_multiline(models: &[String]) -> String {
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

pub(crate) fn format_number(value: u64) -> String {
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

pub(crate) fn format_currency(value: f64) -> String {
    format!("${value:.2}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_usage_table_message_is_provider_agnostic() {
        assert_eq!(empty_usage_table_message(), "No usage data found.");
    }
}
