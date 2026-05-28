use std::{collections::HashSet, env, path::PathBuf};

use crate::Result;

pub(super) const ANTIGRAVITY_DATA_DIR_ENV: &str = "ANTIGRAVITY_DATA_DIR";

pub(super) fn paths() -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    if let Ok(env_paths) = env::var(ANTIGRAVITY_DATA_DIR_ENV) {
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
        let path = home.join(".gemini").join("antigravity-cli");
        if path.is_dir() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub(super) fn discover_log_files() -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    for base_path in paths()? {
        let brain_path = base_path.join("brain");
        if brain_path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(brain_path) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let transcript = path
                            .join(".system_generated")
                            .join("logs")
                            .join("transcript.jsonl");
                        if transcript.is_file() {
                            files.push(transcript);
                        }
                    }
                }
            }
        }
    }
    files.sort();
    files.dedup();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccusage_test_support::fs_fixture;

    #[test]
    fn discovers_transcript_logs() {
        let _guard = super::super::ANTIGRAVITY_DATA_DIR_LOCK.lock().unwrap();
        let fixture = fs_fixture!({
            "brain/session-a/.system_generated/logs/transcript.jsonl": "{}\n",
            "brain/session-a/.system_generated/logs/transcript_full.jsonl": "{}\n",
            "brain/session-b/.system_generated/logs/transcript.jsonl": "{}\n",
            "brain/session-c/ignore.txt": "no",
        });
        let _env_guard = super::super::AntigravityDataDirEnvGuard::set(fixture.root());
        let files = discover_log_files().unwrap();

        assert_eq!(
            files,
            vec![
                fixture.path("brain/session-a/.system_generated/logs/transcript.jsonl"),
                fixture.path("brain/session-b/.system_generated/logs/transcript.jsonl")
            ]
        );
    }
}
