use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use jiff::tz::TimeZone as JiffTimeZone;
use serde_json::{Map, Value};

use crate::{
    calculate_cost_for_usage,
    cli::{AgentCommandArgs, AgentReportKind, CostMode, WeekDay},
    collect_files_with_extension, filter_loaded_entries_by_date, format_date_tz, parse_tz,
    print_usage_table, summarize_by_key, summarize_summaries_by_bucket, LoadedEntry, Result,
    TimestampMs, TokenUsageRaw, UsageEntry, UsageMessage,
};

pub(crate) const COPILOT_OTEL_FILE_EXPORTER_PATH_ENV: &str = "COPILOT_OTEL_FILE_EXPORTER_PATH";

#[derive(Debug, Clone)]
struct CopilotUsageEntry {
    timestamp: TimestampMs,
    timestamp_text: String,
    session_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_output_tokens: u64,
    dedup_key: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum CopilotUsageSource {
    ChatSpan,
    InferenceLog,
    AgentTurnLog,
    AgentSummarySpan,
}

#[derive(Default)]
struct TraceContext {
    model: Option<String>,
    session_id: Option<String>,
    session_id_priority: u8,
}

struct CopilotUsageCandidate {
    source: CopilotUsageSource,
    trace_id: Option<String>,
    response_id: Option<String>,
    model: String,
    session_id: String,
    timestamp: TimestampMs,
    input_tokens: u64,
    output_tokens: u64,
    cache_creation_tokens: u64,
    cache_read_tokens: u64,
    reasoning_output_tokens: u64,
    dedup_key: String,
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = crate::PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    crate::sort_summaries(&mut rows, &shared.order, |row| {
        crate::adapter::opencode::summary_period(row)
    });
    if crate::wants_json(&shared) {
        return crate::print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    print_usage_table(
        "GitHub Copilot CLI Token Usage Report",
        crate::adapter::opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    );
    Ok(())
}

pub(crate) fn report_from_rows(rows: &[crate::UsageSummary], kind: AgentReportKind) -> Value {
    let rows_json = rows
        .iter()
        .map(|row| crate::adapter::opencode::agent_summary_json(row, kind, false))
        .collect::<Vec<_>>();
    serde_json::json!({
        rows_key(kind): rows_json,
        "totals": crate::totals_json(rows),
    })
}

pub(crate) fn summarize_entries(
    entries: &[LoadedEntry],
    kind: AgentReportKind,
) -> Result<Vec<crate::UsageSummary>> {
    match kind {
        AgentReportKind::Daily => summarize_by_key(
            entries,
            |entry| entry.date.clone(),
            |date| (date.to_string(), None),
        ),
        AgentReportKind::Monthly => {
            let daily = summarize_entries(entries, AgentReportKind::Daily)?;
            Ok(summarize_summaries_by_bucket(
                &daily,
                crate::BucketKind::Monthly,
                WeekDay::Sunday,
            ))
        }
        AgentReportKind::Session => summarize_by_key(
            entries,
            |entry| entry.session_id.to_string(),
            |session_id| (session_id.to_string(), None),
        )
        .map(|mut rows| {
            for row in &mut rows {
                row.session_id = row.date.take();
            }
            rows
        }),
        AgentReportKind::Weekly => Ok(Vec::new()),
    }
}

pub(crate) fn load_entries(
    shared: &crate::cli::SharedArgs,
    pricing: &crate::PricingMap,
) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(
        crate::progress::UsageLoadAgent::Copilot,
        shared.json,
        || load_entries_inner(shared, pricing),
    )
}

fn load_entries_inner(
    shared: &crate::cli::SharedArgs,
    pricing: &crate::PricingMap,
) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    for path in paths()? {
        entries.extend(read_otel_file(&path, tz.as_ref(), shared.mode, pricing)?);
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn rows_key(kind: AgentReportKind) -> &'static str {
    match kind {
        AgentReportKind::Daily => "daily",
        AgentReportKind::Weekly => "weekly",
        AgentReportKind::Monthly => "monthly",
        AgentReportKind::Session => "sessions",
    }
}

fn paths() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    if let Some(home) = crate::home::home_dir() {
        let default_dir = home.join(".copilot").join("otel");
        if default_dir.is_dir() {
            collect_files_with_extension(&default_dir, "jsonl", &mut files);
        }
    }
    if let Some(path) = copilot_exporter_path() {
        files.push(path);
    }
    files.retain(|path| seen.insert(path.clone()));
    files.sort();
    Ok(files)
}

