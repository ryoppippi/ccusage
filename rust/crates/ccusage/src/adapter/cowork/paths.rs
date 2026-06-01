use std::path::{Path, PathBuf};

use crate::Result;

#[allow(dead_code)]
pub(crate) fn cowork_paths() -> Result<Vec<PathBuf>> {
    if let Ok(env_paths) = std::env::var("COWORK_CONFIG_DIR") {
        return cowork_paths_from_env(&env_paths);
    }
    let home =
        crate::home::home_dir().ok_or_else(|| crate::cli_error("home directory is not set"))?;
    Ok(cowork_paths_from_root(
        &home.join("Library/Application Support/Claude/local-agent-mode-sessions"),
    ))
}

fn cowork_paths_from_env(env_paths: &str) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut seen = crate::fast::FxHashSet::default();
    for raw in env_paths
        .split(',')
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        let path = crate::adapter::claude::normalize_claude_config_path(raw);
        if path.join("projects").is_dir() {
            if seen.insert(path.clone()) {
                paths.push(path);
            }
            continue;
        }
        for discovered in cowork_paths_from_root(&path) {
            if seen.insert(discovered.clone()) {
                paths.push(discovered);
            }
        }
    }
    if paths.is_empty() {
        return Err(crate::cli_error(format!(
            "No valid Cowork data directories found in COWORK_CONFIG_DIR. Expected each path to be a Cowork local-agent-mode-sessions directory, a .claude config directory containing 'projects/', or the 'projects/' directory itself: {env_paths}"
        )));
    }
    Ok(paths)
}

pub(crate) fn cowork_paths_from_root(root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_cowork_paths(root, &mut paths);
    paths.sort_by_cached_key(|path| path.to_string_lossy().into_owned());
    paths
}

fn collect_cowork_paths(dir: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(std::result::Result::ok) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("local_"))
        {
            let config = path.join(".claude");
            if config.join("projects").is_dir() {
                paths.push(config);
            }
        }
        collect_cowork_paths(&path, paths);
    }
}

#[cfg(test)]
mod tests {
    use ccusage_test_support::fs_fixture;

    use super::cowork_paths_from_root;

    #[test]
    fn discovers_local_agent_mode_claude_config_dirs() {
        let fixture = fs_fixture!({
            "workspace-a/session-a/local_111/.claude/projects/project-a/session-a.jsonl": "",
            "workspace-a/session-a/local_222/.claude/projects/project-b/session-b.jsonl": "",
            "workspace-a/session-a/not-local/.claude/projects/project-c/session-c.jsonl": "",
            "workspace-b/session-b/local_333/no-claude/projects/project-d/session-d.jsonl": "",
        });

        let paths = cowork_paths_from_root(fixture.root());

        assert_eq!(
            paths,
            vec![
                fixture.path("workspace-a/session-a/local_111/.claude"),
                fixture.path("workspace-a/session-a/local_222/.claude"),
            ]
        );
    }

    #[test]
    fn accepts_direct_claude_and_projects_env_paths() {
        let fixture = fs_fixture!({
            "direct/.claude/projects/project-a/session-a.jsonl": "",
            "other/.claude/projects/project-b/session-b.jsonl": "",
        });

        let paths = super::cowork_paths_from_env(&format!(
            "{},{}",
            fixture.path("direct/.claude").display(),
            fixture.path("other/.claude/projects").display()
        ))
        .unwrap();

        assert_eq!(
            paths,
            vec![
                fixture.path("direct/.claude"),
                fixture.path("other/.claude"),
            ]
        );
    }

    #[test]
    fn rejects_invalid_cowork_env_paths() {
        let fixture = fs_fixture!({
            "empty": "",
        });

        let error = super::cowork_paths_from_env(&fixture.path("empty").display().to_string())
            .unwrap_err()
            .to_string();

        assert!(error.contains("No valid Cowork data directories found in COWORK_CONFIG_DIR"));
    }
}
