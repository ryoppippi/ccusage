use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use crate::cli::{
    BlocksArgs, CodexSpeed, CostMode, CostSource, DailyArgs, SharedArgs, SortOrder, StatuslineArgs,
    VisualBurnRate, WeekDay, WeeklyArgs,
};

struct ConfigCommand {
    raw: String,
    agent: Option<String>,
    report: String,
}

pub(crate) struct ConfigContext {
    value: Option<Value>,
    command: ConfigCommand,
}

impl ConfigContext {
    pub(crate) fn from_args(args: &[String]) -> Self {
        let command = detect_config_command(args);
        let value = load_config_value(scan_config_path(args).as_deref());
        Self { value, command }
    }

    fn option_maps(&self) -> Vec<&Map<String, Value>> {
        let mut maps = Vec::new();
        let Some(root) = self.value.as_ref().and_then(Value::as_object) else {
            return maps;
        };
        if let Some(defaults) = object_at(root, "defaults") {
            maps.push(defaults);
        }
        if let Some(commands) = object_at(root, "commands") {
            if let Some(raw) = object_at(commands, &self.command.raw) {
                maps.push(raw);
            }
            if self.command.agent.is_some() {
                if let Some(report) = object_at(commands, &self.command.report) {
                    maps.push(report);
                }
                if let Some(agent) = self.command.agent.as_deref() {
                    let colon_name = format!("{agent}:{}", self.command.report);
                    if let Some(agent_report) = object_at(commands, &colon_name) {
                        maps.push(agent_report);
                    }
                }
            }
        }
        if let Some(agent) = self
            .command
            .agent
            .as_deref()
            .and_then(|agent| object_at(root, agent))
        {
            if let Some(defaults) = object_at(agent, "defaults") {
                maps.push(defaults);
            }
            if let Some(command) = object_at(agent, "commands")
                .and_then(|commands| object_at(commands, &self.command.report))
            {
                maps.push(command);
            }
        }
        maps
    }
}

fn object_at<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Map<String, Value>> {
    object.get(key).and_then(Value::as_object)
}

fn load_config_value(path: Option<&Path>) -> Option<Value> {
    let paths = match path {
        Some(path) => vec![path.to_path_buf()],
        None => discover_config_paths(),
    };
    paths
        .into_iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .filter_map(|content| serde_json::from_str::<Value>(&content).ok())
        .find(|value| value.as_object().is_some())
}

fn discover_config_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        paths.push(cwd.join(".ccusage").join("ccusage.json"));
    }
    paths.extend(
        claude_config_dirs()
            .into_iter()
            .map(|dir| dir.join("ccusage.json")),
    );
    paths
}

fn claude_config_dirs() -> Vec<PathBuf> {
    if let Ok(paths) = env::var("CLAUDE_CONFIG_DIR") {
        return paths
            .split(',')
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .collect();
    }
    crate::home::home_dir()
        .map(|home| vec![home.join(".config").join("claude"), home.join(".claude")])
        .unwrap_or_default()
}

fn scan_config_path(args: &[String]) -> Option<PathBuf> {
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some((flag, value)) = arg.split_once('=') {
            if flag == "--config" && !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        } else if arg == "--config" {
            return args.get(index + 1).map(PathBuf::from);
        }
        index += 1;
    }
    None
}

fn detect_config_command(args: &[String]) -> ConfigCommand {
    let tokens = command_tokens(args);
    let Some(first) = tokens.first() else {
        return ConfigCommand {
            raw: "daily".to_string(),
            agent: None,
            report: "daily".to_string(),
        };
    };
    if let Some((agent, report)) = first.split_once(':') {
        return ConfigCommand {
            raw: format!("{agent} {report}"),
            agent: Some(agent.to_string()),
            report: report.to_string(),
        };
    }
    if is_agent_command(first) {
        let report = tokens
            .get(1)
            .filter(|token| is_report_command(token))
            .cloned()
            .unwrap_or_else(|| "daily".to_string());
        return ConfigCommand {
            raw: format!("{first} {report}"),
            agent: Some(first.clone()),
            report,
        };
    }
    ConfigCommand {
        raw: first.clone(),
        agent: None,
        report: first.clone(),
    }
}

