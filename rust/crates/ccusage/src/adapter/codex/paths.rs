use std::{env, path::PathBuf};

use crate::{cli_error, fast::FxHashSet, home, Result};

pub(super) fn codex_usage_paths() -> Result<Vec<PathBuf>> {
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
