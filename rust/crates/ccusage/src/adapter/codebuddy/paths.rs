use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
};

use crate::Result;

const CODEBUDDY_DIR_ENV: &str = "CODEBUDDY_DIR";

pub(super) fn paths(custom_path: Option<&str>) -> Vec<PathBuf> {
    if let Some(custom_path) = custom_path.filter(|path| !path.trim().is_empty()) {
        return existing_path_list(custom_path);
    }
    if let Ok(env_paths) = env::var(CODEBUDDY_DIR_ENV) {
        if !env_paths.trim().is_empty() {
            return existing_path_list(&env_paths);
        }
    }
    let Some(home) = crate::home::home_dir() else {
        return Vec::new();
    };
    let default = home.join(".codebuddy").join("projects");
    if default.is_dir() {
        vec![default]
    } else {
        Vec::new()
    }
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

pub(super) fn collect_session_files(root: &Path) -> Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_session_files_inner(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_session_files_inner(path: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let entry_path = entry.path();
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            // Skip the per-session memory/ subdirectory — it holds
            // session-local working state, not assistant transcripts.
            if entry_path.file_name().and_then(|n| n.to_str()) == Some("memory") {
                continue;
            }
            collect_session_files_inner(&entry_path, files)?;
            continue;
        }
        if file_type.is_file()
            && entry_path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_codebuddy_session_file)
        {
            files.push(entry_path);
        }
    }
    Ok(())
}

fn is_codebuddy_session_file(name: &str) -> bool {
    // CodeBuddy uses plain ".jsonl" — no archived suffixes like
    // OpenClaw's ".jsonl.deleted.*" / ".jsonl.reset.*" are produced
    // by CodeBuddy on observed installs.
    name.ends_with(".jsonl")
}

#[cfg(test)]
mod tests {
    use super::*;
    use ccusage_test_support::fs_fixture;

    #[test]
    fn defaults_to_codebuddy_projects_dir() {
        // With no flag and no env var, paths(None) should target $HOME/.codebuddy/projects.
        // We verify by comparing to the actual home dir lookup. If the directory exists on the
        // host, paths(None) returns [it]; otherwise []. Either way, the value should be the
        // same as what crate::home::home_dir().unwrap().join(".codebuddy").join("projects")
        // would yield, after the is_dir() filter.
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let saved = env::var(CODEBUDDY_DIR_ENV).ok();
        env::remove_var(CODEBUDDY_DIR_ENV);

        let result = paths(None);
        let expected = crate::home::home_dir()
            .map(|h| h.join(".codebuddy").join("projects"))
            .filter(|p| p.is_dir())
            .map(|p| vec![p])
            .unwrap_or_default();
        assert_eq!(result, expected);

        if let Some(value) = saved {
            env::set_var(CODEBUDDY_DIR_ENV, value);
        }
    }

    #[test]
    fn custom_path_overrides_default() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let saved = env::var(CODEBUDDY_DIR_ENV).ok();
        // Set env to something distinct so we can prove flag wins; this is also covered
        // separately by flag_overrides_env_var, but exercising it here makes the test
        // self-contained.
        env::set_var(CODEBUDDY_DIR_ENV, "/this/should/not/win");

        let fixture = fs_fixture!({});
        let custom = fixture.root().to_str().unwrap().to_string();
        let result = paths(Some(&custom));

        assert_eq!(result, vec![fixture.root().to_path_buf()]);