fn command_tokens(args: &[String]) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if let Some((flag, _)) = arg.split_once('=') {
            if flag.starts_with('-') {
                index += 1;
                continue;
            }
        }
        if arg.starts_with('-') {
            index += if option_takes_value(arg) { 2 } else { 1 };
            continue;
        }
        tokens.push(arg.clone());
        index += 1;
    }
    tokens
}

fn option_takes_value(arg: &str) -> bool {
    matches!(
        arg.split_once('=').map_or(arg, |(name, _)| name),
        "-s" | "--since"
            | "-u"
            | "--until"
            | "-m"
            | "--mode"
            | "--debug-samples"
            | "-o"
            | "--order"
            | "-z"
            | "--timezone"
            | "-q"
            | "--jq"
            | "--config"
            | "-t"
            | "--token-limit"
            | "-n"
            | "--session-length"
            | "-w"
            | "--start-of-week"
            | "-p"
            | "--project"
            | "--project-aliases"
            | "--pi-path"
            | "--speed"
            | "-B"
            | "--visual-burn-rate"
            | "--cost-source"
            | "--refresh-interval"
            | "--context-low-threshold"
            | "--context-medium-threshold"
    )
}

fn is_agent_command(command: &str) -> bool {
    matches!(command, "claude" | "codex" | "opencode" | "amp" | "pi")
}

fn is_report_command(command: &str) -> bool {
    matches!(
        command,
        "daily" | "monthly" | "weekly" | "session" | "blocks" | "statusline"
    )
}

pub(crate) fn apply_config_to_shared(shared: &mut SharedArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        for (key, value) in options {
            match key.as_str() {
                "since" => shared.since = string_value(value),
                "until" => shared.until = string_value(value),
                "json" => apply_bool(value, &mut shared.json),
                "mode" => {
                    if let Some(mode) =
                        string_value(value).and_then(|value| parse_cost_mode(&value))
                    {
                        shared.mode = mode;
                    }
                }
                "debug" => apply_bool(value, &mut shared.debug),
                "debugSamples" => {
                    if let Some(debug_samples) = usize_value(value) {
                        shared.debug_samples = debug_samples;
                    }
                }
                "order" => {
                    if let Some(order) =
                        string_value(value).and_then(|value| parse_sort_order(&value))
                    {
                        shared.order = order;
                    }
                }
                "breakdown" => apply_bool(value, &mut shared.breakdown),
                "offline" => apply_bool(value, &mut shared.offline),
                "noOffline" => apply_bool(value, &mut shared.no_offline),
                "color" => apply_bool(value, &mut shared.color),
                "noColor" => apply_bool(value, &mut shared.no_color),
                "timezone" => shared.timezone = string_value(value),
                "jq" => shared.jq = string_value(value),
                "compact" => apply_bool(value, &mut shared.compact),
                "singleThread" => apply_bool(value, &mut shared.single_thread),
                _ => {}
            }
        }
    }
}

pub(crate) fn apply_config_to_daily_args(args: &mut DailyArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        for (key, value) in options {
            match key.as_str() {
                "instances" => apply_bool(value, &mut args.instances),
                "project" => args.project = string_value(value),
                "projectAliases" => args.project_aliases = string_value(value),
                _ => {}
            }
        }
    }
}

pub(crate) fn apply_config_to_weekly_args(args: &mut WeeklyArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        if let Some(day) = options
            .get("startOfWeek")
            .and_then(string_value)
            .and_then(|value| parse_week_day(&value))
        {
            args.start_of_week = day;
        }
    }
}

pub(crate) fn apply_config_to_blocks_args(args: &mut BlocksArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        for (key, value) in options {
            match key.as_str() {
                "active" => apply_bool(value, &mut args.active),
                "recent" => apply_bool(value, &mut args.recent),
                "tokenLimit" => args.token_limit = string_value(value),
                "sessionLength" => {
                    if let Some(session_length) = f64_value(value) {
                        args.session_length = session_length;
                    }
                }
                _ => {}
            }
        }
    }
}

