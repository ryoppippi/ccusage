use std::{collections::HashSet, env, path::PathBuf};

use crate::Result;

pub(super) const GOOSE_PATH_ROOT_ENV: &str = "GOOSE_PATH_ROOT";
pub(super) const GOOSE_DB_FILE_NAME: &str = "sessions.db";

pub(super) fn goose_db_paths() -> Result<Vec<PathBuf>> {
    let candidates = if let Ok(root) = env::var(GOOSE_PATH_ROOT_ENV) {
        let root = root.trim();
        if root.is_empty() {
            default_goose_db_candidates()?
        } else {
            vec![PathBuf::from(root)
                .join("data")
                .join("sessions")
                .join(GOOSE_DB_FILE_NAME)]
        }
    } else {
        default_goose_db_candidates()?
    };

    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for path in candidates {
        let path = path.canonicalize().unwrap_or(path);
        if path.is_file() && seen.insert(path.clone()) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn default_goose_db_candidates() -> Result<Vec<PathBuf>> {
    let home =
        crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
    Ok(vec![
        home.join(".local/share/goose/sessions")
            .join(GOOSE_DB_FILE_NAME),
        home.join("Library/Application Support/goose/sessions")
            .join(GOOSE_DB_FILE_NAME),
        home.join(".local/share/Block/goose/sessions")
            .join(GOOSE_DB_FILE_NAME),
    ])
}

#[cfg(test)]
mod tests {
    use std::{
        env, fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("ccusage-goose-{name}-{nanos}"))
    }

    #[test]
    fn discovers_goose_path_root_database() {
        let dir = temp_dir("path-root");
        let db_dir = dir.join("data/sessions");
        fs::create_dir_all(&db_dir).unwrap();
        let db_path = db_dir.join(GOOSE_DB_FILE_NAME);
        fs::write(&db_path, "").unwrap();
        env::set_var(GOOSE_PATH_ROOT_ENV, &dir);

        let paths = goose_db_paths().unwrap();
        env::remove_var(GOOSE_PATH_ROOT_ENV);
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(paths.len(), 1);
        assert!(paths[0].ends_with(Path::new("data/sessions/sessions.db")));
    }
}