        if let Some(value) = saved {
            env::set_var(CODEBUDDY_DIR_ENV, value);
        } else {
            env::remove_var(CODEBUDDY_DIR_ENV);
        }
    }

    #[test]
    fn env_var_overrides_default_when_no_flag() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let saved = env::var(CODEBUDDY_DIR_ENV).ok();

        let fixture = fs_fixture!({});
        env::set_var(CODEBUDDY_DIR_ENV, fixture.root());
        let result = paths(None);

        assert_eq!(result, vec![fixture.root().to_path_buf()]);

        if let Some(value) = saved {
            env::set_var(CODEBUDDY_DIR_ENV, value);
        } else {
            env::remove_var(CODEBUDDY_DIR_ENV);
        }
    }

    #[test]
    fn flag_overrides_env_var() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let saved = env::var(CODEBUDDY_DIR_ENV).ok();

        let env_dir = fs_fixture!({});
        let flag_dir = fs_fixture!({});
        env::set_var(CODEBUDDY_DIR_ENV, env_dir.root());
        let result = paths(Some(flag_dir.root().to_str().unwrap()));

        assert_eq!(result, vec![flag_dir.root().to_path_buf()]);

        if let Some(value) = saved {
            env::set_var(CODEBUDDY_DIR_ENV, value);
        } else {
            env::remove_var(CODEBUDDY_DIR_ENV);
        }
    }

    #[test]
    fn comma_separated_paths() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let saved = env::var(CODEBUDDY_DIR_ENV).ok();
        env::remove_var(CODEBUDDY_DIR_ENV);

        let a = fs_fixture!({});
        let b = fs_fixture!({});
        let c = fs_fixture!({});
        // duplicate `a` in the list to verify de-dup
        let raw = format!(
            "{},{},{},{}",
            a.root().display(),
            b.root().display(),
            c.root().display(),
            a.root().display(),
        );
        let result = paths(Some(&raw));

        assert_eq!(result.len(), 3);
        assert!(result.contains(&a.root().to_path_buf()));
        assert!(result.contains(&b.root().to_path_buf()));
        assert!(result.contains(&c.root().to_path_buf()));

        if let Some(value) = saved {
            env::set_var(CODEBUDDY_DIR_ENV, value);
        }
    }

    #[test]
    fn nonexistent_path_filtered_out() {
        let _guard = super::super::CODEBUDDY_DIR_LOCK.lock().unwrap();
        let saved = env::var(CODEBUDDY_DIR_ENV).ok();
        env::remove_var(CODEBUDDY_DIR_ENV);

        let real = fs_fixture!({});
        let raw = format!("{},/does/not/exist/anywhere", real.root().display());
        let result = paths(Some(&raw));

        assert_eq!(result, vec![real.root().to_path_buf()]);

        if let Some(value) = saved {
            env::set_var(CODEBUDDY_DIR_ENV, value);
        }
    }

    #[test]
    fn recurses_into_subagents_directory() {
        let fixture = fs_fixture!({
            "Users-example-proj/main-uuid.jsonl": "{}\n",
            "Users-example-proj/main-uuid/subagents/agent-aaa.jsonl": "{}\n",
            "Users-example-proj/main-uuid/subagents/agent-bbb.jsonl": "{}\n",
        });
        let files = collect_session_files(fixture.root()).unwrap();

        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 3, "expected 3 .jsonl files, got: {names:?}");
        assert!(names.contains(&"main-uuid.jsonl".to_string()));
        assert!(names.contains(&"agent-aaa.jsonl".to_string()));
        assert!(names.contains(&"agent-bbb.jsonl".to_string()));
    }

    #[test]
    fn does_not_descend_into_memory_directory() {
        let fixture = fs_fixture!({
            "Users-example-proj/main-uuid.jsonl": "{}\n",
            "Users-example-proj/main-uuid/memory/should_not_be_loaded.jsonl": "{}\n",
            "Users-example-proj/main-uuid/subagents/agent-aaa.jsonl": "{}\n",
        });
        let files = collect_session_files(fixture.root()).unwrap();

        let names: Vec<String> = files
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(files.len(), 2, "memory/ should be skipped, got: {names:?}");
        assert!(!names.contains(&"should_not_be_loaded.jsonl".to_string()));
        assert!(names.contains(&"main-uuid.jsonl".to_string()));
        assert!(names.contains(&"agent-aaa.jsonl".to_string()));
    }
}