fn copilot_exporter_path() -> Option<PathBuf> {
    let path = env::var(COPILOT_OTEL_FILE_EXPORTER_PATH_ENV).ok()?;
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let path = PathBuf::from(path);
    path.is_file().then_some(path)
}

fn read_otel_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &crate::PricingMap,
) -> Result<Vec<LoadedEntry>> {
    Ok(parse_otel_file(path)?
        .into_iter()
        .map(|entry| usage_entry_to_loaded(entry, tz, mode, pricing))
        .collect())
}

fn usage_entry_to_loaded(
    entry: CopilotUsageEntry,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: &crate::PricingMap,
) -> LoadedEntry {
    let usage = TokenUsageRaw {
        input_tokens: entry.input_tokens,
        output_tokens: entry.output_tokens,
        cache_creation_input_tokens: entry.cache_creation_tokens,
        cache_read_input_tokens: entry.cache_read_tokens,
        speed: None,
    };
    let cost_usage = TokenUsageRaw {
        output_tokens: entry.output_tokens + entry.reasoning_output_tokens,
        ..usage
    };
    let data = UsageEntry {
        session_id: Some(entry.session_id.clone()),
        timestamp: entry.timestamp_text,
        version: None,
        message: UsageMessage {
            usage,
            model: Some(entry.model.clone()),
            id: Some(entry.dedup_key),
        },
        cost_usd: None,
        request_id: None,
        is_api_error_message: None,
    };
    let cost = calculate_cost_for_usage(Some(&entry.model), cost_usage, None, mode, Some(pricing));
    LoadedEntry {
        date: format_date_tz(entry.timestamp, tz),
        timestamp: entry.timestamp,
        project: Arc::from("copilot"),
        session_id: Arc::from(entry.session_id),
        project_path: Arc::from("GitHub Copilot CLI"),
        cost,
        extra_total_tokens: entry.reasoning_output_tokens,
        credits: None,
        model: Some(entry.model),
        data,
        usage_limit_reset_time: None,
    }
}

