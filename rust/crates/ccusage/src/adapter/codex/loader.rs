use std::{
    borrow::Cow,
    env, fs,
    io::{BufRead, BufReader},
    marker::PhantomData,
    path::{Path, PathBuf},
    sync::LazyLock,
    thread,
};

use compact_str::CompactString;
use memchr::memmem::Finder;
use serde::Deserialize;
use serde_json::Value;

use crate::{
    chunk_file_indexes_by_size, cli::SharedArgs, cli_error, collect_usage_files, fast::FxHashSet,
    home, progress, CodexRawUsage, CodexTokenUsageEvent, Result, TimestampMs,
};

static EVENT_MSG_TYPE_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""type":"event_msg""#));
static TURN_CONTEXT_TYPE_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""type":"turn_context""#));
static TOKEN_COUNT_TYPE_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""type":"token_count""#));
static COMPACT_TYPE_FIELD_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""type":"#));
static TYPE_KEY_FINDER: LazyLock<Finder<'static>> = LazyLock::new(|| Finder::new(br#""type""#));
static USAGE_FIELD_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""usage":"#));
static INPUT_TOKENS_FIELD_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""input_tokens":"#));
static PROMPT_TOKENS_FIELD_FINDER: LazyLock<Finder<'static>> =
    LazyLock::new(|| Finder::new(br#""prompt_tokens":"#));

#[derive(Clone, Copy)]
enum CodexLineKind {
    Session,
    Headless,
}

pub(crate) fn load_codex_events_from_directory(
    sessions_dir: &Path,
    single_thread: bool,
) -> Result<Vec<CodexTokenUsageEvent>> {
    let mut files = Vec::new();
    collect_usage_files(sessions_dir, &mut files);
    let mut events = if single_thread {
        files
            .iter()
            .flat_map(|file| read_codex_session_file(sessions_dir, file))
            .collect::<Vec<_>>()
    } else {
        read_codex_session_files_parallel(sessions_dir, &files)
    };
    dedupe_codex_events(&mut events);
    Ok(events)
}

pub(crate) fn load_codex_events(shared: &SharedArgs) -> Result<Vec<CodexTokenUsageEvent>> {
    progress::track_usage_load(progress::UsageLoadAgent::Codex, shared.json, || {
        load_codex_events_inner(shared)
    })
}

fn load_codex_events_inner(shared: &SharedArgs) -> Result<Vec<CodexTokenUsageEvent>> {
    let mut events = Vec::new();
    for path in codex_usage_paths()? {
        events.extend(load_codex_events_from_directory(
            &path,
            shared.single_thread,
        )?);
    }
    dedupe_codex_events(&mut events);
    Ok(events)
}

fn read_codex_session_files_parallel(
    sessions_dir: &Path,
    files: &[PathBuf],
) -> Vec<CodexTokenUsageEvent> {
    let worker_count = thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(files.len());
    if worker_count <= 1 {
        return files
            .iter()
            .flat_map(|file| read_codex_session_file(sessions_dir, file))
            .collect();
    }

    let chunks = chunk_file_indexes_by_size(files, worker_count);
    thread::scope(|scope| {
        let mut handles = Vec::with_capacity(chunks.len());
        for chunk in chunks {
            handles.push(scope.spawn(move || {
                chunk
                    .into_iter()
                    .map(|index| (index, read_codex_session_file(sessions_dir, &files[index])))
                    .collect::<Vec<_>>()
            }));
        }

        let mut loaded_files = Vec::with_capacity(files.len());
        loaded_files.resize_with(files.len(), || None);
        for (index, events) in handles
            .into_iter()
            .flat_map(|handle| handle.join().expect("codex worker panicked"))
        {
            loaded_files[index] = Some(events);
        }
        loaded_files
            .into_iter()
            .flatten()
            .flatten()
            .collect::<Vec<_>>()
    })
}

pub(crate) fn codex_usage_paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = FxHashSet::default();
    for path in codex_home_paths()? {
        let sessions = path.join("sessions");
        if sessions.is_dir() {
            if seen.insert(sessions.clone()) {
                paths.push(sessions);
            }
        } else if seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn codex_home_paths() -> Result<Vec<PathBuf>> {
    if let Ok(env_paths) = env::var("CODEX_HOME") {
        return Ok(env_paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect());
    }

    let home = home::home_dir().ok_or_else(|| cli_error("home directory is not set"))?;
    Ok(vec![home.join(".codex")])
}

fn read_codex_session_file(sessions_dir: &Path, path: &Path) -> Vec<CodexTokenUsageEvent> {
    let mut events = Vec::new();
    let _ = visit_codex_session_file(sessions_dir, path, |event| {
        events.push(event);
        Ok(())
    });
    events
}

pub(crate) fn visit_codex_session_file(
    sessions_dir: &Path,
    path: &Path,
    mut visit: impl FnMut(CodexTokenUsageEvent) -> Result<()>,
) -> Result<()> {
    let Ok(file) = fs::File::open(path) else {
        return Ok(());
    };
    let mut reader = BufReader::with_capacity(128 * 1024, file);
    let mut line = Vec::new();
    let session_id = codex_session_id(sessions_dir, path);
    let mut previous_totals: Option<CodexRawUsage> = None;
    let mut current_model: Option<String> = None;
    let mut current_model_is_fallback = false;
    let fallback_timestamp = file_modified_timestamp(path);

    loop {
        line.clear();
        let Ok(bytes_read) = reader.read_until(b'\n', &mut line) else {
            return Ok(());
        };
        if bytes_read == 0 {
            break;
        }
        let Some(line_kind) = codex_line_usage_kind(&line) else {
            continue;
        };
        match line_kind {
            CodexLineKind::Session => {
                let Ok(value) = serde_json::from_slice::<CodexSessionLogEntry<'_>>(&line) else {
                    continue;
                };
                visit_codex_session_entry(
                    &session_id,
                    value,
                    &mut previous_totals,
                    &mut current_model,
                    &mut current_model_is_fallback,
                    &mut visit,
                )?;
            }
            CodexLineKind::Headless => {
                if let Ok(value) = serde_json::from_slice::<CodexLogEntry<'_>>(&line) {
                    add_codex_exec_event(
                        &session_id,
                        &value,
                        &fallback_timestamp,
                        &mut current_model,
                        &mut current_model_is_fallback,
                        &mut visit,
                    )?;
                } else {
                    add_codex_exec_event_from_value(
                        &session_id,
                        &line,
                        &fallback_timestamp,
                        &mut current_model,
                        &mut current_model_is_fallback,
                        &mut visit,
                    )?;
                };
            }
        }
    }

    Ok(())
}

fn visit_codex_session_entry(
    session_id: &str,
    value: CodexSessionLogEntry<'_>,
    previous_totals: &mut Option<CodexRawUsage>,
    current_model: &mut Option<String>,
    current_model_is_fallback: &mut bool,
    visit: &mut impl FnMut(CodexTokenUsageEvent) -> Result<()>,
) -> Result<()> {
    let entry_type = value.entry_type.as_deref();
    if entry_type == Some("turn_context") {
        if let Some(model) = value.payload.as_ref().and_then(codex_model_from_payload) {
            *current_model = Some(model);
            *current_model_is_fallback = false;
        }
        return Ok(());
    }
    if entry_type != Some("event_msg") {
        return Ok(());
    }
    let Some(timestamp) = codex_session_timestamp(value.timestamp.as_ref()) else {
        return Ok(());
    };
    let Some(payload) = value.payload.as_ref() else {
        return Ok(());
    };
    if payload.payload_type.as_deref() != Some("token_count") {
        return Ok(());
    }
    let info = payload.info.as_ref();
    let total_usage = info.and_then(|info| info.total_token_usage.as_ref().copied());
    let raw_usage = info
        .and_then(|info| info.last_token_usage.as_ref().copied())
        .or_else(|| {
            total_usage
                .as_ref()
                .map(|usage| subtract_codex_raw_usage(usage, previous_totals.as_ref()))
        });
    if let Some(total_usage) = total_usage {
        *previous_totals = Some(total_usage);
    }
    let Some(raw_usage) = raw_usage else {
        return Ok(());
    };
    if raw_usage.input_tokens == 0
        && raw_usage.cached_input_tokens == 0
        && raw_usage.output_tokens == 0
        && raw_usage.reasoning_output_tokens == 0
    {
        return Ok(());
    }

    let parsed_model =
        codex_model_from_payload(payload).or_else(|| info.and_then(codex_model_from_info));
    if let Some(model) = parsed_model.clone() {
        *current_model = Some(model);
        *current_model_is_fallback = false;
    }
    let mut is_fallback_model = false;
    let model = parsed_model.or_else(|| current_model.clone()).or_else(|| {
        is_fallback_model = true;
        *current_model_is_fallback = true;
        *current_model = Some("gpt-5".to_string());
        current_model.clone()
    });
    if parsed_model_is_missing(&model, current_model, *current_model_is_fallback) {
        is_fallback_model = true;
    }

    visit(CodexTokenUsageEvent {
        session_id: session_id.to_string(),
        timestamp,
        model,
        input_tokens: raw_usage.input_tokens,
        cached_input_tokens: raw_usage.cached_input_tokens.min(raw_usage.input_tokens),
        output_tokens: raw_usage.output_tokens,
        reasoning_output_tokens: raw_usage.reasoning_output_tokens,
        total_tokens: raw_usage.total_tokens,
        is_fallback_model,
    })
}

fn add_codex_exec_event(
    session_id: &str,
    value: &CodexLogEntry<'_>,
    fallback_timestamp: &str,
    current_model: &mut Option<String>,
    current_model_is_fallback: &mut bool,
    visit: &mut impl FnMut(CodexTokenUsageEvent) -> Result<()>,
) -> Result<()> {
    let Some(raw_usage) = normalize_headless_codex_usage(value) else {
        return Ok(());
    };
    let parsed_model = codex_model_from_result(value);
    let timestamp =
        codex_timestamp_from_result(value).unwrap_or_else(|| fallback_timestamp.to_string());
    visit_codex_exec_usage_event(
        session_id,
        raw_usage,
        parsed_model,
        timestamp,
        current_model,
        current_model_is_fallback,
        visit,
    )
}

fn add_codex_exec_event_from_value(
    session_id: &str,
    line: &[u8],
    fallback_timestamp: &str,
    current_model: &mut Option<String>,
    current_model_is_fallback: &mut bool,
    visit: &mut impl FnMut(CodexTokenUsageEvent) -> Result<()>,
) -> Result<()> {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return Ok(());
    };
    let Some(raw_usage) = normalize_headless_codex_usage_value(&value) else {
        return Ok(());
    };
    let parsed_model = codex_model_from_result_value(&value);
    let timestamp =
        codex_timestamp_from_result_value(&value).unwrap_or_else(|| fallback_timestamp.to_string());
    visit_codex_exec_usage_event(
        session_id,
        raw_usage,
        parsed_model,
        timestamp,
        current_model,
        current_model_is_fallback,
        visit,
    )
}

