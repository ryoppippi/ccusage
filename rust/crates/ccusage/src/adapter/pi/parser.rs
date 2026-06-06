use std::{fs, path::Path, sync::Arc};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    apply_total_token_fallback, format_date_tz, json_value_u64, non_empty_json_string, LoadedEntry,
    Result, TokenUsageRaw, UsageEntry, UsageMessage,
};

pub(crate) fn read_session_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
) -> Result<Vec<LoadedEntry>> {
    let content = fs::read_to_string(path)?;
    let project = extract_project(path);
    let session_id = extract_session_id(path);
    let mut entries = Vec::new();

    for line in content.lines() {
        if !line.contains("\"usage\"") || !line.contains("\"message\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !is_pi_message_usage(&value) {
            continue;
        }
        let Some(timestamp_text) = non_empty_json_string(value.get("timestamp")) else {
            continue;
        };
        let Some(timestamp) = crate::parse_ts_timestamp(&timestamp_text) else {
            continue;
        };
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(usage_value) = message.get("usage") else {
            continue;
        };
        let input = json_value_u64(usage_value.get("input"));
        let output = json_value_u64(usage_value.get("output"));
        let cache_read = json_value_u64(usage_value.get("cacheRead"));
        let cache_create = json_value_u64(usage_value.get("cacheWrite"));
        let total = json_value_u64(usage_value.get("totalTokens"));
        let usage = TokenUsageRaw {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cache_create,
            cache_read_input_tokens: cache_read,
            speed: None,
            cache_creation: None,
        };
        let (usage, extra_total_tokens) = apply_total_token_fallback(usage, 0, total);
        if crate::total_usage_tokens(usage) + extra_total_tokens == 0 {
            continue;
        }
        let model =
            non_empty_json_string(message.get("model")).map(|model| format!("[pi] {model}"));
        let cost = usage_value
            .get("cost")
            .and_then(|cost| cost.get("total"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let data = UsageEntry {
            session_id: Some(session_id.clone()),
            timestamp: timestamp_text,
            version: None,
            message: UsageMessage {
                usage,
                model: model.clone(),
                id: None,
            },
            cost_usd: Some(cost),
            request_id: None,
            is_api_error_message: None,
            is_sidechain: None,
        };
        entries.push(LoadedEntry {
            date: format_date_tz(timestamp, tz),
            timestamp,
            project: Arc::from(project.as_str()),
            session_id: Arc::from(session_id.as_str()),
            project_path: Arc::from(project.as_str()),
            cost,
            extra_total_tokens,
            credits: None,
            message_count: None,
            model,
            data,
            usage_limit_reset_time: None,
            missing_pricing_model: None,
        });
    }
    Ok(entries)
}

fn is_pi_message_usage(value: &Value) -> bool {
    let message_type = value.get("type").and_then(Value::as_str);
    if message_type.is_some_and(|message_type| message_type != "message") {
        return false;
    }
    let Some(message) = value.get("message") else {
        return false;
    };
    message.get("role").and_then(Value::as_str) == Some("assistant")
        && message.get("usage").is_some()
}

fn extract_session_id(path: &Path) -> String {
    let filename = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    filename
        .split_once('_')
        .map_or(filename, |(_, session)| session)
        .to_string()
}

fn extract_project(path: &Path) -> String {
    let mut previous_was_sessions = false;
    for component in path.components() {
        let segment = component.as_os_str().to_string_lossy();
        if previous_was_sessions {
            return segment.into_owned();
        }
        previous_was_sessions = segment == "sessions";
    }
    "unknown".to_string()
}

pub(super) fn entry_id(entry: &LoadedEntry) -> String {
    [
        "pi",
        entry.project.as_ref(),
        entry.session_id.as_ref(),
        entry.data.timestamp.as_str(),
        entry.model.as_deref().unwrap_or_default(),
        &entry.data.message.usage.input_tokens.to_string(),
        &entry.data.message.usage.output_tokens.to_string(),
        &entry
            .data
            .message
            .usage
            .cache_creation_input_tokens
            .to_string(),
        &entry.data.message.usage.cache_read_input_tokens.to_string(),
        &entry.extra_total_tokens.to_string(),
        &entry.cost.to_string(),
    ]
    .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccusage_test_support::fs_fixture;

    #[test]
    fn falls_back_to_total_tokens_when_pi_parts_are_missing() {
        let fixture = fs_fixture!({
            "sessions/project-a/agent_session-a.jsonl": r#"{"type":"message","timestamp":"2026-01-02T00:00:00.000Z","message":{"role":"assistant","model":"gpt-5","usage":{"totalTokens":333}}}"#,
        });
        let file = fixture.path("sessions/project-a/agent_session-a.jsonl");

        let entries = read_session_file(&file, None).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.message.usage.output_tokens, 333);
        assert_eq!(entries[0].extra_total_tokens, 0);
    }
}
