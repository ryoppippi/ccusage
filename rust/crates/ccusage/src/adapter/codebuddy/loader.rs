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
        crate::progress::UsageLoadAgent::CodeBuddy,
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
    use super::*;
    use ccusage_test_support::fs_fixture;

    /// Helper: a function_call line with rawUsage carrying the given
    /// numbers and a unique line-level `id`.
    fn line(id: &str, sess: &str, ts_ms: i64, input: u64, output: u64) -> String {
        let value = serde_json::json!({
            "id": id,
            "type": "function_call",
            "timestamp": ts_ms,
            "sessionId": sess,
            "providerData": {
                "model": "MaaS_Cl_Opus_4.7_20260416_cache",
                "rawUsage": {
                    "prompt_tokens": input,
                    "completion_tokens": output,
                    "total_tokens": input + output,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0
                }
            }
        });
        value.to_string()
    }

    #[test]
    fn loads_assistant_usage_from_realistic_session() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let l1 = line("id-1", "sess-A", 1_769_753_935_279, 1660, 55);
        let l2 = line("id-2", "sess-A", 1_769_753_999_000, 100, 10);
        let fixture = fs_fixture!({
            "Users-example-proj/sess-A.jsonl": format!("{l1}\n{l2}\n"),
        });
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, fixture.root().to_str()).unwrap();

        assert_eq!(entries.len(), 2);
        // Sort order is by timestamp ascending — id-1 came first.
        assert_eq!(entries[0].data.request_id.as_deref(), Some("id-1"));
        assert_eq!(entries[1].data.request_id.as_deref(), Some("id-2"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 1660);
        assert_eq!(entries[0].data.message.usage.output_tokens, 55);
        assert_eq!(
            entries[0].model.as_deref(),
            Some("[codebuddy] MaaS_Cl_Opus_4.7_20260416_cache")
        );
        assert_eq!(entries[0].cost, 0.0);
    }

    #[test]
    fn subagent_files_contribute_to_totals() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let main_line = line("main-id", "sess-main", 1_780_000_000_000, 1000, 100);
        let sub_a_line = line("sub-a-id", "sess-sub-a", 1_780_000_001_000, 200, 20);
        let sub_b_line = line("sub-b-id", "sess-sub-b", 1_780_000_002_000, 300, 30);
        let fixture = fs_fixture!({
            "Users-example-proj/main-uuid.jsonl": format!("{main_line}\n"),
            "Users-example-proj/main-uuid/subagents/agent-aaa.jsonl": format!("{sub_a_line}\n"),
            "Users-example-proj/main-uuid/subagents/agent-bbb.jsonl": format!("{sub_b_line}\n"),
        });
        let entries = load_entries(&SharedArgs::default(), fixture.root().to_str()).unwrap();

        assert_eq!(entries.len(), 3, "main + 2 subagents = 3 entries");
        let total_input: u64 = entries
            .iter()
            .map(|e| e.data.message.usage.input_tokens)
            .sum();
        let total_output: u64 = entries
            .iter()
            .map(|e| e.data.message.usage.output_tokens)
            .sum();
        assert_eq!(total_input, 1000 + 200 + 300);
        assert_eq!(total_output, 100 + 20 + 30);

        // Each line has its own sessionId — subagents do NOT roll up
        // under the parent main session.
        let mut sessions: Vec<&str> = entries.iter().map(|e| e.session_id.as_ref()).collect();
        sessions.sort();
        assert_eq!(sessions, vec!["sess-main", "sess-sub-a", "sess-sub-b"]);
    }

    #[test]
    fn deduplicates_repeated_records_by_id_within_a_file() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let l = line("dup-id", "sess", 1_780_000_000_000, 50, 5);
        let fixture = fs_fixture!({
            "Users-example-proj/dup.jsonl": format!("{l}\n{l}\n{l}\n"),
        });
        let entries = load_entries(&SharedArgs::default(), fixture.root().to_str()).unwrap();

        assert_eq!(
            entries.len(),
            1,
            "three identical lines collapse to one entry by line-level id"
        );
    }

    #[test]
    fn deduplicates_records_with_same_id_across_files() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        // Same id appearing in two different files (e.g. a backup
        // directory included via comma-separated paths). Should
        // collapse to one entry — file path is intentionally NOT in
        // the dedup key.
        let l = line("shared-id", "sess", 1_780_000_000_000, 50, 5);
        let fixture = fs_fixture!({
            "Users-example-proj/main.jsonl": format!("{l}\n"),
            "Users-example-proj-backup/main.jsonl": format!("{l}\n"),
        });
        let entries = load_entries(&SharedArgs::default(), fixture.root().to_str()).unwrap();

        assert_eq!(entries.len(), 1, "same id across two files dedups");
    }

    #[test]
    fn multiple_sessions_in_multiple_dirs() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let a = line("a-id", "sess-a", 1_780_000_000_000, 10, 1);
        let b = line("b-id", "sess-b", 1_780_000_001_000, 20, 2);
        let c = line("c-id", "sess-c", 1_780_000_002_000, 30, 3);
        let fixture = fs_fixture!({
            "Users-example-A/sess-a.jsonl": format!("{a}\n"),
            "Users-example-B/sess-b.jsonl": format!("{b}\n"),
            "Users-example-C/sess-c.jsonl": format!("{c}\n"),
        });
        let entries = load_entries(&SharedArgs::default(), fixture.root().to_str()).unwrap();

        assert_eq!(entries.len(), 3);
        // Sorted by timestamp ascending.
        assert_eq!(entries[0].session_id.as_ref(), "sess-a");
        assert_eq!(entries[1].session_id.as_ref(), "sess-b");
        assert_eq!(entries[2].session_id.as_ref(), "sess-c");
    }
}
