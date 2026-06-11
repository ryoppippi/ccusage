// Poison-recovering acquisition helper for the process-wide shared test
// mutex from `ccusage-test-support`. Sharing a single mutex across all
// env-mutating tests in the test binary is required because
// `std::env::set_var`/`remove_var` are process-global; per-module
// `Mutex<()>`s do not provide cross-module serialization and the tests
// can race despite each holding a local lock. The acquire helper
// recovers from poison so a panic in any env-mutating test does not
// cascade-poison every subsequent env test in the same process.
#[cfg(test)]
pub(super) use ccusage_test_support::acquire_env_test_lock;
use std::{env, path::Path, path::PathBuf};

use crate::Result;

pub(crate) const COPILOT_CONFIG_DIR_ENV: &str = "COPILOT_CONFIG_DIR";

/// Legacy OTel environment variables that ccusage no longer reads. We surface
/// a single warning on `ccusage copilot` invocations when any of these are
/// set, so users who configured them in the past learn they're now inert.
pub(crate) const LEGACY_OTEL_ENV_VARS: &[&str] = &[
    "COPILOT_OTEL_FILE_EXPORTER_PATH",
    "COPILOT_OTEL_DEDUP",
    "COPILOT_PREFER_OTEL",
];

const COPILOT_DIR_NAME: &str = ".copilot";
const SESSION_STATE_DIR_NAME: &str = "session-state";
const EVENTS_FILENAME: &str = "events.jsonl";

/// Enumerates `<COPILOT_CONFIG_DIR>/session-state/*/events.jsonl` files.
///
/// The OTel file-export source (`~/.copilot/otel/*.jsonl`,
/// `COPILOT_OTEL_FILE_EXPORTER_PATH`) is intentionally *not* read: now that
/// session-state ships the authoritative AI-credit and premium-request
/// billing data, OTel adds maintenance burden without giving ccusage's
/// aggregation use case any information it can't already get.
pub(super) fn session_state_paths() -> Result<Vec<PathBuf>> {
    let Some(base) = copilot_base_dir() else {
        return Ok(Vec::new());
    };
    let session_state_dir = base.join(SESSION_STATE_DIR_NAME);
    if !session_state_dir.is_dir() {
        return Ok(Vec::new());
    }
    Ok(session_state_event_files(&session_state_dir))
}

/// Short-circuit existence probe for `has_data()`. Returns `true` as soon
/// as ONE `<COPILOT_CONFIG_DIR>/session-state/<uuid>/events.jsonl` file is
/// found, without enumerating or sorting the rest of the directory.
/// Cheaper than `session_state_paths()` when the only question is "is
/// there any data on disk?" — which is what the cross-source aggregator's
/// `Detected:` sentinel needs.
pub(super) fn has_any_session_state_event_file() -> bool {
    let Some(base) = copilot_base_dir() else {
        return false;
    };
    let session_state_dir = base.join(SESSION_STATE_DIR_NAME);
    let Ok(entries) = std::fs::read_dir(&session_state_dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join(EVENTS_FILENAME).is_file() {
            return true;
        }
    }
    false
}

fn copilot_base_dir() -> Option<PathBuf> {
    // Use `var_os` (not `var`) so a non-UTF-8 directory path — legal on
    // Unix — does NOT silently fall through to the `~/.copilot` default.
    // `env::var` returns `Err(NotUnicode(..))` in that case and the prior
    // `if let Ok(value) = ...` flow would coerce it to "unset," contradicting
    // the documented "override is authoritative" invariant below.
    if let Some(value) = env::var_os(COPILOT_CONFIG_DIR_ENV) {
        let trimmed_path = PathBuf::from(trim_os_string(&value));
        if !trimmed_path.as_os_str().is_empty() {
            // Explicit override is authoritative. If the user-provided
            // directory exists, use it; if it does not, return `None`
            // (which makes `session_state_paths()` return an empty Vec
            // and `ccusage copilot ...` print "No usage data found"). We
            // do NOT fall through to the `~/.copilot` default here —
            // silently reading from the default install when the user
            // pointed us at a different directory would surprise them
            // with data they didn't ask for.
            return if trimmed_path.is_dir() {
                Some(trimmed_path)
            } else {
                None
            };
        }
    }
    // Env var unset or empty: use the conventional default.
    crate::home::home_dir().map(|home| home.join(COPILOT_DIR_NAME))
}

