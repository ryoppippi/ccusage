use std::{fs, path::Path, sync::Arc};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    calculate_cost_for_usage, cli::CostMode, format_date_tz, LoadedEntry, PricingMap, Result,
    TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

const DEFAULT_MODEL: &str = "google/gemini-3.5-flash";
const FALLBACK_PRICING_MODEL: &str = "google/gemini-1.5-flash";

#[derive(Debug, Clone)]
pub(super) struct AntigravityUsageEvent {
    pub(super) timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    reasoning_tokens: u64,
}

pub(super) fn parse_transcript_file(path: &Path) -> Result<Vec<AntigravityUsageEvent>> {
    let session_id = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();

    let content = fs::read_to_string(path)?;
    let mut events = Vec::new();
    let mut current_model = DEFAULT_MODEL.to_string();

    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };

        let created_at_str = record.get("created_at").and_then(Value::as_str);
        let timestamp = created_at_str
            .and_then(crate::parse_ts_timestamp)
            .unwrap_or_else(|| {
                fs::metadata(path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|d| d.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|d| i64::try_from(d.as_millis()).ok())
                    .map(TimestampMs::from_millis)
                    .unwrap_or(TimestampMs::UNIX_EPOCH)
            });

        let r_type = record.get("type").and_then(Value::as_str).unwrap_or("");
        let content_str = record.get("content").and_then(Value::as_str).unwrap_or("");

        if r_type == "USER_INPUT" {
            if let Some(model_name) = extract_model_from_settings_change(content_str) {
                current_model = format!("google/{}", model_name.to_lowercase().replace(' ', "-"));
            }
            let char_count = content_str.chars().count();
            if char_count > 0 {
                let input_tokens = (char_count as f64 * 1.5).round() as u64;
                events.push(AntigravityUsageEvent {
                    timestamp,
                    timestamp_text: crate::format_rfc3339_millis(timestamp),
                    session_id: session_id.clone(),
                    model: current_model.clone(),
                    input_tokens,
                    output_tokens: 0,
                    reasoning_tokens: 0,
                });
            }
        } else if r_type == "PLANNER_RESPONSE" {
            let char_count = content_str.chars().count();
            let thinking_str = record.get("thinking").and_then(Value::as_str).unwrap_or("");
            let thinking_count = thinking_str.chars().count();

            if char_count > 0 || thinking_count > 0 {
                let output_tokens = (char_count as f64 * 1.5).round() as u64;
                let reasoning_tokens = (thinking_count as f64 * 1.5).round() as u64;
                events.push(AntigravityUsageEvent {
                    timestamp,
                    timestamp_text: crate::format_rfc3339_millis(timestamp),
                    session_id: session_id.clone(),
                    model: current_model.clone(),
                    input_tokens: 0,
                    output_tokens,
                    reasoning_tokens,
                });
            }
        }
    }

    Ok(events)
}

fn extract_model_from_settings_change(content: &str) -> Option<String> {
    if let Some(idx) = content.find("Model Selection` from ") {
        let sub = &content[idx..];
        if let Some(to_idx) = sub.find(" to ") {
            let model_part = &sub[to_idx + 4..];
            let raw_model = if let Some(end_idx) = model_part.find('\n') {
                &model_part[..end_idx]
            } else {
                model_part
            };
            let mut end_pos = raw_model.len();
            for (char_idx, c) in raw_model.char_indices() {
                if c == '.' {
                    let next_char = raw_model[char_idx + c.len_utf8()..].chars().next();
                    if let Some(nc) = next_char {
                        if nc.is_ascii_digit() {
                            continue;
                        }
                    }
                    end_pos = char_idx;
                    break;
                }
            }
            let raw_model = &raw_model[..end_pos];
            return Some(raw_model.trim().to_string());
        }
    }
    None
}

pub(super) fn event_to_loaded(
    event: AntigravityUsageEvent,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &PricingMap,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        speed: None,
    };
    let cost =
        calculate_antigravity_cost(&event.model, usage, event.reasoning_tokens, mode, pricing);
    let data = UsageEntry {
        session_id: Some(event.session_id.clone()),
        timestamp: event.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(event.model.clone()),
            id: None,
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
        is_sidechain: None,
    };
    LoadedEntry {
        date: format_date_tz(event.timestamp, tz),
        timestamp: event.timestamp,
        project: Arc::from("antigravity"),
        session_id: Arc::from(event.session_id),
        project_path: Arc::from("Antigravity"),
        cost,
        extra_total_tokens: event.reasoning_tokens,
        credits: None,
        message_count: None,
        model: Some(event.model),
        usage_limit_reset_time: None,
        data,
    }
}

fn calculate_antigravity_cost(
    model: &str,
    usage: TokenUsageRaw,
    reasoning_tokens: u64,
    mode: CostMode,
    pricing: &PricingMap,
) -> f64 {
    let cost_usage = TokenUsageRaw {
        output_tokens: usage.output_tokens.saturating_add(reasoning_tokens),
        ..usage
    };
    let raw = calculate_cost_for_usage(Some(model), cost_usage, None, mode, Some(pricing));
    if raw > 0.0 {
        return raw;
    }
    calculate_cost_for_usage(
        Some(FALLBACK_PRICING_MODEL),
        cost_usage,
        None,
        mode,
        Some(pricing),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccusage_test_support::fs_fixture;

    #[test]
    fn parses_transcript_events_and_estimates_tokens() {
        let fixture = fs_fixture!({
            "brain/session-xyz/.system_generated/logs/transcript.jsonl": [
                r#"{"created_at":"2026-05-28T13:42:08Z","type":"USER_INPUT","content":"<USER_REQUEST>\nhello world\n</USER_REQUEST>"}"#,
                r#"{"created_at":"2026-05-28T13:42:10Z","type":"PLANNER_RESPONSE","content":"hi user","thinking":"thinking hard"}"#,
                r#"{"created_at":"2026-05-28T13:42:15Z","type":"USER_INPUT","content":"Model Selection` from None to Gemini 3.5 Flash (Medium)."}"#,
            ]
            .join("\n"),
        });

        let file = fixture.path("brain/session-xyz/.system_generated/logs/transcript.jsonl");
        let events = parse_transcript_file(&file).unwrap();

        assert_eq!(events.len(), 3);

        // 1st event: USER_INPUT
        assert_eq!(events[0].session_id, "session-xyz");
        assert_eq!(events[0].model, DEFAULT_MODEL);
        // "<USER_REQUEST>\nhello world\n</USER_REQUEST>" = 42 chars. 42 * 1.5 = 63 tokens.
        assert_eq!(events[0].input_tokens, 63);
        assert_eq!(events[0].output_tokens, 0);

        // 2nd event: PLANNER_RESPONSE
        assert_eq!(events[1].model, DEFAULT_MODEL);
        // "hi user" = 7 chars. 7 * 1.5 = 10.5 -> 11 tokens.
        assert_eq!(events[1].output_tokens, 11);
        // "thinking hard" = 13 chars. 13 * 1.5 = 19.5 -> 20 tokens.
        assert_eq!(events[1].reasoning_tokens, 20);

        // 3rd event: USER_INPUT with model change
        assert_eq!(events[2].model, "google/gemini-3.5-flash-(medium)");
    }
}
