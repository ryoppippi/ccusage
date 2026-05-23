use std::{env, fs, path::PathBuf};

use crate::cli::CodexSpeed;

pub(crate) fn resolve_codex_speed(requested: CodexSpeed) -> CodexSpeed {
    match requested {
        CodexSpeed::Auto => {
            if detect_codex_fast_service_tier() {
                CodexSpeed::Fast
            } else {
                CodexSpeed::Standard
            }
        }
        speed => speed,
    }
}

fn detect_codex_fast_service_tier() -> bool {
    codex_home_paths().iter().any(|path| {
        fs::read_to_string(path.join("config.toml"))
            .ok()
            .is_some_and(|content| codex_config_requests_fast_service_tier(&content))
    })
}

fn codex_home_paths() -> Vec<PathBuf> {
    if let Ok(paths) = env::var("CODEX_HOME") {
        return paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect();
    }
    crate::home::home_dir()
        .map(|home| vec![home.join(".codex")])
        .unwrap_or_default()
}

fn codex_config_requests_fast_service_tier(content: &str) -> bool {
    content.lines().any(|line| {
        let setting = line.split('#').next().unwrap_or_default().trim();
        setting.starts_with("service_tier")
            && (setting.contains("fast") || setting.contains("priority"))
    })
}
