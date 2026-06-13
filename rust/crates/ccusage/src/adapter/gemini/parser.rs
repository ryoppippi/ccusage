use std::{collections::HashMap, fs, path::Path, sync::Arc};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{Map, Value};

use crate::{
    LoadedEntry, PricingMap, Result, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
    apply_total_token_fallback, calculate_cost_for_usage, cli::CostMode, format_date_tz,
    missing_pricing_model_for_candidates, non_empty_json_string,
};

const DEFAULT_MODEL: &str = "unknown";
const PROVIDER_PREFIXES: [&str; 4] = ["google", "gemini", "vertex_ai", "openrouter/google"];

#[derive(Debug, Clone, Copy, Default)]
struct GeminiTokens {
    input: u64,
    output: u64,
    cached: u64,
    thoughts: u64,
    tool: u64,
    total: Option<u64>,
}

#[derive(Debug, Clone)]
pub(super) struct GeminiUsageEvent {
    pub(super) timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
    message_id: Option<String>,
}

pub(super) fn parse_json_file(path: &Path) -> Result<Vec<GeminiUsageEvent>> {
    let fallback_timestamp = file_modified_timestamp(path);
    let content = fs::read_to_string(path)?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(Vec::new());
    };
    let Some(record) = value.as_object() else {
        return Ok(Vec::new());
    };
    let session_id = string_at(record, "sessionId")
        .or_else(|| string_at(record, "session_id"))
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("unknown")
                .to_string()
        });
    let session_timestamp = timestamp_at(record, "startTime")
        .or_else(|| timestamp_at(record, "lastUpdated"))
        .unwrap_or(fallback_timestamp);
    if let Some(messages) = record.get("messages").and_then(Value::as_array) {
        return Ok(messages
            .iter()
            .filter_map(Value::as_object)
            .filter(|message| message.get("type").and_then(Value::as_str) == Some("gemini"))
            .filter_map(|message| parse_direct_event(message, None, &session_id, session_timestamp))
            .collect());
    }
    if record.get("type").and_then(Value::as_str) == Some("gemini") {
        return Ok(
            parse_direct_event(record, None, &session_id, fallback_timestamp)
                .into_iter()
                .collect(),
        );
    }
    let stats = record
        .get("stats")
        .or_else(|| record.get("result").and_then(|result| result.get("stats")));
    Ok(parse_stats_events(
        stats,
        string_at(record, "model").as_deref(),
        &session_id,
        timestamp_at(record, "timestamp").unwrap_or(fallback_timestamp),
    ))
}

pub(super) fn parse_jsonl_file(path: &Path) -> Result<Vec<GeminiUsageEvent>> {
    let fallback_timestamp = file_modified_timestamp(path);
    let mut session_id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut current_model = None::<String>;
    let mut events = Vec::new();
    let mut direct_event_indexes = HashMap::<String, usize>::new();
    let content = fs::read_to_string(path)?;
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        if let Some(value) =
            string_at(record, "sessionId").or_else(|| string_at(record, "session_id"))
        {
            session_id = value;
        }
        if let Some(model) = string_at(record, "model") {
            current_model = Some(model);
        }
        if record.get("type").and_then(Value::as_str) == Some("gemini") {
            let Some(event) = parse_direct_event(
                record,
                current_model.as_deref(),
                &session_id,
                fallback_timestamp,
            ) else {
                continue;
            };
            if let Some(id) = string_at(record, "id") {
                if let Some(index) = direct_event_indexes.get(&id).copied() {
                    events[index] = event;
                } else {
                    direct_event_indexes.insert(id, events.len());
                    events.push(event);
                }
            } else {
                events.push(event);
            }
            continue;
        }
        let stats = record
            .get("stats")
            .or_else(|| record.get("result").and_then(|result| result.get("stats")));
        if stats.is_some() {
            events.extend(parse_stats_events(
                stats,
                current_model.as_deref(),
                &session_id,
                timestamp_at(record, "timestamp").unwrap_or(fallback_timestamp),
            ));
        }
    }
    Ok(events)
}

