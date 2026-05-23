use std::{collections::HashMap, fs, path::Path, sync::Arc};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    apply_total_token_fallback, calculate_cost, cli::CostMode, format_date_tz, json_value_u64,
    non_empty_json_string, LoadedEntry, PricingMap, Result, TokenUsageRaw, UsageEntry,
    UsageMessage,
};

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
        let total_tokens = json_value_u64(tokens.get("total"));
        let (usage, extra_total_tokens) = apply_total_token_fallback(usage, 0, total_tokens);
        if usage.input_tokens == 0
            && usage.output_tokens == 0
            && usage.cache_creation_input_tokens == 0
            && usage.cache_read_input_tokens == 0
            && extra_total_tokens == 0
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
        let cost_data = UsageEntry {
            message: UsageMessage {
                usage: TokenUsageRaw {
                    output_tokens: data
                        .message
                        .usage
                        .output_tokens
                        .saturating_add(extra_total_tokens),
                    ..data.message.usage
                },
                ..data.message.clone()
            },
            ..data.clone()
        };
        let cost = calculate_cost(&cost_data, mode, pricing);
        entries.push(LoadedEntry {
            date: format_date_tz(timestamp, tz),
            timestamp,
            project: Arc::from("amp"),
            session_id: Arc::from(thread_id.as_str()),
            project_path: Arc::from("Amp"),
            cost,
            extra_total_tokens,
            credits: json_value_f64(event.get("credits")),
            message_count: None,
            model: Some(model),
            usage_limit_reset_time: None,
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

#[cfg(test)]
mod tests {
    use std::{env, fs, time::SystemTime};

    use super::*;

    #[test]
    fn falls_back_to_total_tokens_when_amp_parts_are_missing() {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ccusage-amp-total-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("thread.json");
        fs::write(
            &file,
            r#"{"id":"thread-a","usageLedger":{"events":[{"id":"event-a","timestamp":"2026-01-02T00:00:00.000Z","model":"gpt-5","tokens":{"total":345}}]}}"#,
        )
        .unwrap();

        let entries = read_thread_file(&file, None, CostMode::Auto, None).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.message.usage.output_tokens, 345);
        assert_eq!(entries[0].extra_total_tokens, 0);
    }
}
