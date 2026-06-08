use std::{env, path::PathBuf};

use crate::{cli_error, fast::FxHashSet, home, Result};

pub(super) fn codex_usage_paths() -> Result<Vec<PathBuf>> {
    Ok(codex_usage_paths_from_homes(codex_home_paths()?))
}

fn codex_usage_paths_from_homes(homes: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut seen = FxHashSet::default();
    for path in homes {
        let sessions = path.join("sessions");
        let archived_sessions = path.join("archived_sessions");
        let mut found_usage_dir = false;
        if sessions.is_dir() {
            if seen.insert(sessions.clone()) {
                paths.push(sessions);
            }
            found_usage_dir = true;
        }
        if archived_sessions.is_dir() {
            if seen.insert(archived_sessions.clone()) {
                paths.push(archived_sessions);
            }
            found_usage_dir = true;
        }
        if !found_usage_dir && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    paths
}

pub(super) fn codex_home_paths() -> Result<Vec<PathBuf>> {
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

#[cfg(test)]
mod tests {
    use super::*;

    use ccusage_test_support::Fixture;

    #[test]
    fn includes_archived_sessions_next_to_sessions() {
        let fixture = Fixture::new();
        let _ = fixture.create_dir_all("codex/sessions");
        let _ = fixture.create_dir_all("codex/archived_sessions");

        let paths = codex_usage_paths_from_homes(vec![fixture.path("codex")]);

        assert_eq!(
            paths,
            vec![
                fixture.path("codex/sessions"),
                fixture.path("codex/archived_sessions"),
            ]
        );
    }

    #[test]
    fn uses_sessions_without_missing_archived_sessions_path() {
        let fixture = Fixture::new();
        let _ = fixture.create_dir_all("codex/sessions");

        let paths = codex_usage_paths_from_homes(vec![fixture.path("codex")]);

        assert_eq!(paths, vec![fixture.path("codex/sessions")]);
    }

    #[test]
    fn uses_archived_sessions_without_direct_path_fallback() {
        let fixture = Fixture::new();
        let _ = fixture.create_dir_all("codex/archived_sessions");

        let paths = codex_usage_paths_from_homes(vec![fixture.path("codex")]);

        assert_eq!(paths, vec![fixture.path("codex/archived_sessions")]);
    }

    #[test]
    fn falls_back_to_direct_path_when_no_session_directories_exist() {
        let fixture = Fixture::new();
        let home = fixture.create_dir_all("codex");

        let paths = codex_usage_paths_from_homes(vec![home.clone()]);

        assert_eq!(paths, vec![home]);
    }

    #[test]
    fn deduplicates_usage_paths_across_repeated_homes() {
        let fixture = Fixture::new();
        let home = fixture.create_dir_all("codex");
        let _ = fixture.create_dir_all("codex/sessions");

        let paths = codex_usage_paths_from_homes(vec![home.clone(), home]);

        assert_eq!(paths, vec![fixture.path("codex/sessions")]);
    }
}