fn visit_codex_exec_usage_event(
    session_id: &str,
    raw_usage: CodexRawUsage,
    parsed_model: Option<String>,
    timestamp: String,
    current_model: &mut Option<String>,
    current_model_is_fallback: &mut bool,
    visit: &mut impl FnMut(CodexTokenUsageEvent) -> Result<()>,
) -> Result<()> {
    if let Some(model) = parsed_model.clone() {
        *current_model = Some(model);
        *current_model_is_fallback = false;
    }
    let mut is_fallback_model = false;
    let model = parsed_model.or_else(|| current_model.clone()).or_else(|| {
        is_fallback_model = true;
        *current_model_is_fallback = true;
        *current_model = Some("gpt-5".to_string());
        current_model.clone()
    });
    if parsed_model_is_missing(&model, current_model, *current_model_is_fallback) {
        is_fallback_model = true;
    }
    visit(CodexTokenUsageEvent {
        session_id: session_id.to_string(),
        timestamp,
        model,
        input_tokens: raw_usage.input_tokens,
        cached_input_tokens: raw_usage.cached_input_tokens.min(raw_usage.input_tokens),
        output_tokens: raw_usage.output_tokens,
        reasoning_output_tokens: raw_usage.reasoning_output_tokens,
        total_tokens: raw_usage.total_tokens,
        is_fallback_model,
    })
}

