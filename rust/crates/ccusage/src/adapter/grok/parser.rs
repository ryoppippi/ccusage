use std::{fs, path::Path, sync::Arc, time::UNIX_EPOCH};

use jiff::tz::TimeZone as JiffTimeZone;
use serde::Deserialize;

use crate::{
    format_date_tz, format_rfc3339_millis, parse_ts_timestamp, LoadedEntry, Result, TimestampMs,
    TokenUsageRaw, UsageEntry, UsageMessage,
};

const DEFAULT_MODEL: &str = "grok-build";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrokSignals {
    #[serde(default)]
    context_tokens_used: u64,
    #[serde(default)]
    total_tokens_before_compaction: u64,
    primary_model_id: Option<String>,
    #[serde(default)]
    models_used: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct GrokSummary {
    current_model_id: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    last_active_at: Option<String>,
    git_root_dir: Option<String>,
    info: Option<GrokSummaryInfo>,
}

#[derive(Debug, Default, Deserialize)]
struct GrokSummaryInfo {
    id: Option<String>,
    cwd: Option<String>,
}

struct GrokSessionRecord {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    project_path: String,
    model: String,
    total_tokens: u64,
}

pub(super) fn read_session(
    signals_path: &Path,
    tz: Option<&JiffTimeZone>,
) -> Result<Option<LoadedEntry>> {
    let content = fs::read_to_string(signals_path)?;
    let Ok(signals) = serde_json::from_str::<GrokSignals>(&content) else {
        return Ok(None);
    };
    let total_tokens = signals
        .context_tokens_used
        .saturating_add(signals.total_tokens_before_compaction);
    if total_tokens == 0 {
        return Ok(None);
    }
    let summary = read_summary(signals_path);
    let record = session_record(signals_path, signals, summary, total_tokens);
    Ok(Some(record_to_loaded(record, tz)))
}

fn read_summary(signals_path: &Path) -> GrokSummary {
    let summary_path = signals_path.with_file_name("summary.json");
    let Ok(content) = fs::read_to_string(summary_path) else {
        return GrokSummary::default();
    };
    serde_json::from_str::<GrokSummary>(&content).unwrap_or_default()
}

fn session_record(
    signals_path: &Path,
    signals: GrokSignals,
    summary: GrokSummary,
    total_tokens: u64,
) -> GrokSessionRecord {
    let fallback_timestamp = file_modified_timestamp(signals_path);
    let timestamp_text = summary
        .last_active_at
        .as_deref()
        .or(summary.updated_at.as_deref())
        .or(summary.created_at.as_deref())
        .and_then(normalize_grok_timestamp)
        .unwrap_or_else(|| format_rfc3339_millis(fallback_timestamp));
    let timestamp = parse_ts_timestamp(&timestamp_text).unwrap_or(fallback_timestamp);
    let session_id = summary
        .info
        .as_ref()
        .and_then(|info| info.id.clone())
        .or_else(|| session_id_from_path(signals_path))
        .unwrap_or_else(|| "unknown".to_string());
    let project_path = summary
        .info
        .as_ref()
        .and_then(|info| info.cwd.clone())
        .or(summary.git_root_dir)
        .or_else(|| project_path_from_session_file(signals_path))
        .unwrap_or_else(|| "Grok Build".to_string());
    let model = signals
        .primary_model_id
        .or(summary.current_model_id)
        .or_else(|| signals.models_used.first().cloned())
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());
    GrokSessionRecord {
        timestamp,
        timestamp_text,
        session_id,
        project_path: project_path.trim_end_matches('/').to_string(),
        model,
        total_tokens,
    }
}

fn record_to_loaded(record: GrokSessionRecord, tz: Option<&JiffTimeZone>) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        speed: None,
    };
    let data = UsageEntry {
        session_id: Some(record.session_id.clone()),
        timestamp: record.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(record.model.clone()),
            id: None,
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
        is_sidechain: None,
    };
    LoadedEntry {
        data,
        timestamp: record.timestamp,
        date: format_date_tz(record.timestamp, tz),
        project: Arc::from("grok"),
        session_id: Arc::from(record.session_id),
        project_path: Arc::from(record.project_path),
        cost: 0.0,
        extra_total_tokens: record.total_tokens,
        credits: None,
        message_count: None,
        model: Some(record.model),
        usage_limit_reset_time: None,
        missing_pricing_model: None,
    }
}

