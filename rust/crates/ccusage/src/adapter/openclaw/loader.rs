use std::collections::HashSet;

use crate::{cli::SharedArgs, parse_tz, LoadedEntry, Result};

use super::{
    parser::{entry_id, parse_session_file},
    paths::{collect_session_files, paths},
};

pub(crate) fn load_entries(
    shared: &SharedArgs,
    custom_path: Option<&str>,
) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(
        crate::progress::UsageLoadAgent::OpenClaw,
        shared.json,
        || load_entries_inner(shared, custom_path),
    )
}

fn load_entries_inner(shared: &SharedArgs, custom_path: Option<&str>) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for root in paths(custom_path) {
        for file in collect_session_files(&root)? {
            for entry in parse_session_file(&file, tz.as_ref())? {
                if seen.insert(entry_id(&entry)) {
                    entries.push(entry);
                }
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf, sync::Mutex};

    use super::*;

    static OPENCLAW_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn temp_openclaw_dir(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-openclaw-{name}-{nanos}"));
        path
    }

    #[test]
    fn loads_assistant_usage_and_uses_model_change_events() {
        let _guard = OPENCLAW_DIR_LOCK.lock().unwrap();
        let dir = temp_openclaw_dir("usage");
        fs::create_dir_all(dir.join("agents/main/sessions")).unwrap();
        fs::write(
            dir.join("agents/main/sessions/abc.jsonl"),
            [
                r#"{"type":"model_change","provider":"openai-codex","modelId":"gpt-5.2"}"#,
                r#"{"type":"message","message":{"role":"assistant","usage":{"input":1660,"output":55,"cacheRead":108928,"cost":{"total":0.02}},"timestamp":1769753935279}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, Some(dir.to_str().unwrap())).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-30");
        assert_eq!(entries[0].session_id.as_ref(), "abc");
        assert_eq!(entries[0].model.as_deref(), Some("[openclaw] gpt-5.2"));
        assert_eq!(entries[0].data.version.as_deref(), Some("openai-codex"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 1660);
        assert_eq!(entries[0].data.message.usage.output_tokens, 55);
        assert_eq!(
            entries[0].data.message.usage.cache_read_input_tokens,
            108_928
        );
        assert_eq!(entries[0].extra_total_tokens, 0);
        assert!((entries[0].cost - 0.02).abs() < f64::EPSILON);
    }

    #[test]
    fn deduplicates_repeated_openclaw_records() {
        let _guard = OPENCLAW_DIR_LOCK.lock().unwrap();
        let dir = temp_openclaw_dir("dedupe");
        fs::create_dir_all(dir.join("agents/main/sessions")).unwrap();
        let line = r#"{"type":"message","message":{"role":"assistant","model":"gpt-5.2","usage":{"input":1,"output":1,"totalTokens":2},"timestamp":1769753935279}}"#;
        fs::write(
            dir.join("agents/main/sessions/session.jsonl"),
            format!("{line}\n{line}\n"),
        )
        .unwrap();
        let entries = load_entries(&SharedArgs::default(), Some(dir.to_str().unwrap())).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(entries.len(), 1);
    }
}