fn codex_line_usage_kind(line: &[u8]) -> Option<CodexLineKind> {
    let has_event_msg = EVENT_MSG_TYPE_FINDER.find(line).is_some();
    let has_token_count = has_event_msg && TOKEN_COUNT_TYPE_FINDER.find(line).is_some();
    if TURN_CONTEXT_TYPE_FINDER.find(line).is_some() || has_token_count {
        return Some(CodexLineKind::Session);
    }
    let has_compact_type = COMPACT_TYPE_FIELD_FINDER.find(line).is_some();
    let has_nested_token_count = !has_event_msg
        && has_compact_type
        && line.len() < 64 * 1024
        && TOKEN_COUNT_TYPE_FINDER.find(line).is_some();
    if has_event_msg || has_nested_token_count || !has_compact_type {
        let (has_turn_context, has_event_msg, has_token_count) = codex_line_type_flags(line);
        if has_turn_context || (has_event_msg && has_token_count) {
            return Some(CodexLineKind::Session);
        }
    }
    if USAGE_FIELD_FINDER.find(line).is_some()
        || INPUT_TOKENS_FIELD_FINDER.find(line).is_some()
        || PROMPT_TOKENS_FIELD_FINDER.find(line).is_some()
    {
        return Some(CodexLineKind::Headless);
    }
    None
}

