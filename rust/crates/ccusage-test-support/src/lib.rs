use std::{
    fs,
    path::{Path, PathBuf},
};

use assert_fs::{
    fixture::{ChildPath, FileWriteStr, PathChild, PathCreateDir},
    TempDir,
};

pub struct Fixture {
    dir: TempDir,
}

impl Fixture {
    pub fn new() -> Self {
        Self {
            dir: TempDir::new().expect("failed to create temporary fixture directory"),
        }
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    #[must_use]
    pub fn path(&self, path: impl AsRef<Path>) -> PathBuf {
        self.dir.path().join(path)
    }

    pub fn child(&self, path: impl AsRef<Path>) -> ChildPath {
        self.dir.child(path)
    }

    #[must_use]
    pub fn write_file(&self, path: impl AsRef<Path>, contents: impl AsRef<str>) -> PathBuf {
        let child = self.child(path);
        if let Some(parent) = child.path().parent() {
            fs::create_dir_all(parent).expect("failed to create fixture file parent directory");
        }
        child
            .write_str(contents.as_ref())
            .expect("failed to write fixture file");
        child.path().to_path_buf()
    }

    #[must_use]
    pub fn create_dir_all(&self, path: impl AsRef<Path>) -> PathBuf {
        let child = self.child(path);
        child
            .create_dir_all()
            .expect("failed to create fixture directory");
        child.path().to_path_buf()
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

#[macro_export]
macro_rules! fs_fixture {
    ({ $($path:literal : $contents:expr),* $(,)? }) => {{
        let fixture = $crate::Fixture::new();
        $(
            let _ = fixture.write_file($path, $contents);
        )*
        fixture
    }};
}

/// Process-wide test mutex for serializing env-mutating tests across the
/// entire `ccusage` test binary. Cargo runs unit tests in parallel within
/// a single process, and `std::env::set_var`/`remove_var` are NOT
/// thread-safe (they mutate process-global state and can race with any
/// concurrent `std::env::var` read, possibly causing UB on some libcs).
///
/// EVERY test that calls `EnvScope::new` (or `std::env::set_var` /
/// `remove_var` directly) MUST hold this mutex for the duration of the
/// env-touching scope. A per-module local `Mutex<()>` does NOT provide
/// the required cross-module serialization — two tests in different
/// modules each holding their own local mutex still race on the shared
/// process environment.
///
/// Acquire as `let _guard = acquire_env_test_lock();` at the top of any
/// env-mutating test. The helper recovers from poison so a panic in one
/// env test does not cascade-poison every subsequent env test in the same
/// process. Tests holding this lock are still safe to run concurrently
/// with non-env tests.
pub static ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire `ENV_TEST_LOCK` with poison recovery. If a previous test
/// panicked while holding the lock, `Mutex::lock` returns `Err(Poisoned)`
/// and a naive `.unwrap()` would panic in every subsequent env test in
/// the same process — masking the real failure under a cascade of
/// "poisoned" panics. Recovering via `into_inner()` lets the next test
/// run normally so its own assertions stay visible.
pub fn acquire_env_test_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// RAII helper for snapshot-and-restore of process environment variables in
/// tests. On construction, sets each `(key, value)` override (or `unset`s when
/// `value` is `None`), recording the previous value. On drop, restores every
/// previous value (`set_var` if it was `Some`, `remove_var` if it was `None`).
///
/// Callers MUST hold [`ENV_TEST_LOCK`] for the entire scope's lifetime
/// because `std::env::set_var` is not thread-safe when other threads are
/// concurrently reading `std::env`.
pub struct EnvScope {
    // OsString (not String) so non-UTF-8 env values round-trip losslessly.
    // The previous helper used `std::env::var(key).ok()` which silently
    // turns `Err(NotUnicode(..))` into `None` and would `remove_var` the
    // key on drop — silently destroying the original value.
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl EnvScope {
    /// Apply each `(key, override)` to the process environment, snapshotting
    /// the prior value. `Some(v)` calls `set_var(key, v)`; `None` calls
    /// `remove_var(key)`.
    pub fn new(overrides: &[(&'static str, Option<&str>)]) -> Self {
        let mut previous = Vec::with_capacity(overrides.len());
        for (key, value) in overrides {
            previous.push((*key, std::env::var_os(key)));
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
        Self { previous }
    }
}

impl Drop for EnvScope {
    fn drop(&mut self) {
        // Restore in REVERSE insertion order. If the same env var key
        // appeared in `overrides` more than once, `previous` recorded the
        // original value first and the intermediate override(s) after; a
        // forward drop would restore the original first and then overwrite
        // it with an intermediate, leaking polluted state past the scope.
        // Reverse order ensures the very first snapshot (the original
        // value) is restored last and wins, returning the process env to
        // the pre-`new` state regardless of duplicate keys.
        for (key, value) in self.previous.drain(..).rev() {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::{acquire_env_test_lock, fs_fixture, EnvScope};

    #[test]
    fn creates_inline_fixture_tree() {
        let fixture = fs_fixture!({
            "projects/example/session.jsonl": "{}\n",
        });

        assert_eq!(
            std::fs::read_to_string(fixture.path("projects/example/session.jsonl")).unwrap(),
            "{}\n"
        );
    }

    #[test]
    fn creates_incremental_fixture_tree() {
        let fixture = fs_fixture!({});
        let _ = fixture.write_file("projects/example/session/chat.jsonl", "{}\n");

        assert!(fixture
            .path("projects/example/session/chat.jsonl")
            .is_file());
    }

    #[test]
    fn env_scope_restores_original_value_when_same_key_appears_twice() {
        // Regression pin: a forward-order drop would restore the original
        // first and then overwrite it with the intermediate override,
        // leaking polluted state past the scope. Reverse drop must restore
        // the original last and win.
        const KEY: &str = "CCUSAGE_TEST_ENV_SCOPE_DUPLICATE_KEY";
        let _guard = acquire_env_test_lock();
        // Snapshot whatever was set before the test (almost certainly unset)
        // and restore it after, so this test is hermetic even when the env
        // var is somehow set by an external runner.
        let pre_test = std::env::var_os(KEY);
        std::env::set_var(KEY, "ORIGINAL");
        {
            let _scope = EnvScope::new(&[(KEY, Some("INTERMEDIATE")), (KEY, Some("FINAL"))]);
            assert_eq!(std::env::var(KEY).ok().as_deref(), Some("FINAL"));
        }
        assert_eq!(
            std::env::var(KEY).ok().as_deref(),
            Some("ORIGINAL"),
            "EnvScope must restore the pre-`new` value, not the intermediate override",
        );
        match pre_test {
            Some(v) => std::env::set_var(KEY, v),
            None => std::env::remove_var(KEY),
        }
    }

    #[test]
    fn env_scope_unsets_key_that_was_originally_absent() {
        const KEY: &str = "CCUSAGE_TEST_ENV_SCOPE_ABSENT_KEY";
        let _guard = acquire_env_test_lock();
        let pre_test = std::env::var_os(KEY);
        std::env::remove_var(KEY);
        {
            let _scope = EnvScope::new(&[(KEY, Some("SET-INSIDE-SCOPE"))]);
            assert_eq!(std::env::var(KEY).ok().as_deref(), Some("SET-INSIDE-SCOPE"));
        }
        assert!(
            std::env::var(KEY).is_err(),
            "EnvScope must remove the key when it was absent before `new`",
        );
        if let Some(v) = pre_test {
            std::env::set_var(KEY, v);
        }
    }

    #[test]
    fn env_scope_round_trips_non_utf8_original_values() {
        // Regression pin: the helper used to snapshot via
        // `std::env::var(key).ok()` which silently coerces
        // `Err(NotUnicode(..))` into `None` — so on drop a non-UTF-8
        // original would be `remove_var`'d instead of restored, silently
        // destroying the original value. Now stores `OsString` and uses
        // `std::env::var_os` for a lossless round-trip.
        use std::ffi::OsStr;
        #[cfg(unix)]
        use std::os::unix::ffi::OsStrExt;

        const KEY: &str = "CCUSAGE_TEST_ENV_SCOPE_NON_UTF8";
        let _guard = acquire_env_test_lock();
        let pre_test = std::env::var_os(KEY);

        #[cfg(unix)]
        let non_utf8: &OsStr = OsStr::from_bytes(b"\xff\xfe-not-utf8");
        // Windows OsStr round-trips arbitrary UTF-16 but constructing a
        // surrogate-pair invalid sequence here is awkward; pin the simpler
        // round-trip property (UTF-8 inputs stay intact) on non-unix
        // targets and rely on the OsString storage doing the lossless
        // work on unix where the bug is reproducible from a stable API.
        #[cfg(not(unix))]
        let non_utf8: &OsStr = OsStr::new("placeholder-fallback");

        std::env::set_var(KEY, non_utf8);
        let original = std::env::var_os(KEY).expect("set just above");
        {
            let _scope = EnvScope::new(&[(KEY, Some("temporary-override"))]);
            assert_eq!(
                std::env::var(KEY).ok().as_deref(),
                Some("temporary-override")
            );
        }
        assert_eq!(
            std::env::var_os(KEY),
            Some(original),
            "EnvScope must round-trip the original non-UTF-8 value losslessly",
        );
        match pre_test {
            Some(v) => std::env::set_var(KEY, v),
            None => std::env::remove_var(KEY),
        }
    }
}
