use std::{
    fs,
    io::{BufRead, BufReader},
    path::Path,
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{Map, Value};

use crate::{
    apply_total_token_fallback, format_date_tz, json_value_u64, non_empty_json_string, LoadedEntry,
    Result, TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

/// Internal staging struct for a parsed CodeBuddy assistant turn.
/// Fields mirror what we need to assemble a `LoadedEntry` plus the
/// line-level `id` for cross-file deduplication (see entry_id below).
#[derive(Debug, Clone)]
struct CodeBuddyEntry {
    id: Option<String>, // line-level "id" — primary dedup key per spec §4.3
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    cwd: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    total_tokens: u64,
}

pub(super) fn parse_session_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
) -> Result<Vec<LoadedEntry>> {
    let fallback_session_id = extract_session_id_from_filename(path);
    let input = fs::File::open(path)?;
    let reader = BufReader::new(input);
    let mut entries = Vec::new();
    for line in reader.lines() {
        let line = line?;
        // Cheap pre-filter: only lines that mention rawUsage are candidates.
        if !line.contains("\"rawUsage\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(record) = value.as_object() else {
            continue;
        };
        if let Some(entry) = parse_message_entry(record, &fallback_session_id) {
            entries.push(codebuddy_entry_to_loaded(entry, tz));
        }
    }
    Ok(entries)
}

fn parse_message_entry(
    record: &Map<String, Value>,
    fallback_session_id: &str,
) -> Option<CodeBuddyEntry> {
    let provider = record.get("providerData")?.as_object()?;
    let raw = provider.get("rawUsage")?.as_object()?;

    let input_tokens = json_value_u64(raw.get("prompt_tokens"));
    let output_tokens = json_value_u64(raw.get("completion_tokens"));
    let cache_creation_tokens = json_value_u64(raw.get("cache_creation_input_tokens"));
    let cache_read_tokens = json_value_u64(raw.get("cache_read_input_tokens"));
    let total_tokens = json_value_u64(raw.get("total_tokens"));

    let usage = TokenUsageRaw {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: cache_creation_tokens,
        cache_read_input_tokens: cache_read_tokens,
        speed: None,
    };
    // Mirrors openclaw/parser.rs:119-123 verbatim (load-bearing).
    let (usage, extra_total) = apply_total_token_fallback(usage, 0, total_tokens);
    if crate::total_usage_tokens(usage) + extra_total == 0 {
        return None;
    }
    let total = total_tokens.max(crate::total_usage_tokens(usage) + extra_total);

    // Model precedence: model (Tencent MaaS slug, ~100% present) →
    // requestModelId (friendly Anthropic-style id, ~40% present) →
    // "unknown". Choosing model first avoids splitting one underlying
    // model into two report rows.
    let model = non_empty_json_string(provider.get("model"))
        .or_else(|| non_empty_json_string(provider.get("requestModelId")))
        .unwrap_or_else(|| "unknown".to_string());

    let timestamp = TimestampMs::from_millis(json_value_u64(record.get("timestamp")) as i64);

    let session_id = non_empty_json_string(record.get("sessionId"))
        .unwrap_or_else(|| fallback_session_id.to_string());

    let cwd = non_empty_json_string(record.get("cwd"));
    let id = non_empty_json_string(record.get("id"));

    Some(CodeBuddyEntry {
        id,
        timestamp,
        timestamp_text: crate::format_rfc3339_millis(timestamp),
        session_id,
        model: format!("[codebuddy] {model}"),
        cwd,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_tokens: usage.cache_creation_input_tokens,
        cache_read_tokens: usage.cache_read_input_tokens,
        total_tokens: total,
    })
}

fn codebuddy_entry_to_loaded(entry: CodeBuddyEntry, tz: Option<&JiffTimeZone>) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_tokens,
        cache_read_input_tokens: entry.cache_read_tokens,
        speed: None,
    };
    let project_path = entry.cwd.clone().unwrap_or_else(|| "codebuddy".to_string());
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text.clone(),
        version: None,
        message: UsageMessage {
            usage,
            model: Some(entry.model.clone()),
            id: None,
        },
        cost_usd: Some(0.0),
        // line-level "id" — used as primary dedup key by entry_id.
        request_id: entry.id.clone(),
        is_api_error_message: None,
        is_sidechain: None,
    };
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from(project_path.clone()),
        session_id: Arc::from(entry.session_id),
        project_path: Arc::from(project_path),
        cost: 0.0,
        // Mirrors openclaw/parser.rs:181-186 verbatim.
        extra_total_tokens: entry.total_tokens.saturating_sub(
            entry.input_tokens
                + entry.output_tokens
                + entry.cache_creation_tokens
                + entry.cache_read_tokens,
        ),
        credits: None,
        message_count: None,
        model: Some(entry.model),
        data,
        usage_limit_reset_time: None,
        missing_pricing_model: Some("codebuddy".to_string()),
    }
}