fn codex_line_type_flags(line: &[u8]) -> (bool, bool, bool) {
    let mut start = 0;
    let mut has_turn_context = false;
    let mut has_event_msg = false;
    let mut has_token_count = false;
    while let Some(index) = TYPE_KEY_FINDER.find(&line[start..]) {
        let key_start = start + index;
        let mut cursor = skip_json_whitespace(line, key_start + br#""type""#.len());
        if line.get(cursor) != Some(&b':') {
            start = key_start + br#""type""#.len();
            continue;
        }
        cursor = skip_json_whitespace(line, cursor + 1);
        if line.get(cursor) != Some(&b'"') {
            start = cursor.saturating_add(1);
            continue;
        }
        cursor += 1;
        has_turn_context |= json_string_value_matches(line, cursor, b"turn_context");
        has_event_msg |= json_string_value_matches(line, cursor, b"event_msg");
        has_token_count |= json_string_value_matches(line, cursor, b"token_count");
        if has_turn_context || (has_event_msg && has_token_count) {
            return (has_turn_context, has_event_msg, has_token_count);
        }
        start = cursor.saturating_add(1);
    }
    (has_turn_context, has_event_msg, has_token_count)
}

fn json_string_value_matches(line: &[u8], start: usize, value: &[u8]) -> bool {
    line.get(start..start + value.len())
        .is_some_and(|candidate| candidate == value)
        && line.get(start + value.len()) == Some(&b'"')
}

fn skip_json_whitespace(line: &[u8], mut index: usize) -> usize {
    while matches!(line.get(index), Some(b' ' | b'\n' | b'\r' | b'\t')) {
        index += 1;
    }
    index
}

fn codex_session_timestamp(value: Option<&CodexTimestamp<'_>>) -> Option<String> {
    match value? {
        CodexTimestamp::String(text) => {
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        }
        CodexTimestamp::Number(_) => normalize_codex_timestamp(value),
    }
}

fn parsed_model_is_missing(
    model: &Option<String>,
    current_model: &Option<String>,
    current_model_is_fallback: bool,
) -> bool {
    model.is_some() && current_model.is_some() && current_model_is_fallback
}

fn codex_session_id(sessions_dir: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(sessions_dir).unwrap_or(path);
    let mut session_id = relative
        .with_extension("")
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/");
    if session_id.is_empty() {
        session_id = "unknown".to_string();
    }
    session_id
}

fn codex_model_from_payload(value: &CodexPayload<'_>) -> Option<String> {
    codex_model_from_parts(
        value.model.as_ref(),
        value.model_name.as_ref(),
        value.metadata.as_ref(),
    )
}

fn codex_model_from_info(value: &CodexInfo<'_>) -> Option<String> {
    codex_model_from_parts(
        value.model.as_ref(),
        value.model_name.as_ref(),
        value.metadata.as_ref(),
    )
}

fn codex_model_from_result(value: &CodexLogEntry<'_>) -> Option<String> {
    codex_model_from_entry(value)
        .or_else(|| value.data.as_ref().and_then(codex_model_from_result_fields))
        .or_else(|| {
            value
                .result
                .as_ref()
                .and_then(codex_model_from_result_fields)
        })
        .or_else(|| {
            value
                .response
                .as_ref()
                .and_then(codex_model_from_result_fields)
        })
}

fn codex_model_from_result_fields(value: &CodexResultFields<'_>) -> Option<String> {
    codex_model_from_parts(
        value.model.as_ref(),
        value.model_name.as_ref(),
        value.metadata.as_ref(),
    )
}

fn codex_model_from_entry(value: &CodexLogEntry<'_>) -> Option<String> {
    codex_model_from_parts(
        value.model.as_ref(),
        value.model_name.as_ref(),
        value.metadata.as_ref(),
    )
}

fn codex_model_from_parts(
    model: Option<&Cow<'_, str>>,
    model_name: Option<&Cow<'_, str>>,
    metadata: Option<&CodexModelMetadata<'_>>,
) -> Option<String> {
    non_empty_cow_string(model)
        .or_else(|| non_empty_cow_string(model_name))
        .or_else(|| metadata.and_then(|metadata| non_empty_cow_string(metadata.model.as_ref())))
}

fn codex_model_from_result_value(value: &Value) -> Option<String> {
    codex_model_from_value_fields(value)
        .or_else(|| value.get("data").and_then(codex_model_from_value_fields))
        .or_else(|| value.get("result").and_then(codex_model_from_value_fields))
        .or_else(|| {
            value
                .get("response")
                .and_then(codex_model_from_value_fields)
        })
}

fn codex_model_from_value_fields(value: &Value) -> Option<String> {
    non_empty_value_string(value.get("model"))
        .or_else(|| non_empty_value_string(value.get("model_name")))
        .or_else(|| {
            value
                .get("metadata")
                .and_then(|metadata| non_empty_value_string(metadata.get("model")))
        })
}

fn non_empty_cow_string(value: Option<&Cow<'_, str>>) -> Option<String> {
    value.and_then(|text| {
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_string())
    })
}

fn non_empty_value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).and_then(|text| {
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_string())
    })
}

fn usage_from_result(value: &CodexLogEntry<'_>) -> Option<CodexRawUsage> {
    value
        .usage
        .as_ref()
        .copied()
        .or_else(|| {
            value
                .data
                .as_ref()
                .and_then(|data| data.usage.as_ref().copied())
        })
        .or_else(|| {
            value
                .result
                .as_ref()
                .and_then(|result| result.usage.as_ref().copied())
        })
        .or_else(|| {
            value
                .response
                .as_ref()
                .and_then(|response| response.usage.as_ref().copied())
        })
}

fn usage_from_result_value(value: &Value) -> Option<CodexRawUsage> {
    usage_from_value(value.get("usage"))
        .or_else(|| {
            value
                .get("data")
                .and_then(|data| usage_from_value(data.get("usage")))
        })
        .or_else(|| {
            value
                .get("result")
                .and_then(|result| usage_from_value(result.get("usage")))
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(|response| usage_from_value(response.get("usage")))
        })
}

