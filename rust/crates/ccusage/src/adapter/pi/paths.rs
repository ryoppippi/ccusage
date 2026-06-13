use std::{collections::HashSet, env, path::PathBuf};

use crate::Result;

const PI_AGENT_DIR_ENV: &str = "PI_AGENT_DIR";

pub(super) fn paths(custom_path: Option<&str>) -> Result<Vec<PathBuf>> {
    if let Some(custom_path) = custom_path.filter(|path| !path.trim().is_empty()) {
        return Ok(existing_path_list(custom_path));
    }
    if let Ok(env_paths) = env::var(PI_AGENT_DIR_ENV)
        && !env_paths.trim().is_empty()
    {
        return Ok(existing_path_list(&env_paths));
    }

    let home =
        crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
    let path = home.join(".pi/agent/sessions");
    Ok(path.is_dir().then_some(path).into_iter().collect())
}

fn existing_path_list(raw: &str) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    raw.split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_dir() && seen.insert(path.clone()))
        .collect()
}