/// Trim whitespace from both ends of an `OsStr` without forcing a lossy
/// String conversion. On Unix the UTF-8 happy path uses `str::trim()` so
/// Unicode whitespace (NBSP, ideographic space, etc.) is still handled
/// identically to the prior `env::var(..).trim()` behavior; only when the
/// underlying bytes are NOT valid UTF-8 do we fall back to an ASCII-only
/// byte trim — non-UTF-8 paths cannot meaningfully contain Unicode
/// whitespace anyway, and the byte fallback preserves the lossless
/// round-trip that `var_os` provides.
fn trim_os_string(value: &std::ffi::OsStr) -> std::ffi::OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let bytes = value.as_bytes();
        if let Ok(s) = std::str::from_utf8(bytes) {
            return std::ffi::OsString::from(s.trim());
        }
        let start = bytes
            .iter()
            .position(|b| !b.is_ascii_whitespace())
            .unwrap_or(bytes.len());
        let end = bytes
            .iter()
            .rposition(|b| !b.is_ascii_whitespace())
            .map_or(start, |i| i + 1);
        std::ffi::OsString::from_vec(bytes[start..end].to_vec())
    }
    #[cfg(not(unix))]
    {
        // On Windows the only paths users would set here are already
        // UTF-16-then-UTF-8-representable; lossy-trim via String round
        // trip is acceptable and matches the behavior before var_os.
        std::ffi::OsString::from(value.to_string_lossy().trim())
    }
}

fn session_state_event_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let events = path.join(EVENTS_FILENAME);
        if events.is_file() {
            files.push(events);
        }
    }
    files.sort();
    files
}

