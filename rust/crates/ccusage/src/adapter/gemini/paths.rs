use std::{collections::HashSet, env, path::PathBuf};

use crate::{collect_files_with_extension, Result};

pub(super) const GEMINI_DATA_DIR_ENV: &str = "GEMINI_DATA_DIR";

pub(super) fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(GEMINI_DATA_DIR_ENV) {
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
        let path = home.join(".gemini").join("tmp");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub(super) fn discover_log_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for path in paths()? {
        collect_files_with_extension(&path, "json", &mut files);
        collect_files_with_extension(&path, "jsonl", &mut files);
    }
    files.sort();
    files.dedup();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use std::{env, fs, path::PathBuf};

    use super::*;

    fn temp_gemini_dir(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("ccusage-gemini-{name}-{nanos}"));
        path
    }

    #[test]
    fn discovers_json_and_jsonl_logs() {
        let _guard = super::super::GEMINI_DATA_DIR_LOCK.lock().unwrap();
        let gemini_dir = temp_gemini_dir("discover");
        fs::create_dir_all(gemini_dir.join("chats")).unwrap();
        fs::write(gemini_dir.join("chats/a.json"), "{}").unwrap();
        fs::write(gemini_dir.join("chats/b.jsonl"), "{}\n").unwrap();
        fs::write(gemini_dir.join("chats/ignore.txt"), "no").unwrap();
        env::set_var(GEMINI_DATA_DIR_ENV, &gemini_dir);
        let files = discover_log_files().unwrap();
        env::remove_var(GEMINI_DATA_DIR_ENV);
        fs::remove_dir_all(&gemini_dir).unwrap();

        assert_eq!(
            files,
            vec![
                gemini_dir.join("chats/a.json"),
                gemini_dir.join("chats/b.jsonl")
            ]
        );
    }
}