fn usage_from_value(value: Option<&Value>) -> Option<CodexRawUsage> {
    serde_json::from_value(value?.clone()).ok()
}

fn codex_timestamp_from_result(value: &CodexLogEntry<'_>) -> Option<String> {
    normalize_codex_timestamp(value.timestamp.as_ref())
        .or_else(|| normalize_codex_timestamp(value.created_at.as_ref()))
        .or_else(|| normalize_codex_timestamp(value.created_at_camel.as_ref()))
        .or_else(|| {
            value
                .data
                .as_ref()
                .and_then(|data| normalize_result_fields_timestamp(data))
        })
        .or_else(|| {
            value
                .result
                .as_ref()
                .and_then(|result| normalize_result_fields_timestamp(result))
        })
        .or_else(|| {
            value
                .response
                .as_ref()
                .and_then(|response| normalize_result_fields_timestamp(response))
        })
}

fn codex_timestamp_from_result_value(value: &Value) -> Option<String> {
    normalize_value_fields_timestamp(value)
        .or_else(|| value.get("data").and_then(normalize_value_fields_timestamp))
        .or_else(|| {
            value
                .get("result")
                .and_then(normalize_value_fields_timestamp)
        })
        .or_else(|| {
            value
                .get("response")
                .and_then(normalize_value_fields_timestamp)
        })
}

fn normalize_result_fields_timestamp(value: &CodexResultFields<'_>) -> Option<String> {
    normalize_codex_timestamp(value.timestamp.as_ref())
        .or_else(|| normalize_codex_timestamp(value.created_at.as_ref()))
        .or_else(|| normalize_codex_timestamp(value.created_at_camel.as_ref()))
}

fn normalize_value_fields_timestamp(value: &Value) -> Option<String> {
    normalize_value_timestamp(value.get("timestamp"))
        .or_else(|| normalize_value_timestamp(value.get("created_at")))
        .or_else(|| normalize_value_timestamp(value.get("createdAt")))
}

fn normalize_codex_timestamp(value: Option<&CodexTimestamp<'_>>) -> Option<String> {
    match value? {
        CodexTimestamp::String(text) => {
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            crate::parse_ts_timestamp(text).map(crate::format_rfc3339_millis)
        }
        CodexTimestamp::Number(raw) => {
            let millis = if *raw > 10_000_000_000 {
                *raw
            } else {
                raw.checked_mul(1_000)?
            };
            Some(crate::format_rfc3339_millis(TimestampMs::from_millis(
                millis.min(i64::MAX as u64) as i64,
            )))
        }
    }
}

fn normalize_value_timestamp(value: Option<&Value>) -> Option<String> {
    let value = value?;
    if let Some(text) = value.as_str() {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        return crate::parse_ts_timestamp(text).map(crate::format_rfc3339_millis);
    }
    let raw = value.as_u64()?;
    let millis = if raw > 10_000_000_000 {
        raw
    } else {
        raw.checked_mul(1_000)?
    };
    Some(crate::format_rfc3339_millis(TimestampMs::from_millis(
        millis.min(i64::MAX as u64) as i64,
    )))
}

fn normalize_headless_codex_usage(value: &CodexLogEntry<'_>) -> Option<CodexRawUsage> {
    let usage = usage_from_result(value)?;
    if usage.input_tokens == 0
        && usage.cached_input_tokens == 0
        && usage.output_tokens == 0
        && usage.reasoning_output_tokens == 0
        && usage.total_tokens == 0
    {
        return None;
    }
    Some(usage)
}

fn normalize_headless_codex_usage_value(value: &Value) -> Option<CodexRawUsage> {
    let usage = usage_from_result_value(value)?;
    if usage.input_tokens == 0
        && usage.cached_input_tokens == 0
        && usage.output_tokens == 0
        && usage.reasoning_output_tokens == 0
        && usage.total_tokens == 0
    {
        return None;
    }
    Some(usage)
}

fn file_modified_timestamp(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| {
            crate::format_rfc3339_millis(TimestampMs::from_millis(
                duration.as_millis().min(i64::MAX as u128) as i64,
            ))
        })
        .unwrap_or_else(|| crate::format_rfc3339_millis(TimestampMs::UNIX_EPOCH))
}

fn subtract_codex_raw_usage(
    current: &CodexRawUsage,
    previous: Option<&CodexRawUsage>,
) -> CodexRawUsage {
    CodexRawUsage {
        input_tokens: current
            .input_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.input_tokens)),
        cached_input_tokens: current
            .cached_input_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.cached_input_tokens)),
        output_tokens: current
            .output_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.output_tokens)),
        reasoning_output_tokens: current
            .reasoning_output_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.reasoning_output_tokens)),
        total_tokens: current
            .total_tokens
            .saturating_sub(previous.map_or(0, |usage| usage.total_tokens)),
    }
}

