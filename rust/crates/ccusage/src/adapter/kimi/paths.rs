use std::{
    collections::HashSet,
    env,
    path::{Component, Path, PathBuf},
};

use crate::{collect_files_with_extension, Result};

pub(super) const KIMI_DATA_DIR_ENV: &str = "KIMI_DATA_DIR";
pub(super) const KIMI_SESSIONS_DIR_NAME: &str = "sessions";
pub(super) const KIMI_WIRE_FILE_NAME: &str = "wire.jsonl";

pub(super) fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(KIMI_DATA_DIR_ENV) {
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
        let path = home.join(".kimi");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub(super) fn discover_wire_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for kimi_path in paths()? {
        let sessions_path = kimi_path.join(KIMI_SESSIONS_DIR_NAME);
        let mut candidates = Vec::new();
        collect_files_with_extension(&sessions_path, "jsonl", &mut candidates);
        files.extend(
            candidates
                .into_iter()
                .filter(|file| is_kimi_wire_file(&sessions_path, file)),
        );
    }
    files.sort();
    files.dedup();
    Ok(files)
}

fn is_kimi_wire_file(sessions_path: &Path, file_path: &Path) -> bool {
    if file_path.file_name().and_then(|name| name.to_str()) != Some(KIMI_WIRE_FILE_NAME) {
        return false;
    }
    let Ok(relative) = file_path.strip_prefix(sessions_path) else {
        return false;
    };
    relative
        .components()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count()
        == 3
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
    fn discovers_wire_jsonl_files_under_sessions_group_session() {
        let _guard = super::super::KIMI_DATA_DIR_LOCK.lock().unwrap();
        let kimi_dir = temp_kimi_dir("discover");
        fs::create_dir_all(kimi_dir.join("sessions/group/session")).unwrap();
        fs::create_dir_all(kimi_dir.join("sessions/nested/path/session")).unwrap();
        fs::write(kimi_dir.join("sessions/group/session/wire.jsonl"), "{}\n").unwrap();
        fs::write(kimi_dir.join("sessions/group/session/other.jsonl"), "{}\n").unwrap();
        fs::write(
            kimi_dir.join("sessions/nested/path/session/wire.jsonl"),
            "{}\n",
        )
        .unwrap();
        env::set_var(KIMI_DATA_DIR_ENV, &kimi_dir);
        let files = discover_wire_files().unwrap();
        env::remove_var(KIMI_DATA_DIR_ENV);
        fs::remove_dir_all(&kimi_dir).unwrap();

        assert_eq!(
            files,
            vec![kimi_dir.join("sessions/group/session/wire.jsonl")]
        );
    }
}