fn parse_direct_event(
    record: &Map<String, Value>,
    model_hint: Option<&str>,
    session_id: &str,
    fallback_timestamp: TimestampMs,
) -> Option<GeminiUsageEvent> {
    let tokens = parse_tokens(record.get("tokens"))?;
    build_event(
        string_at(record, "model").as_deref().or(model_hint),
        session_id,
        timestamp_at(record, "timestamp")
            .or_else(|| timestamp_at(record, "created_at"))
            .unwrap_or(fallback_timestamp),
        tokens,
        normalize_session_input,
        string_at(record, "id"),
    )
}

fn parse_stats_events(
    stats: Option<&Value>,
    model_hint: Option<&str>,
    session_id: &str,
    timestamp: TimestampMs,
) -> Vec<GeminiUsageEvent> {
    let Some(stats) = stats.and_then(Value::as_object) else {
        return Vec::new();
    };
    if let Some(models) = stats.get("models").and_then(Value::as_object) {
        let events = models
            .iter()
            .filter_map(|(model, data)| {
                let data = data.as_object()?;
                let tokens = parse_tokens(data.get("tokens"))?;
                build_event(
                    Some(model),
                    session_id,
                    timestamp,
                    tokens,
                    subtract_cached_overlap_tokens,
                    None,
                )
            })
            .collect::<Vec<_>>();
        if !events.is_empty() {
            return events;
        }
    }
    let Some(tokens) = parse_tokens(Some(&Value::Object(stats.clone()))) else {
        return Vec::new();
    };
    build_event(
        model_hint.or(Some(DEFAULT_MODEL)),
        session_id,
        timestamp,
        tokens,
        subtract_cached_overlap_tokens,
        None,
    )
    .into_iter()
    .collect()
}

fn build_event(
    model: Option<&str>,
    session_id: &str,
    timestamp: TimestampMs,
    tokens: GeminiTokens,
    normalize_input: fn(GeminiTokens) -> (u64, u64),
    message_id: Option<String>,
) -> Option<GeminiUsageEvent> {
    let model = model.filter(|model| !model.trim().is_empty())?;
    let (input_without_cache, cache_read_tokens) = normalize_input(tokens);
    let input_tokens = input_without_cache + tokens.tool;
    let total_tokens = tokens
        .total
        .unwrap_or(input_tokens + tokens.output + cache_read_tokens + tokens.thoughts);
    let display_usage = TokenUsageRaw {
        input_tokens,
        output_tokens: tokens.output,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cache_read_tokens,
        speed: None,
        cache_creation: None,
    };
    let (display_usage, extra_total_tokens) =
        apply_total_token_fallback(display_usage, tokens.thoughts, total_tokens);
    if display_usage.input_tokens == 0
        && display_usage.output_tokens == 0
        && display_usage.cache_read_input_tokens == 0
        && extra_total_tokens == 0
    {
        return None;
    }
    Some(GeminiUsageEvent {
        timestamp,
        timestamp_text: crate::format_rfc3339_millis(timestamp),
        session_id: session_id.to_string(),
        model: model.to_string(),
        input_tokens: display_usage.input_tokens,
        output_tokens: display_usage.output_tokens,
        cache_read_tokens: display_usage.cache_read_input_tokens,
        reasoning_tokens: extra_total_tokens,
        total_tokens,
        message_id,
    })
}

fn parse_tokens(value: Option<&Value>) -> Option<GeminiTokens> {
    let record = value?.as_object()?;
    Some(GeminiTokens {
        input: token_number(
            record,
            &["input", "prompt", "input_tokens", "prompt_tokens"],
        ),
        output: token_number(
            record,
            &["output", "candidates", "output_tokens", "candidates_tokens"],
        ),
        cached: token_number(record, &["cached", "cached_tokens"]),
        thoughts: token_number(
            record,
            &[
                "thoughts",
                "reasoning",
                "thoughts_tokens",
                "reasoning_tokens",
            ],
        ),
        tool: token_number(record, &["tool", "tool_tokens"]),
        total: value_u64(record.get("total").or_else(|| record.get("total_tokens"))),
    })
}

fn token_number(record: &Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value_u64(record.get(*key)))
        .unwrap_or(0)
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
    let value = value?.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.max(0.0).trunc() as u64)
}

fn subtract_cached_overlap_tokens(tokens: GeminiTokens) -> (u64, u64) {
    let cache_read = tokens.cached;
    let cached_portion = tokens.input.min(cache_read);
    (tokens.input.saturating_sub(cached_portion), cache_read)
}

