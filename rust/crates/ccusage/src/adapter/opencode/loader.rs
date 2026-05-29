use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use jiff::{civil, tz::TimeZone as JiffTimeZone};
use serde_json::Value;

use super::{parser::message_value_to_entry, paths::paths};
use crate::{
    cli::{CostMode, SharedArgs},
    collect_files_with_extension, debug_log, parse_tz, LoadedEntry, PricingMap, Result,
};

const MS_PER_DAY: i64 = 86_400_000;

fn parse_yyyymmdd_to_utc_ms(value: &str) -> Option<i64> {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 8 {
        return None;
    }
    let year: i16 = digits[0..4].parse().ok()?;
    let month: i8 = digits[4..6].parse().ok()?;
    let day: i8 = digits[6..8].parse().ok()?;
    let date = civil::Date::new(year, month, day).ok()?;
    let zoned = date.to_zoned(JiffTimeZone::UTC).ok()?;
    Some(zoned.timestamp().as_millisecond())
}

fn since_until_ms_with_slack(shared: &SharedArgs) -> (Option<i64>, Option<i64>) {
    let since_ms = shared
        .since
        .as_deref()
        .and_then(parse_yyyymmdd_to_utc_ms)
        .map(|ms| ms - MS_PER_DAY);
    let until_ms = shared
        .until
        .as_deref()
        .and_then(parse_yyyymmdd_to_utc_ms)
        .map(|ms| ms + 2 * MS_PER_DAY);
    (since_ms, until_ms)
}

pub(crate) fn load_entries(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    crate::progress::track_usage_load(
        crate::progress::UsageLoadAgent::OpenCode,
        shared.json,
        || load_entries_inner(shared),
    )
}

