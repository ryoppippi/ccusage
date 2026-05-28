use crate::{cli::SharedArgs, parse_tz, LoadedEntry, PricingMap, Result};

use super::{
    parser::{event_to_loaded, parse_transcript_file},
    paths::discover_log_files,
};

pub(crate) fn load_entries(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(crate::progress::UsageLoadAgent::Antigravity, shared.json, || {
        load_entries_inner(shared, pricing)
    })
}

fn load_entries_inner(shared: &SharedArgs, pricing: &PricingMap) -> Result<Vec<LoadedEntry>> {
    let tz = parse_tz(shared.timezone.as_deref());
    let mut events = Vec::new();
    for file in discover_log_files()? {
        events.extend(parse_transcript_file(&file)?);
    }
    events.sort_by_key(|event| event.timestamp);
    Ok(events
        .into_iter()
        .map(|event| event_to_loaded(event, tz.as_ref(), shared.mode, pricing))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccusage_test_support::fs_fixture;

    #[test]
    fn loads_antigravity_transcript_events_with_estimated_tokens() {
        let _guard = super::super::ANTIGRAVITY_DATA_DIR_LOCK.lock().unwrap();
        let fixture = fs_fixture!({
            "brain/session-abc/.system_generated/logs/transcript.jsonl": [
                r#"{"created_at":"2026-05-28T13:42:00Z","type":"USER_INPUT","content":"test message"}"#,
                r#"{"created_at":"2026-05-28T13:42:05Z","type":"PLANNER_RESPONSE","content":"response message","thinking":"thinking hard"}"#,
            ]
            .join("\n"),
        });
        let _env_guard = super::super::AntigravityDataDirEnvGuard::set(fixture.root());
        let shared = SharedArgs {
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries(&shared, &PricingMap::load_embedded()).unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].date, "2026-05-28");
        assert_eq!(entries[0].session_id.as_ref(), "session-abc");
        assert_eq!(entries[0].model.as_deref(), Some("google/gemini-3.5-flash"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 18);
        assert_eq!(entries[0].data.message.usage.output_tokens, 0);

        assert_eq!(entries[1].data.message.usage.output_tokens, 24);
        assert_eq!(entries[1].extra_total_tokens, 20);
    }
}
