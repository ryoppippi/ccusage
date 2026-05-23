use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use crate::{
    apply_total_token_fallback, calculate_cost_for_usage, cli::CostMode, format_date_tz,
    json_value_u64, non_empty_json_string, LoadedEntry, PricingMap, Result, TimestampMs,
    TokenUsageRaw, UsageEntry, UsageMessage,
};

const DEFAULT_MODEL: &str = "kimi-for-coding";
const DEFAULT_PROVIDER: &str = "moonshot";

#[derive(Debug, Clone)]
pub(super) struct KimiUsageEntry {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    message_id: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    extra_total_tokens: u64,
}

pub(super) fn read_wire_file(path: &Path) -> Result<Vec<KimiUsageEntry>> {
    let model = read_model_from_config(path);
    let fallback_timestamp = file_modified_timestamp(path);
    let content = fs::read_to_string(path)?;
    Ok(content
        .lines()
        .filter(|line| line.contains("\"StatusUpdate\"") && line.contains("\"token_usage\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| wire_line_to_entry(&value, path, &model, fallback_timestamp))
        .collect::<Vec<_>>())
}

fn read_model_from_config(file_path: &Path) -> String {
    let Some(root) = kimi_root_from_wire_path(file_path) else {
        return DEFAULT_MODEL.to_string();
    };
    let Ok(content) = fs::read_to_string(root.join("config.json")) else {
        return DEFAULT_MODEL.to_string();
    };
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return DEFAULT_MODEL.to_string();
    };
    non_empty_json_string(value.get("model")).unwrap_or_else(|| DEFAULT_MODEL.to_string())
}

fn kimi_root_from_wire_path(file_path: &Path) -> Option<PathBuf> {
    file_path
        .parent()?
        .parent()?
        .parent()?
        .parent()
        .map(Path::to_path_buf)
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

fn wire_line_to_entry(
    value: &Value,
    file_path: &Path,
    model: &str,
    fallback_timestamp: TimestampMs,
) -> Option<KimiUsageEntry> {
    if value.get("type").and_then(Value::as_str) == Some("metadata") {
        return None;
    }
    let message = value.get("message")?;
    if message.get("type").and_then(Value::as_str) != Some("StatusUpdate") {
        return None;
    }
    let payload = message.get("payload")?;
    let token_usage = payload.get("token_usage")?;
    let input_tokens = json_value_u64(token_usage.get("input_other"));
    let output_tokens = json_value_u64(token_usage.get("output"));
    let cache_creation_tokens = json_value_u64(token_usage.get("input_cache_creation"));
    let cache_read_tokens = json_value_u64(token_usage.get("input_cache_read"));
    let total_tokens = json_value_u64(token_usage.get("total"));
    let usage = TokenUsageRaw {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: cache_creation_tokens,
        cache_read_input_tokens: cache_read_tokens,
        speed: None,
    };
    let (usage, extra_total_tokens) = apply_total_token_fallback(usage, 0, total_tokens);
    if crate::total_usage_tokens(usage) + extra_total_tokens == 0 {
        return None;
    }
    let timestamp = value
        .get("timestamp")
        .and_then(Value::as_f64)
        .and_then(timestamp_from_seconds)
        .unwrap_or(fallback_timestamp);
    Some(KimiUsageEntry {
        timestamp,
        timestamp_text: crate::format_rfc3339_millis(timestamp),
        session_id: extract_session_id(file_path),
        model: model.to_string(),
        message_id: non_empty_json_string(payload.get("message_id")),
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        extra_total_tokens,
    })
}

fn timestamp_from_seconds(seconds: f64) -> Option<TimestampMs> {
    if !seconds.is_finite() {
        return None;
    }
    let millis = (seconds * 1000.0).trunc();
    if millis < i64::MIN as f64 || millis > i64::MAX as f64 {
        return None;
    }
    Some(TimestampMs::from_millis(millis as i64))
}

fn extract_session_id(file_path: &Path) -> String {
    file_path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

pub(super) fn kimi_entry_key(entry: &KimiUsageEntry) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}:{}",
        entry.session_id,
        entry.message_id.as_deref().unwrap_or_default(),
        entry.timestamp_text,
        entry.model,
        entry.input_tokens,
        entry.output_tokens,
        entry.cache_creation_tokens,
        entry.cache_read_tokens,
        entry.extra_total_tokens
    )
}

pub(super) fn kimi_entry_to_loaded(
    entry: KimiUsageEntry,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &PricingMap,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_tokens,
        cache_read_input_tokens: entry.cache_read_tokens,
        speed: None,
    };
    let cost = calculate_kimi_cost(&entry, mode, pricing, usage);
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(entry.model.clone()),
            id: entry.message_id.clone(),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("kimi"),
        session_id: Arc::from(entry.session_id),
        project_path: Arc::from("Kimi"),
        cost,
        extra_total_tokens: entry.extra_total_tokens,
        credits: None,
        message_count: None,
        model: Some(entry.model),
        usage_limit_reset_time: None,
        data,
    }
}

fn calculate_kimi_cost(
    entry: &KimiUsageEntry,
    mode: CostMode,
    pricing: &PricingMap,
    usage: TokenUsageRaw,
) -> f64 {
    match mode {
        CostMode::Display => 0.0,
        CostMode::Auto | CostMode::Calculate => {
            for candidate in model_candidates(&entry.model) {
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

fn model_candidates(model: &str) -> Vec<String> {
    let mut candidates = vec![
        format!("{DEFAULT_PROVIDER}/{model}"),
        format!("kimi/{model}"),
        model.to_string(),
    ];
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|candidate| seen.insert(candidate.clone()));
    candidates
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use super::*;

    fn temp_kimi_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-kimi-{name}-{nanos}"));
        path
    }

    #[test]
    fn falls_back_to_total_tokens_when_kimi_parts_are_missing() {
        let kimi_dir = temp_kimi_dir("total");
        fs::create_dir_all(kimi_dir.join("sessions/group/session-a")).unwrap();
        fs::write(kimi_dir.join("config.json"), r#"{"model":"kimi-k2"}"#).unwrap();
        let file = kimi_dir.join("sessions/group/session-a/wire.jsonl");
        let value = serde_json::json!({
            "timestamp": 1770983427.123,
            "message": {
                "type": "StatusUpdate",
                "payload": {
                    "token_usage": {
                        "total": 432
                    }
                }
            }
        });

        let entry = wire_line_to_entry(&value, &file, "kimi-k2", TimestampMs::UNIX_EPOCH).unwrap();
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert_eq!(entry.output_tokens, 432);
        assert_eq!(entry.extra_total_tokens, 0);
    }
}