fn load_entries_inner(shared: &SharedArgs) -> Result<Vec<LoadedEntry>> {
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    for path in paths()? {
        for entry in load_entries_from_directory(&path, shared)? {
            if let Some(id) = entry_id(&entry) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

pub(crate) fn load_entries_from_directory(
    opencode_dir: &Path,
    shared: &SharedArgs,
) -> Result<Vec<LoadedEntry>> {
    let pricing = if shared.mode == CostMode::Display {
        None
    } else {
        Some(PricingMap::load(
            shared.offline,
            crate::log_level() != Some(0),
        ))
    };
    let tz = parse_tz(shared.timezone.as_deref());
    let (since_ms, until_ms) = since_until_ms_with_slack(shared);
    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    if let Some(db_path) = db_path(opencode_dir) {
        for entry in
            load_entries_from_database(&db_path, tz.as_ref(), shared.mode, pricing.as_ref(), shared)
        {
            if let Some(id) = entry_id(&entry) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            entries.push(entry);
        }
    }

    let messages_dir = opencode_dir.join("storage").join("message");
    let mut files = Vec::new();
    collect_files_with_extension(&messages_dir, "json", &mut files);
    for file in files {
        if let (Some(min_ms), Ok(meta)) = (since_ms, fs::metadata(&file)) {
            if let Ok(modified) = meta.modified() {
                let modified_ms = modified
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(i64::MIN);
                if modified_ms < min_ms {
                    continue;
                }
            }
        }
        if let Some(max_ms) = until_ms {
            if let Ok(meta) = fs::metadata(&file) {
                if let Ok(modified) = meta.modified() {
                    let modified_ms = modified
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(i64::MAX);
                    if modified_ms >= max_ms {
                        continue;
                    }
                }
            }
        }
        if let Some(entry) = read_message_file(&file, tz.as_ref(), shared.mode, pricing.as_ref())? {
            if let Some(id) = entry_id(&entry) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            entries.push(entry);
        }
    }
    entries.sort_by_key(|entry| entry.timestamp);
    Ok(entries)
}

fn db_path(opencode_dir: &Path) -> Option<PathBuf> {
    let default_path = opencode_dir.join("opencode.db");
    if default_path.is_file() {
        return Some(default_path);
    }
    let mut candidates = fs::read_dir(opencode_dir)
        .ok()?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_channel_db_name)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

fn is_channel_db_name(name: &str) -> bool {
    name.starts_with("opencode-")
        && name.ends_with(".db")
        && name["opencode-".len()..name.len() - ".db".len()]
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn load_entries_from_database(
    db_path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
    shared: &SharedArgs,
) -> Vec<LoadedEntry> {
    let Ok(connection) =
        sqlite::Connection::open_with_flags(db_path, sqlite::OpenFlags::new().with_read_only())
    else {
        debug_log(
            shared,
            format!("Failed to open OpenCode database: {}", db_path.display()),
        );
        return Vec::new();
    };
    let (since_ms, until_ms) = since_until_ms_with_slack(shared);
    let sql = match (since_ms, until_ms) {
        (Some(_), Some(_)) => {
            "SELECT id, session_id, data FROM message \
             WHERE time_created >= ?1 AND time_created < ?2"
        }
        (Some(_), None) => "SELECT id, session_id, data FROM message WHERE time_created >= ?1",
        (None, Some(_)) => "SELECT id, session_id, data FROM message WHERE time_created < ?1",
        (None, None) => "SELECT id, session_id, data FROM message",
    };
    let Ok(mut statement) = connection.prepare(sql) else {
        debug_log(
            shared,
            format!("Failed to read OpenCode database: {}", db_path.display()),
        );
        return Vec::new();
    };
    let bind_result = match (since_ms, until_ms) {
        (Some(s), Some(u)) => statement.bind((1, s)).and_then(|()| statement.bind((2, u))),
        (Some(s), None) => statement.bind((1, s)),
        (None, Some(u)) => statement.bind((1, u)),
        (None, None) => Ok(()),
    };
    if bind_result.is_err() {
        debug_log(
            shared,
            format!(
                "Failed to bind date range to OpenCode query: {}",
                db_path.display()
            ),
        );
        return Vec::new();
    }
    let mut entries = Vec::new();
    loop {
        match statement.next() {
            Ok(sqlite::State::Row) => {
                let Ok(id) = statement.read::<String, _>(0) else {
                    continue;
                };
                let Ok(session_id) = statement.read::<String, _>(1) else {
                    continue;
                };
                let Ok(data) = statement.read::<String, _>(2) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    continue;
                };
                if let Some(entry) =
                    message_value_to_entry(&value, Some(id), Some(session_id), tz, mode, pricing)
                {
                    entries.push(entry);
                }
            }
            Ok(sqlite::State::Done) => break,
            Err(_) => {
                debug_log(
                    shared,
                    format!("Failed to query OpenCode database: {}", db_path.display()),
                );
                break;
            }
        }
    }
    entries
}

fn read_message_file(
    path: &Path,
    tz: Option<&JiffTimeZone>,
    mode: CostMode,
    pricing: Option<&PricingMap>,
) -> Result<Option<LoadedEntry>> {
    let content = fs::read_to_string(path)?;
    let Ok(value) = serde_json::from_str::<Value>(&content) else {
        return Ok(None);
    };
    Ok(message_value_to_entry(
        &value, None, None, tz, mode, pricing,
    ))
}

fn entry_id(entry: &LoadedEntry) -> Option<&str> {
    entry.data.message.id.as_deref().filter(|id| !id.is_empty())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::load_entries_from_directory;
    use crate::cli::{CostMode, SharedArgs};
    use ccusage_test_support::fs_fixture;

    fn create_db_message(path: &Path, id: &str, session_id: &str, data: &str) {
        let db = sqlite::open(path).unwrap();
        db.execute("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)")
            .unwrap();
        let mut statement = db
            .prepare("INSERT INTO message (id, session_id, data) VALUES (?1, ?2, ?3)")
            .unwrap();
        statement.bind((1, id)).unwrap();
        statement.bind((2, session_id)).unwrap();
        statement.bind((3, data)).unwrap();
        statement.next().unwrap();
    }

    fn create_db_message_with_time(
        path: &Path,
        id: &str,
        session_id: &str,
        time_created_ms: i64,
        data: &str,
    ) {
        let db = sqlite::open(path).unwrap();
        db.execute(
            "CREATE TABLE IF NOT EXISTS message \
             (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER NOT NULL DEFAULT 0, data TEXT)",
        )
        .unwrap();
        let mut statement = db
            .prepare(
                "INSERT INTO message (id, session_id, time_created, data) \
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .unwrap();
        statement.bind((1, id)).unwrap();
        statement.bind((2, session_id)).unwrap();
        statement.bind((3, time_created_ms)).unwrap();
        statement.bind((4, data)).unwrap();
        statement.next().unwrap();
    }

    #[test]
    fn loads_message_json_files() {
        let fixture = fs_fixture!({
            "storage/message/message.json": r#"{"id":"msg-1","sessionID":"session-a","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":100,"output":50,"cache":{"read":10,"write":20}},"cost":0.02}"#,
        });

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-02");
        assert_eq!(entries[0].session_id.as_ref(), "session-a");
        assert_eq!(
            entries[0].model.as_deref(),
            Some("claude-sonnet-4-20250514")
        );
        assert_eq!(entries[0].data.message.usage.input_tokens, 100);
        assert_eq!(entries[0].data.message.usage.output_tokens, 50);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            20
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 10);
        assert_eq!(entries[0].cost, 0.02);
    }

    #[test]
    fn loads_messages_from_sqlite_database() {
        let fixture = fs_fixture!({});
        create_db_message(
            &fixture.path("opencode.db"),
            "db-msg-1",
            "db-session-a",
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":120,"output":60,"cache":{"read":12,"write":24}},"cost":0.03}"#,
        );

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].date, "2026-01-02");
        assert_eq!(entries[0].session_id.as_ref(), "db-session-a");
        assert_eq!(entries[0].data.message.id.as_deref(), Some("db-msg-1"));
        assert_eq!(entries[0].data.message.usage.input_tokens, 120);
        assert_eq!(entries[0].data.message.usage.output_tokens, 60);
        assert_eq!(
            entries[0].data.message.usage.cache_creation_input_tokens,
            24
        );
        assert_eq!(entries[0].data.message.usage.cache_read_input_tokens, 12);
        assert_eq!(entries[0].cost, 0.03);
    }

    #[test]
    fn loads_channel_sqlite_database() {
        let fixture = fs_fixture!({});
        create_db_message(
            &fixture.path("opencode-beta.db"),
            "channel-msg-1",
            "channel-session-a",
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":80,"output":40}}"#,
        );

        let entries = load_entries_from_directory(fixture.root(), &SharedArgs::default()).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "channel-session-a");
        assert_eq!(entries[0].data.message.usage.input_tokens, 80);
    }

    #[test]
    fn since_filter_drops_db_rows_older_than_lower_bound() {
        let fixture = fs_fixture!({});
        // 2025-12-31 00:00 UTC
        create_db_message_with_time(
            &fixture.path("opencode.db"),
            "msg-old",
            "session-old",
            1_767_139_200_000,
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767139200000},"tokens":{"input":1,"output":1}}"#,
        );
        // 2026-01-04 00:00 UTC, comfortably above since=20260103 minus 1-day slack
        create_db_message_with_time(
            &fixture.path("opencode.db"),
            "msg-new",
            "session-new",
            1_767_484_800_000,
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767484800000},"tokens":{"input":2,"output":2}}"#,
        );

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            since: Some("20260103".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.message.id.as_deref(), Some("msg-new"));
    }

    #[test]
    fn until_filter_drops_db_rows_at_or_after_upper_bound() {
        let fixture = fs_fixture!({});
        // 2026-01-02 00:00 UTC, comfortably below until=20260105 plus 2-day slack (=20260107)
        create_db_message_with_time(
            &fixture.path("opencode.db"),
            "msg-early",
            "session-early",
            1_767_312_000_000,
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":1,"output":1}}"#,
        );
        // 2026-01-11 00:00 UTC, above until=20260105 plus 2-day slack
        create_db_message_with_time(
            &fixture.path("opencode.db"),
            "msg-late",
            "session-late",
            1_768_089_600_000,
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1768089600000},"tokens":{"input":2,"output":2}}"#,
        );

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            until: Some("20260105".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.message.id.as_deref(), Some("msg-early"));
    }

    #[test]
    fn since_filter_skips_json_files_with_older_mtime() {
        use filetime::{set_file_mtime, FileTime};

        let fixture = fs_fixture!({
            "storage/message/old.json": r#"{"id":"json-old","sessionID":"session-x","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":1,"output":1}}"#,
            "storage/message/new.json": r#"{"id":"json-new","sessionID":"session-y","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":2,"output":2}}"#,
        });
        // Force old.json mtime far below since=20260102 minus 1-day slack
        // 2025-12-25 00:00 UTC = 1_766_620_800 seconds since epoch
        set_file_mtime(
            fixture.path("storage/message/old.json"),
            FileTime::from_unix_time(1_766_620_800, 0),
        )
        .unwrap();
        // new.json keeps its current mtime (now), well above any reasonable since bound

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            since: Some("20260102".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        let ids: Vec<&str> = entries
            .iter()
            .filter_map(|e| e.data.message.id.as_deref())
            .collect();
        assert_eq!(ids, vec!["json-new"]);
    }

    #[test]
    fn no_since_until_keeps_all_json_files_regardless_of_mtime() {
        use filetime::{set_file_mtime, FileTime};

        let fixture = fs_fixture!({
            "storage/message/old.json": r#"{"id":"json-old","sessionID":"session-x","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":1,"output":1}}"#,
            "storage/message/new.json": r#"{"id":"json-new","sessionID":"session-y","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":2,"output":2}}"#,
        });
        set_file_mtime(
            fixture.path("storage/message/old.json"),
            FileTime::from_unix_time(1_000_000_000, 0),
        )
        .unwrap();

        let shared = SharedArgs {
            mode: CostMode::Display,
            timezone: Some("UTC".to_string()),
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn prefers_database_messages_over_duplicate_json_files() {
        let fixture = fs_fixture!({
            "storage/message/message.json": r#"{"id":"msg-1","sessionID":"json-session-a","providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":999,"output":999},"cost":0.99}"#,
        });
        create_db_message(
            &fixture.path("opencode.db"),
            "msg-1",
            "db-session-a",
            r#"{"providerID":"anthropic","modelID":"claude-sonnet-4-20250514","time":{"created":1767312000000},"tokens":{"input":120,"output":60},"cost":0.03}"#,
        );

        let shared = SharedArgs {
            mode: CostMode::Display,
            ..SharedArgs::default()
        };
        let entries = load_entries_from_directory(fixture.root(), &shared).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id.as_ref(), "db-session-a");
        assert_eq!(entries[0].data.message.usage.input_tokens, 120);
        assert_eq!(entries[0].cost, 0.03);
    }
}
