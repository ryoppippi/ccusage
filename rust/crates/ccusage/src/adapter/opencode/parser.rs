use std::sync::Arc;

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    calculate_cost, cli::CostMode, format_date_tz, json_value_u64, non_empty_json_string,
    LoadedEntry, PricingMap, TokenUsageRaw, UsageEntry, UsageMessage,
};

pub(crate) fn message_value_to_entry(
    value: &Value,
    id: Option<String>,
    session_id: Option<String>,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Option<LoadedEntry> {
    let tokens = value.get("tokens")?;
    let usage = TokenUsageRaw {
        input_tokens: json_value_u64(tokens.get("input")),
        output_tokens: json_value_u64(tokens.get("output")),
        cache_creation_input_tokens: tokens
            .get("cache")
            .map_or(0, |cache| json_value_u64(cache.get("write"))),
        cache_read_input_tokens: tokens
            .get("cache")
            .map_or(0, |cache| json_value_u64(cache.get("read"))),
        speed: None,
    };
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_creation_input_tokens == 0
        && usage.cache_read_input_tokens == 0
    {
        return None;
    }
    let model = non_empty_json_string(value.get("modelID"))?;
    let _provider = non_empty_json_string(value.get("providerID"))?;
    let millis = value
        .get("time")
        .and_then(|time| time.get("created"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let timestamp = crate::TimestampMs::from_millis(millis);
    let timestamp_text = crate::format_rfc3339_millis(timestamp);
    let message_id = id.or_else(|| non_empty_json_string(value.get("id")));
    let session_id = session_id.or_else(|| non_empty_json_string(value.get("sessionID")));
    let data = UsageEntry {
        session_id: session_id.clone(),
        timestamp: timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(model.clone()),
            id: message_id,
        },
        cost_usd: value.get("cost").and_then(Value::as_f64),
        request_id: None,
        is_api_error_message: None,
    };
    let cost = calculate_cost(&data, mode, pricing);
    let loaded_session_id = data
        .session_id
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    Some(LoadedEntry {
        date: format_date_tz(timestamp, tz),
        timestamp,
        project: Arc::from("opencode"),
        session_id: Arc::from(loaded_session_id),
        project_path: Arc::from("OpenCode"),
        cost,
        credits: None,
        extra_total_tokens: 0,
        model: Some(model),
        usage_limit_reset_time: None,
        data,
    })
}
