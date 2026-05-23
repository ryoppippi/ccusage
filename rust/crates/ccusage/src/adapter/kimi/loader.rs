use std::collections::HashSet;

use crate::{cli::SharedArgs, parse_tz, LoadedEntry, PricingMap, Result};

use super::{
    parser::{kimi_entry_key, kimi_entry_to_loaded, read_wire_file},
    paths::discover_wire_files,
};

pub(crate) fn load_entries(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Kimi, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for file in discover_wire_files()? {
        for entry in read_wire_file(&file)? {
            let key = kimi_entry_key(&entry);
            if seen.insert(key) {
                entries.push(kimi_entry_to_loaded(
                    entry,
                    tz.as_ref(),
                    shared.mode,
                    pricing,
                ));
            }
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf};

    use super::*;

    fn temp_kimi_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-kimi-{name}-{nanos}"));
        path
    }

    #[test]
    fn loads_status_update_token_usage_from_wire_files() {
        let _guard = super::super::KIMI_DATA_DIR_LOCK.lock().unwrap();
        let kimi_dir = temp_kimi_dir("wire");
        fs::create_dir_all(kimi_dir.join("sessions/group/session-a")).unwrap();
        fs::write(kimi_dir.join("config.json"), r#"{"model":"kimi-k2"}"#).unwrap();
        fs::write(
            kimi_dir.join("sessions/group/session-a/wire.jsonl"),
            [
                r#"{"type":"metadata","protocol_version":"1.3"}"#,
                r#"{"timestamp":1770983426.420942,"message":{"type":"TurnBegin","payload":{"user_input":"hello"}}}"#,
                r#"{"timestamp":1770983427.123,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":100,"output":50,"input_cache_read":10,"input_cache_creation":20},"message_id":"msg-1"}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        env::set_var(super::super::paths::KIMI_DATA_DIR_ENV, &kimi_dir);
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();
        env::remove_var(super::super::paths::KIMI_DATA_DIR_ENV);
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-02-13");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(entries[0].model.as_deref(), Some("kimi-k2"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
    }

    #[test]
    fn skips_malformed_and_zero_token_wire_lines() {
        let _guard = super::super::KIMI_DATA_DIR_LOCK.lock().unwrap();
        let kimi_dir = temp_kimi_dir("zero");
        fs::create_dir_all(kimi_dir.join("sessions/group/session-a")).unwrap();
        fs::write(
            kimi_dir.join("sessions/group/session-a/wire.jsonl"),
            [
                "not json",
                r#"{"timestamp":1770983427,"message":{"type":"StatusUpdate","payload":{"token_usage":{"input_other":0,"output":0,"input_cache_read":0,"input_cache_creation":0}}}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        env::set_var(super::super::paths::KIMI_DATA_DIR_ENV, &kimi_dir);
        let entries = load_entries(&SharedArgs::default(), &PricingMap::load_embedded()).unwrap();
        env::remove_var(super::super::paths::KIMI_DATA_DIR_ENV);
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert!(entries.is_empty());
    }
}