fn dedupe_codex_events(events: &mut Vec<CodexTokenUsageEvent>) {
    let mut seen = FxHashSet::default();
    events.retain(|event| {
        seen.insert((
            CompactString::new(&event.session_id),
            CompactString::new(&event.timestamp),
            event.model.as_deref().map(CompactString::new),
            event.input_tokens,
            event.cached_input_tokens,
            event.output_tokens,
            event.reasoning_output_tokens,
            event.total_tokens,
        ))
    });
}

#[derive(Deserialize)]
struct CodexSessionLogEntry<'a> {
    #[serde(rename = "type", borrow, default)]
    entry_type: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<CodexTimestamp<'a>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    payload: Option<CodexPayload<'a>>,
}

#[derive(Deserialize)]
struct CodexLogEntry<'a> {
    #[serde(borrow, default)]
    timestamp: Option<CodexTimestamp<'a>>,
    #[serde(rename = "created_at", borrow, default)]
    created_at: Option<CodexTimestamp<'a>>,
    #[serde(rename = "createdAt", borrow, default)]
    created_at_camel: Option<CodexTimestamp<'a>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    data: Option<CodexResultFields<'a>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    result: Option<CodexResultFields<'a>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    response: Option<CodexResultFields<'a>>,
    #[serde(default, deserialize_with = "deserialize_optional_object_lossy")]
    usage: Option<CodexRawUsage>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(rename = "model_name", borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    metadata: Option<CodexModelMetadata<'a>>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum CodexTimestamp<'a> {
    String(Cow<'a, str>),
    Number(u64),
}

#[derive(Default, Deserialize)]
struct CodexPayload<'a> {
    #[serde(rename = "type", borrow, default)]
    payload_type: Option<Cow<'a, str>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    info: Option<CodexInfo<'a>>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(rename = "model_name", borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    metadata: Option<CodexModelMetadata<'a>>,
}

#[derive(Default, Deserialize)]
struct CodexInfo<'a> {
    #[serde(default, deserialize_with = "deserialize_optional_object_lossy")]
    last_token_usage: Option<CodexRawUsage>,
    #[serde(default, deserialize_with = "deserialize_optional_object_lossy")]
    total_token_usage: Option<CodexRawUsage>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(rename = "model_name", borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    metadata: Option<CodexModelMetadata<'a>>,
}

#[derive(Default, Deserialize)]
struct CodexResultFields<'a> {
    #[serde(borrow, default)]
    timestamp: Option<CodexTimestamp<'a>>,
    #[serde(rename = "created_at", borrow, default)]
    created_at: Option<CodexTimestamp<'a>>,
    #[serde(rename = "createdAt", borrow, default)]
    created_at_camel: Option<CodexTimestamp<'a>>,
    #[serde(default, deserialize_with = "deserialize_optional_object_lossy")]
    usage: Option<CodexRawUsage>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(rename = "model_name", borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(
        borrow,
        default,
        deserialize_with = "deserialize_optional_object_lossy"
    )]
    metadata: Option<CodexModelMetadata<'a>>,
}

#[derive(Deserialize)]
struct CodexModelMetadata<'a> {
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
struct CodexRawUsageFields {
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    prompt_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    input: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    cached_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    cache_read_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    cached_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    output_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    completion_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    output: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    reasoning_output_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    reasoning_tokens: Option<u64>,
    #[serde(default, deserialize_with = "deserialize_optional_u64_lossy")]
    total_tokens: Option<u64>,
}

impl<'de> Deserialize<'de> for CodexRawUsage {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let fields = CodexRawUsageFields::deserialize(deserializer)?;
        let input = fields
            .input_tokens
            .or(fields.prompt_tokens)
            .or(fields.input)
            .unwrap_or(0);
        let output = fields
            .output_tokens
            .or(fields.completion_tokens)
            .or(fields.output)
            .unwrap_or(0);
        let reasoning = fields
            .reasoning_output_tokens
            .or(fields.reasoning_tokens)
            .unwrap_or(0);
        Ok(Self {
            input_tokens: input,
            cached_input_tokens: fields
                .cached_input_tokens
                .or(fields.cache_read_input_tokens)
                .or(fields.cached_tokens)
                .unwrap_or(0),
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: fields
                .total_tokens
                .filter(|total| *total > 0 || input + output + reasoning == 0)
                .unwrap_or(input + output + reasoning),
        })
    }
}

fn deserialize_optional_object_lossy<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    struct OptionalObjectVisitor<T>(PhantomData<T>);

    impl<'de, T> serde::de::Visitor<'de> for OptionalObjectVisitor<T>
    where
        T: serde::Deserialize<'de>,
    {
        type Value = Option<T>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an optional object")
        }

        fn visit_none<E>(self) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserialize_optional_object_lossy(deserializer)
        }

        fn visit_map<A>(self, map: A) -> std::result::Result<Self::Value, A::Error>
        where
            A: serde::de::MapAccess<'de>,
        {
            T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Some)
        }

        fn visit_bool<E>(self, _value: bool) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_i64<E>(self, _value: i64) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_u64<E>(self, _value: u64) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_f64<E>(self, _value: f64) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_str<E>(self, _value: &str) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<Self::Value, A::Error>
        where
            A: serde::de::SeqAccess<'de>,
        {
            while sequence.next_element::<serde::de::IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }

    deserializer.deserialize_any(OptionalObjectVisitor(PhantomData))
}

