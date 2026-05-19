use std::io::{self, IsTerminal, Write};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum UsageLoadAgent {
    Claude,
    Codex,
    OpenCode,
    Amp,
    Pi,
    Copilot,
    Gemini,
    OpenClaw,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LoadProgressState {
    Loading,
    Succeeded,
    Failed,
}

pub(crate) fn should_show_usage_load_progress(json: bool, output_is_tty: bool) -> bool {
    !json && output_is_tty
}

fn agent_label(agent: UsageLoadAgent) -> &'static str {
    match agent {
        UsageLoadAgent::Claude => "Claude",
        UsageLoadAgent::Codex => "Codex",
        UsageLoadAgent::OpenCode => "OpenCode",
        UsageLoadAgent::Amp => "Amp",
        UsageLoadAgent::Pi => "pi-agent",
        UsageLoadAgent::Copilot => "GitHub Copilot CLI",
        UsageLoadAgent::Gemini => "Gemini CLI",
        UsageLoadAgent::OpenClaw => "OpenClaw",
    }
}

fn format_usage_load_progress_text(
    states: &[(UsageLoadAgent, LoadProgressState)],
    status: Option<&str>,
) -> String {
    let base = if states.is_empty() {
        "Loading usage logs".to_string()
    } else {
        let completed = states
            .iter()
            .filter(|(_, state)| !matches!(state, LoadProgressState::Loading))
            .count();
        let loading_agents = states
            .iter()
            .filter_map(|(agent, state)| {
                matches!(state, LoadProgressState::Loading).then_some(agent_label(*agent))
            })
            .collect::<Vec<_>>()
            .join(", ");
        if loading_agents.is_empty() {
            format!("Loading usage logs ({}/{})", completed, states.len())
        } else {
            format!(
                "Loading usage logs ({}/{}) :: {}",
                completed,
                states.len(),
                loading_agents
            )
        }
    };
    match status {
        Some(status) => format!("{status} :: {base}"),
        None => base,
    }
}

pub(crate) fn usage_load_output_is_tty() -> bool {
    io::stdout().is_terminal()
}

pub(crate) struct UsageLoadProgress {
    enabled: bool,
    status: Option<String>,
    states: Vec<(UsageLoadAgent, LoadProgressState)>,
}

impl UsageLoadProgress {
    pub(crate) fn new(enabled: bool) -> Self {
        Self {
            enabled,
            status: None,
            states: Vec::new(),
        }
    }

    pub(crate) fn start(&mut self, agent: UsageLoadAgent) {
        self.set_state(agent, LoadProgressState::Loading);
    }

    pub(crate) fn succeed(&mut self, agent: UsageLoadAgent) {
        self.set_state(agent, LoadProgressState::Succeeded);
    }

    pub(crate) fn fail(&mut self, agent: UsageLoadAgent) {
        self.set_state(agent, LoadProgressState::Failed);
    }

    pub(crate) fn stop(&mut self) {
        if self.enabled && !self.states.is_empty() {
            let _ = write!(io::stderr(), "\r\x1b[2K");
            let _ = io::stderr().flush();
        }
        self.status = None;
        self.states.clear();
    }

    fn set_state(&mut self, agent: UsageLoadAgent, state: LoadProgressState) {
        if let Some((_, current)) = self
            .states
            .iter_mut()
            .find(|(current_agent, _)| *current_agent == agent)
        {
            *current = state;
        } else {
            self.states.push((agent, state));
        }
        self.refresh();
    }

    fn refresh(&self) {
        if !self.enabled {
            return;
        }
        let text = format_usage_load_progress_text(&self.states, self.status.as_deref());
        let _ = write!(io::stderr(), "\r\x1b[2K{text}");
        let _ = io::stderr().flush();
    }
}

impl Drop for UsageLoadProgress {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) fn track_usage_load<T, E>(
    agent: UsageLoadAgent,
    json: bool,
    load: impl FnOnce() -> std::result::Result<T, E>,
) -> std::result::Result<T, E> {
    let enabled = crate::log_level() != Some(0)
        && should_show_usage_load_progress(json, usage_load_output_is_tty());
    let mut progress = UsageLoadProgress::new(enabled);
    progress.start(agent);
    let result = load();
    match &result {
        Ok(_) => progress.succeed(agent),
        Err(_) => progress.fail(agent),
    }
    progress.stop();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_active_agent_progress_with_completed_count() {
        let states = [
            (UsageLoadAgent::Claude, LoadProgressState::Succeeded),
            (UsageLoadAgent::Codex, LoadProgressState::Loading),
            (UsageLoadAgent::OpenCode, LoadProgressState::Loading),
        ];

        assert_eq!(
            format_usage_load_progress_text(&states, None),
            "Loading usage logs (1/3) :: Codex, OpenCode"
        );
    }

    #[test]
    fn includes_pricing_status_in_progress_text() {
        let states = [
            (UsageLoadAgent::Claude, LoadProgressState::Loading),
            (UsageLoadAgent::Codex, LoadProgressState::Loading),
        ];

        assert_eq!(
            format_usage_load_progress_text(
                &states,
                Some("Fetching latest model pricing from LiteLLM...")
            ),
            "Fetching latest model pricing from LiteLLM... :: Loading usage logs (0/2) :: Claude, Codex"
        );
    }

    #[test]
    fn hides_progress_for_json_or_non_tty_output() {
        assert!(!should_show_usage_load_progress(true, true));
        assert!(!should_show_usage_load_progress(false, false));
        assert!(should_show_usage_load_progress(false, true));
    }
}
