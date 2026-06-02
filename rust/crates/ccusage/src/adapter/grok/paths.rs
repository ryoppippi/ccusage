use std::{
    collections::HashSet,
    env,
    path::{Path, PathBuf},
};

use crate::{collect_files_with_extension, Result};

pub(super) const GROK_HOME_ENV: &str = "GROK_HOME";
const SESSIONS_DIR: &str = "sessions";
const SIGNALS_FILE: &str = "signals.json";

pub(super) fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(GROK_HOME_ENV) {
        for raw in env_paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
        {
            let path = PathBuf::from(raw);
            if path.is_dir() && seen.insert(path.clone()) {
                paths.push(path);
            }
        }
        return Ok(paths);
    }

    if let Some(home) = crate::home::home_dir() {
        let path = home.join(".grok");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub(super) fn discover_signal_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for grok_home in paths()? {
        let sessions_path = grok_home.join(SESSIONS_DIR);
        let mut candidates = Vec::new();
        collect_files_with_extension(&sessions_path, "json", &mut candidates);
        files.extend(candidates.into_iter().filter(|file| is_signals_file(file)));
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn is_signals_file(file_path: &Path) -> bool {
    file_path.file_name().and_then(|name| name.to_str()) == Some(SIGNALS_FILE)
}

#[cfg(test)]
mod tests {
    use std::{env, ffi::OsString, path::Path};

    use ccusage_test_support::fs_fixture;

    use super::*;

    struct EnvDirGuard {
        previous: Option<OsString>,
    }

    impl EnvDirGuard {
        fn set(dir: &Path) -> Self {
            let previous = env::var_os(GROK_HOME_ENV);
            env::set_var(GROK_HOME_ENV, dir);
            Self { previous }
        }
    }

    impl Drop for EnvDirGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                env::set_var(GROK_HOME_ENV, previous);
            } else {
                env::remove_var(GROK_HOME_ENV);
            }
        }
    }

    #[test]
    fn discovers_signal_files_under_grok_sessions() {
        let _guard = super::super::GROK_HOME_LOCK.lock().unwrap();
        let fixture = fs_fixture!({
            "sessions/%2Fworkspace/project/session-a/signals.json": "{}",
            "sessions/%2Fworkspace/project/session-a/summary.json": "{}",
            "sessions/%2Fworkspace/project/session-b/events.jsonl": "{}\n",
        });
        let _cleanup = EnvDirGuard::set(fixture.root());
        let files = discover_signal_files().unwrap();

        assert_eq!(
            files,
            vec![fixture.path("sessions/%2Fworkspace/project/session-a/signals.json")]
        );
    }
}