fn deserialize_optional_u64_lossy<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct OptionalU64Visitor;

    impl<'de> serde::de::Visitor<'de> for OptionalU64Visitor {
        type Value = Option<u64>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("an optional unsigned integer")
        }

        fn visit_none<E>(self) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_unit<E>(self) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_some<D>(self, deserializer: D) -> std::result::Result<Self::Value, D::Error>
        where
            D: serde::Deserializer<'de>,
        {
            deserialize_optional_u64_lossy(deserializer)
        }

        fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(Some(value))
        }

        fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(value.trim().parse::<u64>().ok())
        }

        fn visit_borrowed_str<E>(self, value: &'de str) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            self.visit_str(value)
        }

        fn visit_string<E>(self, value: String) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            self.visit_str(&value)
        }

        fn visit_i64<E>(self, _value: i64) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_f64<E>(self, _value: f64) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }

        fn visit_bool<E>(self, _value: bool) -> std::result::Result<Self::Value, E>
        where
            E: serde::de::Error,
        {
            Ok(None)
        }
    }

    deserializer.deserialize_any(OptionalU64Visitor)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::json;

    fn codex_event(session_id: &str) -> CodexTokenUsageEvent {
        CodexTokenUsageEvent {
            session_id: session_id.to_string(),
            timestamp: "2026-01-02T00:00:00.000Z".to_string(),
            model: Some("gpt-5".to_string()),
            input_tokens: 100,
            cached_input_tokens: 10,
            output_tokens: 50,
            reasoning_output_tokens: 0,
            total_tokens: 150,
            is_fallback_model: false,
        }
    }

    #[test]
    fn keeps_matching_codex_usage_events_from_distinct_sessions() {
        let mut events = vec![codex_event("session-a"), codex_event("session-b")];

        dedupe_codex_events(&mut events);

        assert_eq!(events.len(), 2);
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ccusage-codex-exec-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn loads_saved_codex_exec_json_usage() {
        let dir = temp_dir("json-usage");
        let file = dir.join("run.jsonl");
        fs::write(
            &file,
            [
                json!({
                    "type": "turn.completed",
                    "timestamp": "2026-01-02T03:04:05.000Z",
                    "model": "gpt-5.2-codex",
                    "usage": {
                        "input_tokens": 120,
                        "cached_input_tokens": 20,
                        "output_tokens": 30,
                        "total_tokens": 150,
                    },
                })
                .to_string(),
                json!({
                    "type": "result",
                    "data": {
                        "timestamp": "2026-01-02T03:05:05.000Z",
                        "model_name": "gpt-5.2-codex",
                        "usage": {
                            "prompt_tokens": 50,
                            "cached_tokens": 5,
                            "completion_tokens": 12,
                        },
                    },
                })
                .to_string(),
                json!({
                    "type": "turn.completed",
                    "timestamp": "2026-01-02T03:06:05.000Z",
                    "model": "gpt-5.2-codex",
                    "usage": {
                        "input_tokens": 9,
                        "output_tokens": 4,
                        "reasoning_output_tokens": 1,
                        "total_tokens": 0,
                    },
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&dir, true).unwrap();

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].session_id, "run");
        assert_eq!(events[0].timestamp, "2026-01-02T03:04:05.000Z");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5.2-codex"));
        assert_eq!(events[0].input_tokens, 120);
        assert_eq!(events[0].cached_input_tokens, 20);
        assert_eq!(events[0].output_tokens, 30);
        assert_eq!(events[0].total_tokens, 150);
        assert_eq!(events[1].timestamp, "2026-01-02T03:05:05.000Z");
        assert_eq!(events[1].model.as_deref(), Some("gpt-5.2-codex"));
        assert_eq!(events[1].input_tokens, 50);
        assert_eq!(events[1].cached_input_tokens, 5);
        assert_eq!(events[1].output_tokens, 12);
        assert_eq!(events[1].total_tokens, 62);
        assert_eq!(events[2].timestamp, "2026-01-02T03:06:05.000Z");
        assert_eq!(events[2].input_tokens, 9);
        assert_eq!(events[2].output_tokens, 4);
        assert_eq!(events[2].reasoning_output_tokens, 1);
        assert_eq!(events[2].total_tokens, 14);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn loads_session_usage_with_numeric_timestamp() {
        let dir = temp_dir("numeric-session-timestamp");
        let file = dir.join("session.jsonl");
        fs::write(
            &file,
            [
                json!({
                    "timestamp": "2026-01-02T00:00:00.000Z",
                    "type": "turn_context",
                    "payload": {
                        "model": "gpt-5",
                    },
                })
                .to_string(),
                json!({
                    "timestamp": 1767312001000_u64,
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {
                            "total_token_usage": {
                                "input_tokens": 100,
                                "cached_input_tokens": 10,
                                "output_tokens": 50,
                                "reasoning_output_tokens": 0,
                                "total_tokens": 150,
                            },
                            "model": "gpt-5",
                        },
                    },
                })
                .to_string(),
            ]
            .join("\n"),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&dir, true).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "session");
        assert_eq!(events[0].timestamp, "2026-01-02T00:00:01.000Z");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(events[0].input_tokens, 100);
        assert_eq!(events[0].cached_input_tokens, 10);
        assert_eq!(events[0].output_tokens, 50);
        assert_eq!(events[0].total_tokens, 150);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn loads_session_usage_with_spaced_type_fields() {
        let dir = temp_dir("spaced-session-type");
        let file = dir.join("session.jsonl");
        fs::write(
            &file,
            [
                r#"{ "timestamp": "2026-01-02T00:00:00.000Z", "type" : "turn_context", "payload": { "model": "gpt-5" } }"#,
                r#"{ "timestamp": "2026-01-02T00:00:01.000Z", "type" : "event_msg", "payload": { "type" : "token_count", "info": { "total_token_usage": { "input_tokens": 100, "cached_input_tokens": 10, "output_tokens": 50, "total_tokens": 150 }, "model": "gpt-5" } } }"#,
                r#"{ "timestamp": "2026-01-02T00:00:02.000Z", "type" : "event_msg", "payload": { "type":"token_count", "info": { "total_token_usage": { "input_tokens": 200, "cached_input_tokens": 20, "output_tokens": 75, "total_tokens": 275 }, "model": "gpt-5" } } }"#,
            ]
            .join("\n"),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&dir, true).unwrap();

        assert_eq!(events.len(), 2);
        assert_eq!(events[0].timestamp, "2026-01-02T00:00:01.000Z");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5"));
        assert_eq!(events[0].input_tokens, 100);
        assert_eq!(events[0].cached_input_tokens, 10);
        assert_eq!(events[0].output_tokens, 50);
        assert_eq!(events[0].total_tokens, 150);
        assert_eq!(events[1].timestamp, "2026-01-02T00:00:02.000Z");
        assert_eq!(events[1].input_tokens, 100);
        assert_eq!(events[1].cached_input_tokens, 10);
        assert_eq!(events[1].output_tokens, 25);
        assert_eq!(events[1].total_tokens, 125);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn loads_headless_usage_with_unexpected_noncritical_field_types() {
        let dir = temp_dir("headless-lossy-fields");
        let file = dir.join("run.jsonl");
        fs::write(
            &file,
            json!({
                "type": "turn.completed",
                "timestamp": false,
                "model": {
                    "name": "unexpected"
                },
                "usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 20,
                    "output_tokens": 30,
                    "total_tokens": 150,
                },
            })
            .to_string(),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&dir, true).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "run");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5"));
        assert!(events[0].is_fallback_model);
        assert_eq!(events[0].input_tokens, 120);
        assert_eq!(events[0].cached_input_tokens, 20);
        assert_eq!(events[0].output_tokens, 30);
        assert_eq!(events[0].total_tokens, 150);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn loads_headless_usage_with_token_count_text_content() {
        let dir = temp_dir("headless-token-count-content");
        let file = dir.join("run.jsonl");
        fs::write(
            &file,
            json!({
                "type": "turn.completed",
                "timestamp": "2026-01-02T03:04:05.000Z",
                "model": "gpt-5.2-codex",
                "content": "debug token_count payload text",
                "usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 20,
                    "output_tokens": 30,
                    "total_tokens": 150,
                },
            })
            .to_string(),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&dir, true).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "run");
        assert_eq!(events[0].timestamp, "2026-01-02T03:04:05.000Z");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5.2-codex"));
        assert_eq!(events[0].input_tokens, 120);
        assert_eq!(events[0].cached_input_tokens, 20);
        assert_eq!(events[0].output_tokens, 30);
        assert_eq!(events[0].total_tokens, 150);

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn uses_nested_model_name_for_standalone_exec_usage() {
        let dir = temp_dir("model-name");
        let file = dir.join("solo.jsonl");
        fs::write(
            &file,
            json!({
                "data": {
                    "timestamp": "2026-03-01T00:00:00.000Z",
                    "model_name": "gpt-5.2-codex",
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "total_tokens": 15,
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let events = load_codex_events_from_directory(&dir, true).unwrap();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "solo");
        assert_eq!(events[0].model.as_deref(), Some("gpt-5.2-codex"));
        assert_eq!(events[0].input_tokens, 10);
        assert_eq!(events[0].output_tokens, 5);
        assert_eq!(events[0].total_tokens, 15);

        fs::remove_dir_all(dir).unwrap();
    }
}
