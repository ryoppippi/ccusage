use std::sync::Arc;

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    calculate_cost_for_usage, cli::CostMode, format_date_tz, json_value_u64, non_empty_json_string,
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
    let provider = non_empty_json_string(value.get("providerID"))?;
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
    let cost = calculate_open_code_cost(&model, &provider, usage, data.cost_usd, mode, pricing);
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
        extra_total_tokens: 0,
        credits: None,
        model: Some(model),
        usage_limit_reset_time: None,
        data,
    })
}

fn calculate_open_code_cost(
    model: &str,
    provider: &str,
    usage: TokenUsageRaw,
    cost_usd: Option<f64>,
    _mode: CostMode,
    pricing: Option<&PricingMap>,
) -> f64 {
    if let Some(cost) = cost_usd.filter(|cost| *cost > 0.0) {
        return cost;
    }
    for candidate in open_code_model_candidates(model, provider) {
        let cost =
            calculate_cost_for_usage(Some(&candidate), usage, None, CostMode::Calculate, pricing);
        if cost > 0.0 {
            return cost;
        }
    }
    0.0
}

fn open_code_model_candidates(model: &str, provider: &str) -> Vec<String> {
    let resolved = resolve_open_code_model_name(model);
    let normalized = normalize_open_code_model_name(&resolved);
    let mut base = vec![resolved];
    if normalized != base[0] {
        base.push(normalized);
    }
    let mut candidates = base.clone();
    if provider != "unknown" {
        let provider = provider.replace('-', "_");
        candidates.extend(base.into_iter().map(|model| format!("{provider}/{model}")));
    }
    candidates.dedup();
    candidates
}

fn resolve_open_code_model_name(model: &str) -> String {
    match model {
        "gemini-3-pro-high" => "gemini-3-pro-preview".to_string(),
        _ => model.to_string(),
    }
}

fn normalize_open_code_model_name(model: &str) -> String {
    for family in ["claude-haiku-", "claude-opus-", "claude-sonnet-"] {
        if let Some(rest) = model.strip_prefix(family) {
            if let Some((major, minor_and_suffix)) = rest.split_once('.') {
                if major.chars().all(|ch| ch.is_ascii_digit())
                    && minor_and_suffix
                        .chars()
                        .next()
                        .is_some_and(|ch| ch.is_ascii_digit())
                {
                    return format!("{family}{major}-{minor_and_suffix}");
                }
            }
            let mut chars = rest.chars();
            if let (Some(major), Some(minor)) = (chars.next(), chars.next()) {
                if major.is_ascii_digit() && minor.is_ascii_digit() {
                    return format!("{family}{major}-{minor}{}", chars.collect::<String>());
                }
            }
        }
    }
    model.to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{message_value_to_entry, open_code_model_candidates};
    use crate::{cli::CostMode, PricingMap};

    #[test]
    fn calculates_cost_when_opencode_stores_zero_cost() {
        let mut pricing = PricingMap::default();
        pricing.load_json(
            r#"{
                "gpt-test": {
                    "input_cost_per_token": 0.000001,
                    "output_cost_per_token": 0.000010,
                    "cache_read_input_token_cost": 0.0000001
                }
            }"#,
        );
        let entry = message_value_to_entry(
            &json!({
                "id": "message-a",
                "sessionID": "session-a",
                "providerID": "openai",
                "modelID": "gpt-test",
                "time": { "created": 0 },
                "tokens": {
                    "input": 100,
                    "output": 10,
                    "cache": { "read": 50 }
                },
                "cost": 0
            }),
            None,
            None,
            None,
            CostMode::Auto,
            Some(&pricing),
        )
        .unwrap();

        assert_eq!(entry.cost, 0.000205);
    }

    #[test]
    fn keeps_positive_opencode_cost() {
        let entry = message_value_to_entry(
            &json!({
                "id": "message-a",
                "sessionID": "session-a",
                "providerID": "openai",
                "modelID": "gpt-test",
                "time": { "created": 0 },
                "tokens": {
                    "input": 100
                },
                "cost": 0.02
            }),
            None,
            None,
            None,
            CostMode::Auto,
            None,
        )
        .unwrap();

        assert_eq!(entry.cost, 0.02);
    }

    #[test]
    fn creates_open_code_provider_and_normalized_model_candidates() {
        assert_eq!(
            open_code_model_candidates("claude-sonnet-4.5", "github-copilot"),
            vec![
                "claude-sonnet-4.5",
                "claude-sonnet-4-5",
                "github_copilot/claude-sonnet-4.5",
                "github_copilot/claude-sonnet-4-5",
            ]
        );
    }
}