fn normalize_session_input(tokens: GeminiTokens) -> (u64, u64) {
    let inclusive_total = tokens.input + tokens.output + tokens.thoughts + tokens.tool;
    let exclusive_total = inclusive_total + tokens.cached;
    if tokens.cached > 0
        && tokens.total == Some(inclusive_total)
        && tokens.total != Some(exclusive_total)
    {
        return subtract_cached_overlap_tokens(tokens);
    }
    (tokens.input, tokens.cached)
}

fn timestamp_at(record: &Map<String, Value>, key: &str) -> Option<TimestampMs> {
    timestamp_from_value(record.get(key)?)
}

fn timestamp_from_value(value: &Value) -> Option<TimestampMs> {
    let raw = value.as_str()?;
    crate::parse_ts_timestamp(raw)
}

fn string_at(record: &Map<String, Value>, key: &str) -> Option<String> {
    non_empty_json_string(record.get(key))
}

fn file_modified_timestamp(path: &Path) -> TimestampMs {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .map(TimestampMs::from_millis)
        .unwrap_or(TimestampMs::UNIX_EPOCH)
}

pub(super) fn event_to_loaded(
    event: GeminiUsageEvent,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &PricingMap,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: event.cache_read_tokens,
        speed: None,
        cache_creation: None,
    };
    let cost_usage = TokenUsageRaw {
        output_tokens: event.output_tokens + event.reasoning_tokens,
        cache_creation: None,
        ..usage
    };
    let extra_total_tokens = event
        .total_tokens
        .saturating_sub(event.input_tokens + event.output_tokens + event.cache_read_tokens);
    let cost = calculate_gemini_cost(&event.model, cost_usage, mode, pricing);
    let missing_pricing_model = missing_gemini_pricing(&event.model, cost_usage, mode, pricing);
    let data = UsageEntry {
        session_id: Some(event.session_id.clone()),
        timestamp: event.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(event.model.clone()),
            id: event.message_id,
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
        is_sidechain: None,
    };
    LoadedEntry {
        date: format_date_tz(event.timestamp, tz),
        timestamp: event.timestamp,
        project: Arc::from("gemini"),
        session_id: Arc::from(event.session_id),
        project_path: Arc::from("Gemini"),
        cost,
        extra_total_tokens,
        credits: None,
        message_count: None,
        model: Some(event.model),
        usage_limit_reset_time: None,
        missing_pricing_model,
        data,
    }
}

fn calculate_gemini_cost(
    model: &str,
    usage: TokenUsageRaw,
    mode: CostMode,
    pricing: &PricingMap,
) -> f64 {
    match mode {
        CostMode::Display => 0.0,
        CostMode::Auto | CostMode::Calculate => {
            for candidate in model_candidates(model) {
                if pricing.find(&candidate).is_some() {
                    return calculate_cost_for_usage(
                        Some(&candidate),
                        usage,
                        None,
                        CostMode::Calculate,
                        Some(pricing),
                    );
                }
            }
            0.0
        }
    }
}

fn missing_gemini_pricing(
    model: &str,
    usage: TokenUsageRaw,
    mode: CostMode,
    pricing: &PricingMap,
) -> Option<String> {
    if mode == CostMode::Display {
        return None;
    }
    missing_pricing_model_for_candidates(
        model,
        model_candidates(model),
        crate::total_usage_tokens(usage),
        Some(pricing),
    )
}

fn model_candidates(model: &str) -> Vec<String> {
    let mut candidates = Vec::with_capacity(PROVIDER_PREFIXES.len() + 1);
    candidates.extend(
        PROVIDER_PREFIXES
            .iter()
            .map(|prefix| format!("{prefix}/{model}")),
    );
    candidates.push(model.to_string());
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_total_tokens_when_gemini_parts_are_missing() {
        let event = build_event(
            Some("gemini-test"),
            "session-a",
            TimestampMs::UNIX_EPOCH,
            GeminiTokens {
                total: Some(654),
                ..GeminiTokens::default()
            },
            normalize_session_input,
            None,
        )
        .unwrap();

        assert_eq!(event.output_tokens, 654);
        assert_eq!(event.reasoning_tokens, 0);
    }
}