/// Returns the subset of `LEGACY_OTEL_ENV_VARS` that are currently set in
/// the process environment to a non-empty value. Empty/whitespace-only
/// settings are ignored on the assumption that they reflect an unset rather
/// than an intentional configuration (matching the `COPILOT_CONFIG_DIR`
/// treatment in `copilot_base_dir`). Pure helper extracted from
/// `warn_about_inert_legacy_env_vars_once` so it can be tested without
/// capturing stderr.
pub(crate) fn legacy_otel_env_vars_in_use() -> Vec<&'static str> {
    LEGACY_OTEL_ENV_VARS
        .iter()
        .copied()
        .filter(|name| {
            // `var_os` (not `var`) so a non-UTF-8 setting of a legacy var
            // is still detected and warned about — `env::var` would
            // silently swallow `Err(NotUnicode)` as "unset" and skip the
            // deprecation warning. Symmetric with `copilot_base_dir`'s
            // override-is-authoritative invariant.
            env::var_os(name)
                .map(|value| !trim_os_string(&value).is_empty())
                .unwrap_or(false)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use ccusage_test_support::{fs_fixture, EnvScope};

    use super::*;

    #[test]
    fn enumerates_session_state_events_files() {
        let _guard = acquire_env_test_lock();
        let fixture = fs_fixture!({
            "session-state/aaaa-1111/events.jsonl": "",
            "session-state/aaaa-1111/workspace.yaml": "cwd: /tmp\n",
            "session-state/bbbb-2222/events.jsonl": "",
            "session-state/cccc-3333/events.jsonl": "",
            "session-state/dddd-empty/.keep": "",
        });
        let _env = EnvScope::new(&[(
            COPILOT_CONFIG_DIR_ENV,
            Some(fixture.root().to_str().unwrap()),
        )]);

        let paths = session_state_paths().unwrap();
        assert_eq!(
            paths.len(),
            3,
            "expected three events.jsonl entries, got {paths:?}"
        );
        for uuid in ["aaaa-1111", "bbbb-2222", "cccc-3333"] {
            let expected = fixture.path(format!("session-state/{uuid}/events.jsonl"));
            assert!(
                paths.contains(&expected),
                "missing entry for {uuid} in {paths:?}"
            );
        }
    }

    #[test]
    fn respects_copilot_config_dir_env() {
        let _guard = acquire_env_test_lock();
        let fixture = fs_fixture!({
            "session-state/alpha/events.jsonl": "",
            // Files under `otel/` exist on disk but must NOT be discovered —
            // the OTel source is intentionally ignored after this change.
            "otel/trace.jsonl": "",
        });
        let _env = EnvScope::new(&[(
            COPILOT_CONFIG_DIR_ENV,
            Some(fixture.root().to_str().unwrap()),
        )]);

        let paths = session_state_paths().unwrap();
        assert_eq!(
            paths.len(),
            1,
            "expected one session-state events.jsonl, got {paths:?}"
        );
        assert!(
            paths[0].ends_with("session-state/alpha/events.jsonl"),
            "got {paths:?}"
        );
    }

    #[test]
    fn ignores_otel_directory_even_when_present() {
        let _guard = acquire_env_test_lock();
        let fixture = fs_fixture!({
            "otel/trace.jsonl": "{\"type\":\"span\"}",
            "otel/nested/another.jsonl": "{\"type\":\"span\"}",
        });
        let _env = EnvScope::new(&[(
            COPILOT_CONFIG_DIR_ENV,
            Some(fixture.root().to_str().unwrap()),
        )]);

        // No session-state dir, only an `otel/` dir with files. Discovery
        // must return zero paths — OTel is no longer a data source.
        let paths = session_state_paths().unwrap();
        assert!(
            paths.is_empty(),
            "OTel files must not be discovered, got {paths:?}"
        );
    }

    #[test]
    fn copilot_otel_file_exporter_path_env_is_ignored() {
        let _guard = acquire_env_test_lock();
        let fixture = fs_fixture!({
            "explicit-otel.jsonl": "{\"type\":\"span\"}",
        });
        let _env = EnvScope::new(&[
            (
                "COPILOT_OTEL_FILE_EXPORTER_PATH",
                Some(fixture.path("explicit-otel.jsonl").to_str().unwrap()),
            ),
            // No session-state dir; the only thing pointed at is the
            // legacy OTel exporter env var, which must be ignored.
            (
                COPILOT_CONFIG_DIR_ENV,
                Some(fixture.root().to_str().unwrap()),
            ),
        ]);

        let paths = session_state_paths().unwrap();
        assert!(
            paths.is_empty(),
            "COPILOT_OTEL_FILE_EXPORTER_PATH must be inert, got {paths:?}"
        );
    }

    #[test]
    fn missing_directories_yield_no_sources() {
        let _guard = acquire_env_test_lock();
        let fixture = fs_fixture!({
            ".keep": "",
        });
        let _env = EnvScope::new(&[(
            COPILOT_CONFIG_DIR_ENV,
            Some(fixture.root().to_str().unwrap()),
        )]);

        let paths = session_state_paths().unwrap();
        assert!(paths.is_empty(), "expected zero paths, got {paths:?}");
    }

    #[test]
    fn nonexistent_copilot_config_dir_does_not_fall_back_to_default() {
        // Regression: an explicit `COPILOT_CONFIG_DIR` pointing at a
        // directory that doesn't exist must NOT silently fall through to
        // `~/.copilot`. The user explicitly chose a different location,
        // and reading from the default install would surprise them with
        // data they didn't ask for. We instead return an empty Vec so
        // `ccusage copilot ...` prints "No usage data found".
        //
        // Hermetic: override HOME to a temp dir that DOES contain a
        // `.copilot/session-state/<uuid>/events.jsonl` fixture. Under a
        // buggy implementation that silently fell through to
        // `~/.copilot`, the fall-through would find the fixture and the
        // assertion would fail; under the correct implementation the
        // explicit override wins and the result is empty regardless of
        // HOME contents.
        let _guard = acquire_env_test_lock();
        let home_fixture = fs_fixture!({
            ".copilot/session-state/sentinel/events.jsonl":
                "{\"sentinel\":\"would only be seen if the override silently fell through\"}\n",
        });
        let _env = EnvScope::new(&[
            ("HOME", Some(home_fixture.root().to_str().unwrap())),
            // Clear Windows alternatives so home_dir() can't pick them up.
            ("USERPROFILE", None),
            ("HOMEDRIVE", None),
            ("HOMEPATH", None),
            (
                COPILOT_CONFIG_DIR_ENV,
                Some("/definitely/does/not/exist/on/any/test/host"),
            ),
        ]);

        let paths = session_state_paths().unwrap();
        assert!(
            paths.is_empty(),
            "explicit override at a nonexistent path must yield zero \
             sources, not silently fall back to ~/.copilot; got {paths:?}"
        );
    }

    #[test]
    fn legacy_otel_env_vars_in_use_reports_only_set_non_empty_vars() {
        let _guard = acquire_env_test_lock();
        // All unset → empty.
        let _env = EnvScope::new(&[
            ("COPILOT_OTEL_FILE_EXPORTER_PATH", None),
            ("COPILOT_OTEL_DEDUP", None),
            ("COPILOT_PREFER_OTEL", None),
        ]);
        assert!(legacy_otel_env_vars_in_use().is_empty());
        drop(_env);

        // One set → reported.
        let _env = EnvScope::new(&[
            ("COPILOT_OTEL_FILE_EXPORTER_PATH", Some("/tmp/x.jsonl")),
            ("COPILOT_OTEL_DEDUP", None),
            ("COPILOT_PREFER_OTEL", None),
        ]);
        assert_eq!(
            legacy_otel_env_vars_in_use(),
            vec!["COPILOT_OTEL_FILE_EXPORTER_PATH"]
        );
        drop(_env);

        // All three set → all reported in declaration order.
        let _env = EnvScope::new(&[
            ("COPILOT_OTEL_FILE_EXPORTER_PATH", Some("/tmp/x.jsonl")),
            ("COPILOT_OTEL_DEDUP", Some("strict")),
            ("COPILOT_PREFER_OTEL", Some("1")),
        ]);
        assert_eq!(
            legacy_otel_env_vars_in_use(),
            vec![
                "COPILOT_OTEL_FILE_EXPORTER_PATH",
                "COPILOT_OTEL_DEDUP",
                "COPILOT_PREFER_OTEL",
            ]
        );
        drop(_env);

        // Whitespace-only value → treated as unset (matches the
        // COPILOT_CONFIG_DIR convention in `copilot_base_dir`).
        let _env = EnvScope::new(&[
            ("COPILOT_OTEL_FILE_EXPORTER_PATH", Some("   ")),
            ("COPILOT_OTEL_DEDUP", None),
            ("COPILOT_PREFER_OTEL", None),
        ]);
        assert!(
            legacy_otel_env_vars_in_use().is_empty(),
            "whitespace-only value should not count as set"
        );
    }

    #[test]
    #[cfg(unix)]
    fn copilot_config_dir_with_non_utf8_path_is_authoritative_not_silently_dropped() {
        // Regression: a non-UTF-8 directory path (legal on Unix) used to
        // fall through the `env::var(...).ok()` lossy String conversion
        // (`Err(NotUnicode)` → `None`), silently activating the
        // `~/.copilot` default — directly contradicting the
        // "override is authoritative" invariant documented on
        // `copilot_base_dir`. Now reads via `env::var_os` so non-UTF-8
        // values flow through unchanged.
        //
        // Hermetic: HOME is overridden to a temp dir that DOES contain
        // a `.copilot/session-state/<uuid>/events.jsonl` fixture. Under
        // the buggy code, the lossy `Err(NotUnicode) → None` path would
        // fall through to `~/.copilot` (= temp dir here), find the
        // fixture, and return a non-empty Vec — failing the assertion.
        // Under the fixed code the non-UTF-8 override is honored and
        // points at a nonexistent directory, so the result is empty.
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let _guard = acquire_env_test_lock();
        let home_fixture = fs_fixture!({
            ".copilot/session-state/sentinel/events.jsonl":
                "{\"sentinel\":\"would only be seen if the override silently fell through\"}\n",
        });
        let _env = EnvScope::new(&[
            ("HOME", Some(home_fixture.root().to_str().unwrap())),
            ("USERPROFILE", None),
            ("HOMEDRIVE", None),
            ("HOMEPATH", None),
            // EnvScope only accepts &str overrides for ergonomics; clear
            // the env var here so EnvScope captures the prior value and
            // will restore it on drop, then `set_var` the non-UTF-8
            // OsString directly below.
            (COPILOT_CONFIG_DIR_ENV, None),
        ]);
        let mut non_utf8 = b"/tmp/ccusage-test-".to_vec();
        non_utf8.extend_from_slice(b"\xff\xfe-non-utf8-dir-does-not-exist");
        let override_value = OsString::from_vec(non_utf8);
        env::set_var(COPILOT_CONFIG_DIR_ENV, &override_value);

        let paths = session_state_paths().unwrap();
        assert!(
            paths.is_empty(),
            "non-UTF-8 override at a nonexistent path must be honored as an \
             explicit override (yielding zero sources), not coerced to \
             'env unset' and silently fall back to ~/.copilot; got {paths:?}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn legacy_otel_env_var_with_non_utf8_value_is_still_reported() {
        // Regression mirror of the `env::var` → `env::var_os` fix in
        // `copilot_base_dir`: if a user (or test harness) sets one of
        // the deprecated OTel env vars to a non-UTF-8 byte sequence,
        // the deprecation warning MUST still fire. The previous
        // `env::var(name).ok()` flow would silently coerce
        // `Err(NotUnicode)` to `None` and report the var as unset.
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let _guard = acquire_env_test_lock();
        let _env = EnvScope::new(&[
            ("COPILOT_OTEL_FILE_EXPORTER_PATH", None),
            ("COPILOT_OTEL_DEDUP", None),
            ("COPILOT_PREFER_OTEL", None),
        ]);
        let mut non_utf8 = b"/tmp/otel-".to_vec();
        non_utf8.extend_from_slice(b"\xff\xfe-non-utf8.jsonl");
        env::set_var(
            "COPILOT_OTEL_FILE_EXPORTER_PATH",
            OsString::from_vec(non_utf8),
        );

        assert_eq!(
            legacy_otel_env_vars_in_use(),
            vec!["COPILOT_OTEL_FILE_EXPORTER_PATH"],
            "non-UTF-8 value must still be detected as set (deprecation \
             warning would otherwise silently skip it)",
        );
    }
}