fn extract_session_id_from_filename(path: &Path) -> String {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    if let Some(stem) = filename.strip_suffix(".jsonl") {
        if !stem.is_empty() {
            return stem.to_string();
        }
    }
    filename.to_string()
}

pub(super) fn entry_id(entry: &LoadedEntry) -> String {
    // Per spec §4.3: primary dedup key is the line-level `id` field
    // (stored in data.request_id). Fall back to a token-tuple only when
    // `id` is absent, intentionally NOT including the file path so
    // cross-file duplicates collapse.
    if let Some(id) = entry.data.request_id.as_deref() {
        return format!("codebuddy:id:{id}");
    }
    let usage = entry.data.message.usage;
    [
        "codebuddy:fallback".to_string(),
        entry.data.timestamp.clone(),
        entry.model.clone().unwrap_or_default(),
        usage.input_tokens.to_string(),
        usage.output_tokens.to_string(),
        usage.cache_creation_input_tokens.to_string(),
        usage.cache_read_input_tokens.to_string(),
    ]
    .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Path inside the fixtures directory. All fixture files are sibling-
    /// committed alongside parser.rs at adapter/codebuddy/fixtures/*.jsonl.
    fn fixture_path(name: &str) -> std::path::PathBuf {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("src/adapter/codebuddy/fixtures");
        p.push(name);
        p
    }

    /// A `function_call` line with `providerData.rawUsage` carrying both
    /// `model` (Tencent MaaS slug) and `requestModelId` (friendly id) —
    /// the canonical assistant turn shape. Per spec §4.3 model wins over
    /// requestModelId, so the parsed model is the MaaS slug.
    #[test]
    fn parses_basic_function_call_with_raw_usage() {
        let entries = parse_session_file(&fixture_path("main_session_basic.jsonl"), None).unwrap();
        // main_session_basic.jsonl: line 1 (function_call rawUsage),
        // line 2 (function_call_result, skipped), line 3 (message
        // rawUsage). So 2 parsed entries; we look at the first.
        assert_eq!(entries.len(), 2, "expected 2 parsed entries");
        let first = &entries[0];
        assert_eq!(
            first.model.as_deref(),
            Some("[codebuddy] MaaS_Cl_Opus_4.7_20260416_cache")
        );
        assert_eq!(first.data.message.usage.input_tokens, 74408);
        assert_eq!(first.data.message.usage.output_tokens, 281);
        assert_eq!(first.data.message.usage.cache_creation_input_tokens, 74402);
        assert_eq!(first.data.message.usage.cache_read_input_tokens, 0);
        // request_id carries the line-level "id" for dedup.
        assert_eq!(
            first.data.request_id.as_deref(),
            Some("chatcmpl-AAAAAAAAAAAAAAAAAAAAAAAAA")
        );
    }

    /// Both `function_call` and `message` rawUsage lines should be
    /// consumed identically.
    #[test]
    fn parses_message_type_lines() {
        let entries = parse_session_file(&fixture_path("main_session_basic.jsonl"), None).unwrap();
        // Second parsed entry corresponds to the message-type line at the
        // end of the fixture.
        let second = &entries[1];
        assert_eq!(
            second.model.as_deref(),
            Some("[codebuddy] MaaS_Cl_Opus_4.7_20260416_cache")
        );
        assert_eq!(second.data.message.usage.input_tokens, 1500);
        assert_eq!(second.data.message.usage.output_tokens, 42);
        assert_eq!(second.data.message.usage.cache_creation_input_tokens, 0);
        assert_eq!(second.data.message.usage.cache_read_input_tokens, 1400);
    }

    /// Lines without `providerData.rawUsage` (function_call_result, topic,
    /// summary, file-history-snapshot) all return None.
    #[test]
    fn skips_lines_without_raw_usage() {
        // edge_cases.jsonl has 6 lines: e1/e2/e3 carry rawUsage (different
        // model precedence variants); e4/e5/e6 are non-rawUsage line types.
        let entries = parse_session_file(&fixture_path("edge_cases.jsonl"), None).unwrap();
        assert_eq!(entries.len(), 3, "only 3 lines have providerData.rawUsage");
        // Also: main_session_basic.jsonl line 2 is a function_call_result,
        // already implicitly covered by parses_basic_function_call's
        // expected count of 2 (out of 3 lines).
    }

    /// Three sub-cases: (a) only `model` → uses MaaS slug; (b) only
    /// `requestModelId` → uses friendly id; (c) neither → "unknown".
    /// The `[codebuddy] ` prefix is asserted in every case.
    #[test]
    fn model_id_fallback_chain() {
        let entries = parse_session_file(&fixture_path("edge_cases.jsonl"), None).unwrap();
        // entries[0] from e1 (model only),
        // entries[1] from e2 (requestModelId only),
        // entries[2] from e3 (neither).
        assert_eq!(
            entries[0].model.as_deref(),
            Some("[codebuddy] MaaS_Cl_Opus_4.7_20260416_cache"),
            "case (a): model wins when present"
        );
        assert_eq!(
            entries[1].model.as_deref(),
            Some("[codebuddy] claude-opus-4.7-1m"),
            "case (b): requestModelId is the fallback"
        );
        assert_eq!(
            entries[2].model.as_deref(),
            Some("[codebuddy] unknown"),
            "case (c): unknown still gets the [codebuddy] prefix"
        );
    }

    /// Top-level `timestamp` is consumed directly; no file-mtime
    /// fallback needed.
    #[test]
    fn timestamp_from_top_level() {
        let entries = parse_session_file(&fixture_path("main_session_basic.jsonl"), None).unwrap();
        // Line 1's top-level timestamp is 1779947694866.
        assert_eq!(
            entries[0].timestamp,
            TimestampMs::from_millis(1779947694866)
        );
    }

    /// When a line's top-level `sessionId` differs from the filename
    /// stem (e.g. a subagent file `agent-XYZ.jsonl` whose line carries
    /// the subagent's own session UUID), the line-level value wins.
    #[test]
    fn session_id_prefers_line_level_field_over_filename() {
        // Filename stem "agent-XYZ" vs sessionId "sess-from-line".
        let line = serde_json::json!({
            "id": "x",
            "type": "function_call",
            "timestamp": 1779947694866_i64,
            "sessionId": "sess-from-line",
            "providerData": {
                "model": "MaaS_test",
                "rawUsage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0
                }
            }
        });
        let fixture = ccusage_test_support::fs_fixture!({
            "agent-XYZ.jsonl": format!("{line}\n"),
        });

        let entries = parse_session_file(&fixture.path("agent-XYZ.jsonl"), None).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "sess-from-line");
    }

    /// When a line lacks `sessionId`, fall back to the filename stem
    /// (drop the `.jsonl` suffix).
    #[test]
    fn session_id_falls_back_to_filename_when_absent() {
        let line = serde_json::json!({
            "id": "x",
            "type": "function_call",
            "timestamp": 1779947694866_i64,
            "providerData": {
                "model": "MaaS_test",
                "rawUsage": {
                    "prompt_tokens": 1,
                    "completion_tokens": 1,
                    "total_tokens": 2,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0
                }
            }
        });
        let fixture = ccusage_test_support::fs_fixture!({
            "0e40c7ab-c35c-4be2-9bd1-949d1ee38ec7.jsonl":
                format!("{line}\n"),
        });

        let entries = parse_session_file(
            &fixture.path("0e40c7ab-c35c-4be2-9bd1-949d1ee38ec7.jsonl"),
            None,
        )
        .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].session_id.as_ref(),
            "0e40c7ab-c35c-4be2-9bd1-949d1ee38ec7"
        );
    }

    /// Neither the nested `prompt_tokens_details.cached_tokens` nor a
    /// top-level `rawUsage.cached_tokens` (both observed in real
    /// CodeBuddy data) should contribute to any reported token count.
    /// Only the named top-level fields are read.
    #[test]
    fn non_zero_cached_tokens_field_is_ignored() {
        // Both shapes in one line. The parser must NOT count 12345 or
        // 67890 anywhere.
        let line = serde_json::json!({
            "id": "x",
            "type": "function_call",
            "timestamp": 1779947694866_i64,
            "sessionId": "sess",
            "providerData": {
                "model": "MaaS_test",
                "rawUsage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 10,
                    "total_tokens": 110,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cached_tokens": 67890,
                    "prompt_tokens_details": {
                        "cached_tokens": 12345
                    }
                }
            }
        });
        let fixture = ccusage_test_support::fs_fixture!({
            "00000000.jsonl": format!("{line}\n"),
        });

        let entries = parse_session_file(&fixture.path("00000000.jsonl"), None).unwrap();
        assert_eq!(entries.len(), 1);
        let usage = entries[0].data.message.usage;
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 10);
        assert_eq!(usage.cache_creation_input_tokens, 0);
        assert_eq!(usage.cache_read_input_tokens, 0);
        // No path through which 12345 or 67890 should appear.
        assert_ne!(usage.input_tokens, 12345);
        assert_ne!(usage.input_tokens, 67890);
        assert_eq!(entries[0].extra_total_tokens, 0);
    }

    /// Lines carrying `credit:NN.NN` produce cost == 0.0 and
    /// missing_pricing_model == Some("codebuddy"). The credit field is
    /// NOT recorded in this PR.
    #[test]
    fn credit_field_does_not_contribute_to_cost() {
        // main_session_basic.jsonl line 1 carries credit: 47.19.
        let entries = parse_session_file(&fixture_path("main_session_basic.jsonl"), None).unwrap();
        let first = &entries[0];
        assert_eq!(first.cost, 0.0);
        assert_eq!(first.missing_pricing_model.as_deref(), Some("codebuddy"));
        // credits field on LoadedEntry is None for this PR.
        assert_eq!(first.credits, None);
    }
}
