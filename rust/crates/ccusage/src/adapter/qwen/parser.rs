use std::{
    collections::HashSet,
    fs::{self, File},
    io::{BufRead, BufReader},
    path::Path,
    sync::Arc,
    time::UNIX_EPOCH,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::Value;

use super::paths;
use crate::{
    calculate_cost_for_usage,
    cli::{CostMode, SharedArgs},
    format_date_tz, format_rfc3339_millis, json_value_u64, non_empty_json_string,
    parse_ts_timestamp, parse_tz, LoadedEntry, PricingMap, Result, TimestampMs, TokenUsageRaw,
    UsageEntry, UsageMessage,
};

const DEFAULT_QWEN_MODEL: &str = "unknown";

pub(super) fn load_entries(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    let pricing = if shared.mode == CostMode::Display {
        None
    } else {
        Some(PricingMap::load(
            shared.offline,
            crate::log_level() != Some(0),
        ))
    };
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for file in paths::discover_chat_files()? {
        for entry in read_chat_file(&file, tz.as_ref(), shared.mode, pricing.as_ref())? {
            if seen.insert(entry_id(&entry)) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn read_chat_file(
    file: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Result<Vec<LoadedEntry>> {
    let fallback = file_timestamp(file);
    let input = File::open(file)?;
    let reader = BufReader::new(input);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(entry) = parse_line(file, fallback, &value, tz, mode, pricing) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

fn parse_line(
    file: &Path,
    fallback: TimestampMs,
    value: &Value,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Option<LoadedEntry> {
    let record = value.as_object()?;
    if record.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let usage = record.get("usageMetadata")?;
    let input_tokens = json_value_u64(usage.get("promptTokenCount"));
    let output_tokens = json_value_u64(usage.get("candidatesTokenCount"));
    let reasoning_tokens = json_value_u64(usage.get("thoughtsTokenCount"));
    let cache_read_tokens = json_value_u64(usage.get("cachedContentTokenCount"));
    if input_tokens == 0 && output_tokens == 0 && reasoning_tokens == 0 && cache_read_tokens == 0 {
        return None;
    }

    let timestamp_text = non_empty_json_string(record.get("timestamp"))
        .and_then(|value| parse_ts_timestamp(&value).map(|_| value))
        .unwrap_or_else(|| format_rfc3339_millis(fallback));
    let timestamp = parse_ts_timestamp(&timestamp_text).unwrap_or(fallback);
    let project = paths::project_from_file(file).unwrap_or_else(|| "unknown".to_string());
    let session_id = non_empty_json_string(record.get("sessionId")).unwrap_or_else(|| {
        let stem = file
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("unknown");
        format!("{project}-{stem}")
    });
    let model = non_empty_json_string(record.get("model"))
        .unwrap_or_else(|| DEFAULT_QWEN_MODEL.to_string());
    let display_usage = TokenUsageRaw {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cache_read_tokens,
        speed: None,
    };
    let billable_usage = TokenUsageRaw {
        output_tokens: output_tokens + reasoning_tokens,
        ..display_usage
    };
    let cost = calculate_qwen_cost(&model, billable_usage, mode, pricing);
    let data = UsageEntry {
        session_id: Some(session_id.clone()),
        timestamp: timestamp_text,
        version: None,
        message: UsageMessage {
            usage: display_usage,
            model: Some(model.clone()),
            id: None,
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    Some(LoadedEntry {
        data,
        timestamp,
        date: format_date_tz(timestamp, tz),
        project: Arc::from("qwen"),
        session_id: Arc::from(session_id),
        project_path: Arc::from(project),
        cost,
        credits: None,
        model: Some(model),
        usage_limit_reset_time: None,
        extra_total_tokens: reasoning_tokens,
    })
}

fn calculate_qwen_cost(
    model: &str,
    usage: TokenUsageRaw,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> f64 {
    for candidate in [
        model.to_string(),
        format!("qwen/{model}"),
        format!("alibaba/{model}"),
    ] {
        let cost = calculate_cost_for_usage(Some(&candidate), usage, None, mode, pricing);
        if cost > 0.0 {
            return cost;
        }
    }
    0.0
}

fn file_timestamp(file: &Path) -> TimestampMs {
    fs::metadata(file)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| TimestampMs::from_millis(duration.as_millis().min(i64::MAX as u128) as i64))
        .unwrap_or(TimestampMs::UNIX_EPOCH)
}

fn entry_id(entry: &LoadedEntry) -> String {
    let usage = entry.data.message.usage;
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        entry.session_id,
        entry.data.timestamp,
        entry.model.as_deref().unwrap_or_default(),
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens,
        entry.extra_total_tokens
    )
}