fn normalize_grok_timestamp(value: &str) -> Option<String> {
    if parse_ts_timestamp(value).is_some() {
        return Some(value.to_string());
    }
    let dot = value.find('.')?;
    let timezone_offset = value[dot + 1..]
        .find(['Z', '+', '-'])
        .map(|offset| dot + 1 + offset)?;
    let fraction = &value[dot + 1..timezone_offset];
    if fraction.len() < 3 {
        return None;
    }
    let normalized = format!(
        "{}.{}{}",
        &value[..dot],
        &fraction[..3],
        &value[timezone_offset..]
    );
    parse_ts_timestamp(&normalized).map(|_| normalized)
}

fn file_modified_timestamp(path: &Path) -> TimestampMs {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .map(TimestampMs::from_millis)
        .unwrap_or(TimestampMs::UNIX_EPOCH)
}

fn session_id_from_path(path: &Path) -> Option<String> {
    path.parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

fn project_path_from_session_file(path: &Path) -> Option<String> {
    let encoded = path
        .parent()?
        .parent()?
        .file_name()
        .and_then(|name| name.to_str())?;
    let decoded = percent_decode(encoded);
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Some(value) = hex_byte(bytes[index + 1], bytes[index + 2]) {
                output.push(value);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_byte(high: u8, low: u8) -> Option<u8> {
    Some(hex_value(high)? * 16 + hex_value(low)?)
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use ccusage_test_support::fs_fixture;
    use jiff::tz::TimeZone;

    use super::*;

    #[test]
    fn loads_grok_session_from_signals_and_summary() {
        let fixture = fs_fixture!({
            "sessions/%2Fworkspace%2Fapi/session-a/signals.json": r#"{
                "contextTokensUsed": 12000,
                "totalTokensBeforeCompaction": 3000,
                "primaryModelId": "grok-build",
                "modelsUsed": ["grok-build"],
                "turnCount": 2
            }"#,
            "sessions/%2Fworkspace%2Fapi/session-a/summary.json": r#"{
                "current_model_id": "grok-build",
                "last_active_at": "2026-05-21T18:07:58.312121Z",
                "info": {
                    "id": "session-a",
                    "cwd": "/workspace/api"
                }
            }"#,
        });

        let entry = read_session(
            &fixture.path("sessions/%2Fworkspace%2Fapi/session-a/signals.json"),
            Some(&TimeZone::UTC),
        )
        .unwrap()
        .unwrap();

        assert_eq!(entry.date, "2026-05-21");
        assert_eq!(entry.session_id.as_ref(), "session-a");
        assert_eq!(entry.project_path.as_ref(), "/workspace/api");
        assert_eq!(entry.model.as_deref(), Some("grok-build"));
        assert_eq!(entry.extra_total_tokens, 15_000);
        assert_eq!(entry.message_count, None);
        assert_eq!(entry.data.message.usage.input_tokens, 0);
        assert_eq!(entry.cost, 0.0);
    }

    #[test]
    fn falls_back_to_path_metadata_when_summary_is_missing() {
        let fixture = fs_fixture!({
            "sessions/%2Fworkspace%2Fapi/session-b/signals.json": r#"{
                "contextTokensUsed": 42,
                "modelsUsed": ["grok-composer-2.5-fast"]
            }"#,
        });

        let entry = read_session(
            &fixture.path("sessions/%2Fworkspace%2Fapi/session-b/signals.json"),
            None,
        )
        .unwrap()
        .unwrap();

        assert_eq!(entry.session_id.as_ref(), "session-b");
        assert_eq!(entry.project_path.as_ref(), "/workspace/api");
        assert_eq!(entry.model.as_deref(), Some("grok-composer-2.5-fast"));
        assert_eq!(entry.extra_total_tokens, 42);
    }

    #[test]
    fn skips_zero_token_sessions() {
        let fixture = fs_fixture!({
            "sessions/%2Fworkspace%2Fapi/session-c/signals.json": r#"{
                "contextTokensUsed": 0,
                "totalTokensBeforeCompaction": 0
            }"#,
        });

        let entry = read_session(
            &fixture.path("sessions/%2Fworkspace%2Fapi/session-c/signals.json"),
            None,
        )
        .unwrap();

        assert!(entry.is_none());
    }

    #[test]
    fn normalizes_microsecond_grok_timestamps_to_milliseconds() {
        assert_eq!(
            normalize_grok_timestamp("2026-05-21T18:07:58.312121Z").as_deref(),
            Some("2026-05-21T18:07:58.312Z")
        );
    }
}