pub(crate) fn apply_config_to_statusline_args(args: &mut StatuslineArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        for (key, value) in options {
            match key.as_str() {
                "offline" => apply_bool(value, &mut args.offline),
                "noOffline" => apply_bool(value, &mut args.no_offline),
                "visualBurnRate" => {
                    if let Some(visual_burn_rate) =
                        string_value(value).and_then(|value| parse_visual_burn_rate(&value))
                    {
                        args.visual_burn_rate = visual_burn_rate;
                    }
                }
                "costSource" => {
                    if let Some(cost_source) =
                        string_value(value).and_then(|value| parse_cost_source(&value))
                    {
                        args.cost_source = cost_source;
                    }
                }
                "cache" => apply_bool(value, &mut args.cache),
                "noCache" => apply_bool(value, &mut args.no_cache),
                "refreshInterval" => {
                    if let Some(refresh_interval) = u64_value(value) {
                        args.refresh_interval = refresh_interval;
                    }
                }
                "contextLowThreshold" => {
                    if let Some(threshold) =
                        u64_value(value).and_then(|value| u8::try_from(value).ok())
                    {
                        args.context_low_threshold = threshold;
                    }
                }
                "contextMediumThreshold" => {
                    if let Some(threshold) =
                        u64_value(value).and_then(|value| u8::try_from(value).ok())
                    {
                        args.context_medium_threshold = threshold;
                    }
                }
                "debug" => apply_bool(value, &mut args.debug),
                _ => {}
            }
        }
    }
}

pub(crate) fn apply_config_to_agent_args(
    codex_speed: &mut CodexSpeed,
    mut pi_path: Option<&mut Option<String>>,
    config: &ConfigContext,
) {
    for options in config.option_maps() {
        for (key, value) in options {
            match key.as_str() {
                "speed" => {
                    if let Some(speed) =
                        string_value(value).and_then(|value| parse_codex_speed(&value))
                    {
                        *codex_speed = speed;
                    }
                }
                "piPath" => {
                    if let Some(pi_path) = pi_path.as_deref_mut() {
                        *pi_path = string_value(value);
                    }
                }
                _ => {}
            }
        }
    }
}

fn parse_cost_mode(value: &str) -> Option<CostMode> {
    match value {
        "auto" => Some(CostMode::Auto),
        "calculate" => Some(CostMode::Calculate),
        "display" => Some(CostMode::Display),
        _ => None,
    }
}

fn parse_sort_order(value: &str) -> Option<SortOrder> {
    match value {
        "asc" => Some(SortOrder::Asc),
        "desc" => Some(SortOrder::Desc),
        _ => None,
    }
}

fn parse_week_day(value: &str) -> Option<WeekDay> {
    match value {
        "sunday" => Some(WeekDay::Sunday),
        "monday" => Some(WeekDay::Monday),
        "tuesday" => Some(WeekDay::Tuesday),
        "wednesday" => Some(WeekDay::Wednesday),
        "thursday" => Some(WeekDay::Thursday),
        "friday" => Some(WeekDay::Friday),
        "saturday" => Some(WeekDay::Saturday),
        _ => None,
    }
}

fn parse_codex_speed(value: &str) -> Option<CodexSpeed> {
    match value {
        "auto" => Some(CodexSpeed::Auto),
        "standard" => Some(CodexSpeed::Standard),
        "fast" => Some(CodexSpeed::Fast),
        _ => None,
    }
}

fn parse_visual_burn_rate(value: &str) -> Option<VisualBurnRate> {
    match value {
        "off" => Some(VisualBurnRate::Off),
        "emoji" => Some(VisualBurnRate::Emoji),
        "text" => Some(VisualBurnRate::Text),
        "emoji-text" => Some(VisualBurnRate::EmojiText),
        _ => None,
    }
}

fn parse_cost_source(value: &str) -> Option<CostSource> {
    match value {
        "auto" => Some(CostSource::Auto),
        "ccusage" => Some(CostSource::Ccusage),
        "cc" => Some(CostSource::Cc),
        "both" => Some(CostSource::Both),
        _ => None,
    }
}

fn string_value(value: &Value) -> Option<String> {
    value.as_str().map(ToString::to_string)
}

fn usize_value(value: &Value) -> Option<usize> {
    value.as_u64().and_then(|value| usize::try_from(value).ok())
}

fn u64_value(value: &Value) -> Option<u64> {
    value.as_u64()
}

fn f64_value(value: &Value) -> Option<f64> {
    value.as_f64()
}

fn apply_bool(value: &Value, target: &mut bool) {
    if let Some(value) = value.as_bool() {
        *target = value;
    }
}