fn parse_otel_file(path: &Path) -> Result<Vec<CopilotUsageEntry>> {
    let content = fs::read_to_string(path)?;
    let records = content
        .lines()
        .filter(|line| line.contains("\"attributes\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| value.as_object().cloned())
        .collect::<Vec<_>>();
    let trace_contexts = collect_trace_contexts(&records);
    let fallback_timestamp = file_modified_timestamp(path);
    let candidates = records
        .iter()
        .enumerate()
        .filter_map(|(index, record)| {
            to_candidate(record, index, fallback_timestamp, &trace_contexts)
        })
        .collect::<Vec<_>>();
    let sets = CandidateSets::new(&candidates);
    Ok(candidates
        .into_iter()
        .filter(|candidate| should_emit_candidate(candidate, &sets))
        .map(|candidate| CopilotUsageEntry {
            timestamp: candidate.timestamp,
            timestamp_text: crate::format_rfc3339_millis(candidate.timestamp),
            session_id: candidate.session_id,
            model: candidate.model,
            input_tokens: candidate.input_tokens,
            output_tokens: candidate.output_tokens,
            cache_creation_tokens: candidate.cache_creation_tokens,
            cache_read_tokens: candidate.cache_read_tokens,
            reasoning_output_tokens: candidate.reasoning_output_tokens,
            dedup_key: candidate.dedup_key,
        })
        .collect())
}

fn collect_trace_contexts(records: &[Map<String, Value>]) -> HashMap<String, TraceContext> {
    let mut contexts = HashMap::new();
    for record in records {
        let Some(trace_id) = trace_id_from_record(record) else {
            continue;
        };
        let Some(attributes) = record.get("attributes").and_then(Value::as_object) else {
            continue;
        };
        let context = contexts
            .entry(trace_id)
            .or_insert_with(TraceContext::default);
        if context.model.is_none() {
            context.model = first_non_empty_attr(attributes, MODEL_ATTRS);
        }
        if let Some((session_id, priority)) = best_session_attr(attributes) {
            if priority > context.session_id_priority {
                context.session_id = Some(session_id);
                context.session_id_priority = priority;
            }
        }
    }
    contexts
}

fn to_candidate(
    record: &Map<String, Value>,
    index: usize,
    fallback_timestamp: TimestampMs,
    trace_contexts: &HashMap<String, TraceContext>,
) -> Option<CopilotUsageCandidate> {
    let attributes = record.get("attributes")?.as_object()?;
    let source = if is_chat_span_record(record, attributes) {
        CopilotUsageSource::ChatSpan
    } else if is_inference_log_record(record, attributes) {
        CopilotUsageSource::InferenceLog
    } else if is_agent_turn_log_record(record, attributes) {
        CopilotUsageSource::AgentTurnLog
    } else if is_agent_summary_span_record(record, attributes) {
        CopilotUsageSource::AgentSummarySpan
    } else {
        return None;
    };
    let input = attr_number(attributes, "gen_ai.usage.input_tokens");
    let output = attr_number(attributes, "gen_ai.usage.output_tokens");
    let cache_read = attr_number(attributes, "gen_ai.usage.cache_read.input_tokens");
    let cache_creation = attr_number_first(
        attributes,
        &[
            "gen_ai.usage.cache_write.input_tokens",
            "gen_ai.usage.cache_creation.input_tokens",
        ],
    );
    let reasoning = attr_number_first(
        attributes,
        &[
            "gen_ai.usage.reasoning.output_tokens",
            "gen_ai.usage.reasoning_tokens",
        ],
    );
    if input + output + cache_read + cache_creation + reasoning == 0 {
        return None;
    }
    let trace_id = trace_id_from_record(record);
    let trace_context = trace_id.as_ref().and_then(|id| trace_contexts.get(id));
    let response_id = attr_string(attributes, "gen_ai.response.id");
    let model = first_non_empty_attr(attributes, MODEL_ATTRS)
        .or_else(|| trace_context.and_then(|context| context.model.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    let session_id = best_session_attr(attributes)
        .map(|(session_id, _)| session_id)
        .or_else(|| trace_context.and_then(|context| context.session_id.clone()))
        .or_else(|| trace_id.clone())
        .unwrap_or_else(|| "unknown-session".to_string());
    let timestamp = timestamp_from_record(record).unwrap_or(fallback_timestamp);
    let input_tokens = input.saturating_sub(input.min(cache_read));
    let dedup_key = dedup_key_for_record(
        source,
        record,
        attributes,
        &trace_id,
        &session_id,
        timestamp,
        index,
    );
    Some(CopilotUsageCandidate {
        source,
        trace_id,
        response_id,
        model,
        session_id,
        timestamp,
        input_tokens,
        output_tokens: output,
        cache_creation_tokens: cache_creation,
        cache_read_tokens: cache_read,
        reasoning_output_tokens: reasoning,
        dedup_key,
    })
}

struct CandidateSets {
    chat_traces: HashSet<String>,
    inference_traces: HashSet<String>,
    agent_turn_traces: HashSet<String>,
    chat_response_ids: HashSet<String>,
    inference_response_ids: HashSet<String>,
    agent_turn_response_ids: HashSet<String>,
}

impl CandidateSets {
    fn new(candidates: &[CopilotUsageCandidate]) -> Self {
        Self {
            chat_traces: source_trace_ids(candidates, CopilotUsageSource::ChatSpan),
            inference_traces: source_trace_ids(candidates, CopilotUsageSource::InferenceLog),
            agent_turn_traces: source_trace_ids(candidates, CopilotUsageSource::AgentTurnLog),
            chat_response_ids: source_response_ids(candidates, CopilotUsageSource::ChatSpan),
            inference_response_ids: source_response_ids(
                candidates,
                CopilotUsageSource::InferenceLog,
            ),
            agent_turn_response_ids: source_response_ids(
                candidates,
                CopilotUsageSource::AgentTurnLog,
            ),
        }
    }
}

fn source_trace_ids(
    candidates: &[CopilotUsageCandidate],
    source: CopilotUsageSource,
) -> HashSet<String> {
    candidates
        .iter()
        .filter(|candidate| candidate.source == source)
        .filter_map(|candidate| candidate.trace_id.clone())
        .collect()
}

fn source_response_ids(
    candidates: &[CopilotUsageCandidate],
    source: CopilotUsageSource,
) -> HashSet<String> {
    candidates
        .iter()
        .filter(|candidate| candidate.source == source)
        .filter_map(|candidate| candidate.response_id.clone())
        .collect()
}

fn should_emit_candidate(candidate: &CopilotUsageCandidate, sets: &CandidateSets) -> bool {
    let trace_match = |values: &HashSet<String>| {
        candidate
            .trace_id
            .as_ref()
            .is_some_and(|trace_id| values.contains(trace_id))
    };
    let response_match = |values: &HashSet<String>| {
        candidate
            .response_id
            .as_ref()
            .is_some_and(|response_id| values.contains(response_id))
    };
    match candidate.source {
        CopilotUsageSource::ChatSpan => true,
        CopilotUsageSource::InferenceLog => {
            !trace_match(&sets.chat_traces) && !response_match(&sets.chat_response_ids)
        }
        CopilotUsageSource::AgentTurnLog => {
            !trace_match(&sets.chat_traces)
                && !trace_match(&sets.inference_traces)
                && !response_match(&sets.chat_response_ids)
                && !response_match(&sets.inference_response_ids)
        }
        CopilotUsageSource::AgentSummarySpan => {
            !trace_match(&sets.chat_traces)
                && !trace_match(&sets.inference_traces)
                && !trace_match(&sets.agent_turn_traces)
                && !response_match(&sets.chat_response_ids)
                && !response_match(&sets.inference_response_ids)
                && !response_match(&sets.agent_turn_response_ids)
        }
    }
}

const MODEL_ATTRS: &[&str] = &["gen_ai.response.model", "gen_ai.request.model"];
const SESSION_ATTRS: &[(&str, u8)] = &[
    ("gen_ai.conversation.id", 3),
    ("copilot_chat.session_id", 3),
    ("copilot_chat.chat_session_id", 3),
    ("session.id", 3),
    ("github.copilot.interaction_id", 2),
    ("gen_ai.response.id", 1),
];

fn is_span_record(record: &Map<String, Value>) -> bool {
    if let Some(record_type) = record.get("type").and_then(Value::as_str) {
        return record_type == "span";
    }
    string_value(record.get("name")).is_some()
        && (string_value(record.get("spanId")).is_some()
            || string_value(record.get("traceId")).is_some()
            || record.get("startTime").is_some()
            || record.get("endTime").is_some()
            || record.get("duration").is_some()
            || record.get("kind").is_some())
}

fn is_chat_span_record(record: &Map<String, Value>, attributes: &Map<String, Value>) -> bool {
    is_span_record(record)
        && (attr_string(attributes, "gen_ai.operation.name").as_deref() == Some("chat")
            || string_value(record.get("name")).is_some_and(|name| name.starts_with("chat ")))
}

fn is_agent_summary_span_record(
    record: &Map<String, Value>,
    attributes: &Map<String, Value>,
) -> bool {
    is_span_record(record)
        && (attr_string(attributes, "gen_ai.operation.name").as_deref() == Some("invoke_agent")
            || string_value(record.get("name"))
                .is_some_and(|name| name.starts_with("invoke_agent ")))
}

fn is_inference_log_record(record: &Map<String, Value>, attributes: &Map<String, Value>) -> bool {
    !is_span_record(record)
        && (attr_string(attributes, "event.name").as_deref()
            == Some("gen_ai.client.inference.operation.details")
            || record_body(record).is_some_and(|body| body.starts_with("GenAI inference:")))
}

fn is_agent_turn_log_record(record: &Map<String, Value>, attributes: &Map<String, Value>) -> bool {
    !is_span_record(record)
        && (attr_string(attributes, "event.name").as_deref() == Some("copilot_chat.agent.turn")
            || record_body(record).is_some_and(|body| body.starts_with("copilot_chat.agent.turn")))
}

fn dedup_key_for_record(
    source: CopilotUsageSource,
    record: &Map<String, Value>,
    attributes: &Map<String, Value>,
    trace_id: &Option<String>,
    session_id: &str,
    timestamp: TimestampMs,
    index: usize,
) -> String {
    let span_id = span_id_from_record(record);
    match source {
        CopilotUsageSource::ChatSpan | CopilotUsageSource::AgentSummarySpan => {
            if let (Some(trace_id), Some(span_id)) = (trace_id, span_id) {
                return format!("{trace_id}:{span_id}");
            }
            format!("span:{session_id}:{}:{index}", timestamp.as_millis())
        }
        CopilotUsageSource::InferenceLog => {
            if let (Some(trace_id), Some(span_id)) = (trace_id, span_id) {
                return format!("log:{trace_id}:{span_id}");
            }
            format!("log:{session_id}:{}:{index}", timestamp.as_millis())
        }
        CopilotUsageSource::AgentTurnLog => {
            let turn_index = number_value(attributes.get("turn.index"))
                .or_else(|| number_value(attributes.get("copilot_chat.turn.index")))
                .map_or_else(|| format!("idx-{index}"), |value| value.to_string());
            trace_id.as_ref().map_or_else(
                || format!("agent-turn:{session_id}:{turn_index}:{index}"),
                |trace_id| format!("agent-turn:{trace_id}:{turn_index}"),
            )
        }
    }
}

fn trace_id_from_record(record: &Map<String, Value>) -> Option<String> {
    string_value(record.get("traceId"))
        .map(str::to_string)
        .or_else(|| nested_string(record, "spanContext", "traceId"))
}

fn span_id_from_record(record: &Map<String, Value>) -> Option<String> {
    string_value(record.get("spanId"))
        .map(str::to_string)
        .or_else(|| nested_string(record, "spanContext", "spanId"))
}

fn nested_string(record: &Map<String, Value>, object: &str, key: &str) -> Option<String> {
    record
        .get(object)
        .and_then(Value::as_object)
        .and_then(|object| string_value(object.get(key)))
        .map(str::to_string)
}

fn record_body(record: &Map<String, Value>) -> Option<&str> {
    string_value(record.get("body")).or_else(|| string_value(record.get("_body")))
}

fn string_value(value: Option<&Value>) -> Option<&str> {
    let value = value?.as_str()?.trim();
    (!value.is_empty()).then_some(value)
}

fn number_value(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64().or_else(|| {
            number
                .as_i64()
                .and_then(|value| (value >= 0).then_some(value as u64))
        }),
        Value::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn attr_string(attributes: &Map<String, Value>, key: &str) -> Option<String> {
    string_value(attributes.get(key)).map(str::to_string)
}

fn attr_number(attributes: &Map<String, Value>, key: &str) -> u64 {
    number_value(attributes.get(key)).unwrap_or_default()
}

fn attr_number_first(attributes: &Map<String, Value>, keys: &[&str]) -> u64 {
    keys.iter()
        .map(|key| attr_number(attributes, key))
        .find(|value| *value > 0)
        .unwrap_or_default()
}

fn first_non_empty_attr(attributes: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| attr_string(attributes, key))
}

fn best_session_attr(attributes: &Map<String, Value>) -> Option<(String, u8)> {
    SESSION_ATTRS
        .iter()
        .filter_map(|(key, priority)| attr_string(attributes, key).map(|value| (value, *priority)))
        .max_by_key(|(_, priority)| *priority)
}

fn timestamp_from_record(record: &Map<String, Value>) -> Option<TimestampMs> {
    timestamp_from_parts(record.get("endTime"))
        .or_else(|| timestamp_from_parts(record.get("startTime")))
        .or_else(|| timestamp_from_parts(record.get("hrTime")))
        .or_else(|| timestamp_from_parts(record.get("_hrTime")))
        .or_else(|| timestamp_from_parts(record.get("time")))
        .or_else(|| timestamp_from_scalar(record.get("timestamp")))
        .or_else(|| timestamp_from_scalar(record.get("observedTimestamp")))
        .or_else(|| timestamp_from_unix_nanos(record.get("timeUnixNano")))
}

fn timestamp_from_parts(value: Option<&Value>) -> Option<TimestampMs> {
    let values = value?.as_array()?;
    let seconds = number_value(values.first())?;
    let nanos = number_value(values.get(1))?;
    let millis = seconds.checked_mul(1_000)?.checked_add(nanos / 1_000_000)?;
    Some(TimestampMs::from_millis(millis.min(i64::MAX as u64) as i64))
}

fn timestamp_from_scalar(value: Option<&Value>) -> Option<TimestampMs> {
    let raw = number_value(value)?;
    let millis = if raw >= 100_000_000_000_000_000 {
        raw / 1_000_000
    } else if raw >= 100_000_000_000_000 {
        raw / 1_000
    } else if raw >= 100_000_000_000 {
        raw
    } else {
        raw * 1_000
    };
    Some(TimestampMs::from_millis(millis.min(i64::MAX as u64) as i64))
}

fn timestamp_from_unix_nanos(value: Option<&Value>) -> Option<TimestampMs> {
    let raw = number_value(value)?;
    (raw > 0).then(|| TimestampMs::from_millis((raw / 1_000_000).min(i64::MAX as u64) as i64))
}

fn file_modified_timestamp(path: &Path) -> TimestampMs {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| TimestampMs::from_millis(duration.as_millis().min(i64::MAX as u128) as i64))
        .unwrap_or_else(crate::utc_now)
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ccusage-copilot-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_copilot_chat_spans() {
        let dir = temp_dir("chat-span");
        let file = dir.join("copilot.jsonl");
        fs::write(
            &file,
            [
                json!({ "type": "metric", "name": "gen_ai.client.token.usage" }).to_string(),
                json!({
                    "type": "span",
                    "traceId": "trace-1",
                    "spanId": "span-1",
                    "name": "chat claude-sonnet-4",
                    "endTime": [1_775_934_264_u64, 967_317_833_u64],
                    "attributes": {
                        "gen_ai.operation.name": "chat",
                        "gen_ai.request.model": "claude-sonnet-4",
                        "gen_ai.response.model": "claude-sonnet-4",
                        "gen_ai.conversation.id": "conv-1",
                        "gen_ai.usage.input_tokens": 19_452,
                        "gen_ai.usage.output_tokens": 281,
                        "gen_ai.usage.cache_read.input_tokens": 123,
                        "gen_ai.usage.cache_creation.input_tokens": 25,
                        "gen_ai.usage.reasoning.output_tokens": 128,
                    },
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let entries = parse_otel_file(&file).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].timestamp_text, "2026-04-11T19:04:24.967Z");
        assert_eq!(entries[0].session_id, "conv-1");
        assert_eq!(entries[0].model, "claude-sonnet-4");
        assert_eq!(entries[0].input_tokens, 19_329);
        assert_eq!(entries[0].output_tokens, 281);
        assert_eq!(entries[0].cache_creation_tokens, 25);
        assert_eq!(entries[0].cache_read_tokens, 123);
        assert_eq!(entries[0].reasoning_output_tokens, 128);
        assert_eq!(entries[0].dedup_key, "trace-1:span-1");

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn suppresses_lower_priority_records_for_same_response() {
        let dir = temp_dir("dedup");
        let file = dir.join("copilot.jsonl");
        fs::write(
            &file,
            [
                json!({
                    "type": "span",
                    "traceId": "trace-dupe",
                    "spanId": "agent-1",
                    "name": "invoke_agent GitHub Copilot Chat",
                    "attributes": {
                        "gen_ai.operation.name": "invoke_agent",
                        "gen_ai.response.model": "gpt-5.4-mini",
                        "gen_ai.conversation.id": "conv-dupe",
                        "gen_ai.response.id": "resp-dupe",
                        "gen_ai.usage.input_tokens": 100,
                        "gen_ai.usage.output_tokens": 30,
                    },
                })
                .to_string(),
                json!({
                    "hrTime": [1_775_934_263_u64, 0_u64],
                    "attributes": {
                        "event.name": "gen_ai.client.inference.operation.details",
                        "gen_ai.response.model": "gpt-5.4-mini",
                        "gen_ai.response.id": "resp-dupe",
                        "gen_ai.usage.input_tokens": 80,
                        "gen_ai.usage.output_tokens": 20,
                    },
                    "_body": "GenAI inference: gpt-5.4-mini",
                })
                .to_string(),
                json!({
                    "type": "span",
                    "traceId": "trace-dupe",
                    "spanId": "chat-1",
                    "name": "chat gpt-5.4-mini",
                    "attributes": {
                        "gen_ai.operation.name": "chat",
                        "gen_ai.response.model": "gpt-5.4-mini",
                        "gen_ai.conversation.id": "conv-dupe",
                        "gen_ai.response.id": "resp-dupe",
                        "gen_ai.usage.input_tokens": 60,
                        "gen_ai.usage.output_tokens": 10,
                    },
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let entries = parse_otel_file(&file).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].dedup_key, "trace-dupe:chat-1");
        assert_eq!(entries[0].input_tokens, 60);
        assert_eq!(entries[0].output_tokens, 10);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn includes_reasoning_tokens_in_total_tokens() {
        let dir = temp_dir("summary");
        let file = dir.join("copilot.jsonl");
        fs::write(
            &file,
            format!(
                "{}\n",
                json!({
                    "type": "span",
                    "traceId": "trace-1",
                    "spanId": "span-1",
                    "name": "chat test-model",
                    "endTime": [1_775_934_264_u64, 0_u64],
                    "attributes": {
                        "gen_ai.operation.name": "chat",
                        "gen_ai.response.model": "test-model",
                        "gen_ai.conversation.id": "conv-1",
                        "gen_ai.usage.input_tokens": 100,
                        "gen_ai.usage.output_tokens": 50,
                        "gen_ai.usage.cache_read.input_tokens": 10,
                        "gen_ai.usage.cache_creation.input_tokens": 20,
                        "gen_ai.usage.reasoning.output_tokens": 5,
                    },
                })
            ),
        )
        .unwrap();
        let mut pricing = crate::PricingMap::default();
        pricing.load_json(
            r#"{"test-model":{"input_cost_per_token":1,"output_cost_per_token":2,"cache_creation_input_token_cost":3,"cache_read_input_token_cost":4}}"#,
        );

        let loaded = read_otel_file(&file, None, CostMode::Auto, &pricing).unwrap();
        let rows = summarize_entries(&loaded, AgentReportKind::Daily).unwrap();
        let report = report_from_rows(&rows, AgentReportKind::Daily);

        assert_eq!(report["daily"][0]["inputTokens"], 90);
        assert_eq!(report["daily"][0]["outputTokens"], 50);
        assert_eq!(report["daily"][0]["totalTokens"], 175);
        assert_eq!(report["daily"][0]["totalCost"], 300.0);

        fs::remove_dir_all(dir).unwrap();
    }
}
