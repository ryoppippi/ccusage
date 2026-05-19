use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde_json::{Map, Value};

use crate::{
    cli::{
        BlocksArgs, CodexSpeed, CostMode, CostSource, DailyArgs, SharedArgs, SortOrder,
        StatuslineArgs, VisualBurnRate, WeekDay, WeeklyArgs,
    },
    config_schema::{
        BlocksSpecificOptions, CodexOptions, ConfigCodexSpeed, ConfigCostMode, ConfigCostSource,
        ConfigSortOrder, ConfigVisualBurnRate, ConfigWeekDay, DailySpecificOptions, PiOptions,
        SharedOptions, StatuslineSpecificOptions, WeeklySpecificOptions,
    },
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
    matches!(
        command,
        "claude"
            | "codex"
            | "opencode"
            | "amp"
            | "droid"
            | "hermes"
            | "pi"
            | "goose"
            | "kilo"
            | "copilot"
            | "gemini"
            | "kimi"
    )
}

fn is_report_command(command: &str) -> bool {
    matches!(
        command,
        "daily" | "monthly" | "weekly" | "session" | "blocks" | "statusline"
    )
}

pub(crate) fn apply_config_to_shared(shared: &mut SharedArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        apply_shared_options(shared, SharedOptions::from_map(options));
    }
}

pub(crate) fn apply_config_to_daily_args(args: &mut DailyArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        let options = DailySpecificOptions::from_map(options);
        if let Some(instances) = options.instances {
            args.instances = instances;
        }
        if let Some(project) = options.project {
            args.project = Some(project);
        }
        if let Some(project_aliases) = options.project_aliases {
            args.project_aliases = Some(project_aliases);
        }
    }
}

pub(crate) fn apply_config_to_weekly_args(args: &mut WeeklyArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        if let Some(day) = WeeklySpecificOptions::from_map(options).start_of_week {
            args.start_of_week = day.into();
        }
    }
}

pub(crate) fn apply_config_to_blocks_args(args: &mut BlocksArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        let options = BlocksSpecificOptions::from_map(options);
        if let Some(active) = options.active {
            args.active = active;
        }
        if let Some(recent) = options.recent {
            args.recent = recent;
        }
        if let Some(token_limit) = options.token_limit {
            args.token_limit = Some(token_limit);
        }
        if let Some(session_length) = options.session_length {
            args.session_length = session_length;
        }
    }
}

pub(crate) fn apply_config_to_statusline_args(args: &mut StatuslineArgs, config: &ConfigContext) {
    for options in config.option_maps() {
        let options = StatuslineSpecificOptions::from_map(options);
        if let Some(offline) = options.offline {
            args.offline = offline;
        }
        if let Some(no_offline) = options.no_offline {
            args.no_offline = no_offline;
        }
        if let Some(visual_burn_rate) = options.visual_burn_rate {
            args.visual_burn_rate = visual_burn_rate.into();
        }
        if let Some(cost_source) = options.cost_source {
            args.cost_source = cost_source.into();
        }
        if let Some(cache) = options.cache {
            args.cache = cache;
        }
        if let Some(no_cache) = options.no_cache {
            args.no_cache = no_cache;
        }
        if let Some(refresh_interval) = options.refresh_interval {
            args.refresh_interval = refresh_interval;
        }
        if let Some(threshold) = options
            .context_low_threshold
            .and_then(|value| u8::try_from(value).ok())
        {
            args.context_low_threshold = threshold;
        }
        if let Some(threshold) = options
            .context_medium_threshold
            .and_then(|value| u8::try_from(value).ok())
        {
            args.context_medium_threshold = threshold;
        }
        if let Some(debug) = options.debug {
            args.debug = debug;
        }
    }
}

pub(crate) fn apply_config_to_agent_args(
    codex_speed: &mut CodexSpeed,
    mut pi_path: Option<&mut Option<String>>,
    config: &ConfigContext,
) {
    for options in config.option_maps() {
        let codex_options = CodexOptions::from_map(options);
        if let Some(speed) = codex_options.speed {
            *codex_speed = speed.into();
        }
        if let Some(pi_path) = pi_path.as_deref_mut() {
            if let Some(path) = PiOptions::from_map(options).pi_path {
                *pi_path = Some(path);
            }
        }
    }
}

fn apply_shared_options(shared: &mut SharedArgs, options: SharedOptions) {
    if let Some(since) = options.since {
        shared.since = Some(since);
    }
    if let Some(until) = options.until {
        shared.until = Some(until);
    }
    if let Some(json) = options.json {
        shared.json = json;
    }
    if let Some(mode) = options.mode {
        shared.mode = mode.into();
    }
    if let Some(debug) = options.debug {
        shared.debug = debug;
    }
    if let Some(debug_samples) = options.debug_samples {
        shared.debug_samples = debug_samples;
    }
    if let Some(order) = options.order {
        shared.order = order.into();
    }
    if let Some(breakdown) = options.breakdown {
        shared.breakdown = breakdown;
    }
    if let Some(offline) = options.offline {
        shared.offline = offline;
    }
    if let Some(no_offline) = options.no_offline {
        shared.no_offline = no_offline;
    }
    if let Some(color) = options.color {
        shared.color = color;
    }
    if let Some(no_color) = options.no_color {
        shared.no_color = no_color;
    }
    if let Some(timezone) = options.timezone {
        shared.timezone = Some(timezone);
    }
    if let Some(jq) = options.jq {
        shared.jq = Some(jq);
    }
    if let Some(compact) = options.compact {
        shared.compact = compact;
    }
    if let Some(single_thread) = options.single_thread {
        shared.single_thread = single_thread;
    }
}

impl From<ConfigCostMode> for CostMode {
    fn from(value: ConfigCostMode) -> Self {
        match value {
            ConfigCostMode::Auto => Self::Auto,
            ConfigCostMode::Calculate => Self::Calculate,
            ConfigCostMode::Display => Self::Display,
        }
    }
}

impl From<ConfigSortOrder> for SortOrder {
    fn from(value: ConfigSortOrder) -> Self {
        match value {
            ConfigSortOrder::Desc => Self::Desc,
            ConfigSortOrder::Asc => Self::Asc,
        }
    }
}

impl From<ConfigWeekDay> for WeekDay {
    fn from(value: ConfigWeekDay) -> Self {
        match value {
            ConfigWeekDay::Sunday => Self::Sunday,
            ConfigWeekDay::Monday => Self::Monday,
            ConfigWeekDay::Tuesday => Self::Tuesday,
            ConfigWeekDay::Wednesday => Self::Wednesday,
            ConfigWeekDay::Thursday => Self::Thursday,
            ConfigWeekDay::Friday => Self::Friday,
            ConfigWeekDay::Saturday => Self::Saturday,
        }
    }
}

impl From<ConfigCodexSpeed> for CodexSpeed {
    fn from(value: ConfigCodexSpeed) -> Self {
        match value {
            ConfigCodexSpeed::Auto => Self::Auto,
            ConfigCodexSpeed::Standard => Self::Standard,
            ConfigCodexSpeed::Fast => Self::Fast,
        }
    }
}

impl From<ConfigVisualBurnRate> for VisualBurnRate {
    fn from(value: ConfigVisualBurnRate) -> Self {
        match value {
            ConfigVisualBurnRate::Off => Self::Off,
            ConfigVisualBurnRate::Emoji => Self::Emoji,
            ConfigVisualBurnRate::Text => Self::Text,
            ConfigVisualBurnRate::EmojiText => Self::EmojiText,
        }
    }
}

impl From<ConfigCostSource> for CostSource {
    fn from(value: ConfigCostSource) -> Self {
        match value {
            ConfigCostSource::Auto => Self::Auto,
            ConfigCostSource::Ccusage => Self::Ccusage,
            ConfigCostSource::Cc => Self::Cc,
            ConfigCostSource::Both => Self::Both,
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::{
        cli::{
            BlocksArgs, CodexSpeed, CostMode, SortOrder, StatuslineArgs, VisualBurnRate, WeekDay,
            WeeklyArgs,
        },
        DEFAULT_SESSION_DURATION_HOURS,
    };

    #[test]
    fn applies_schema_backed_shared_options() {
        let config = context(
            json!({
                "defaults": {
                    "since": "2026-01-01",
                    "until": "2026-01-31",
                    "json": true,
                    "mode": "calculate",
                    "debug": true,
                    "debugSamples": 9,
                    "order": "desc",
                    "breakdown": true,
                    "offline": true,
                    "noOffline": true,
                    "color": true,
                    "noColor": true,
                    "timezone": "Asia/Tokyo",
                    "jq": ".totals",
                    "compact": true,
                    "singleThread": true
                }
            }),
            "daily",
            None,
            "daily",
        );
        let mut shared = SharedArgs::default();

        apply_config_to_shared(&mut shared, &config);

        assert_eq!(shared.since.as_deref(), Some("2026-01-01"));
        assert_eq!(shared.until.as_deref(), Some("2026-01-31"));
        assert!(shared.json);
        assert_eq!(shared.mode, CostMode::Calculate);
        assert!(shared.debug);
        assert_eq!(shared.debug_samples, 9);
        assert_eq!(shared.order, SortOrder::Desc);
        assert!(shared.breakdown);
        assert!(shared.offline);
        assert!(shared.no_offline);
        assert!(shared.color);
        assert!(shared.no_color);
        assert_eq!(shared.timezone.as_deref(), Some("Asia/Tokyo"));
        assert_eq!(shared.jq.as_deref(), Some(".totals"));
        assert!(shared.compact);
        assert!(shared.single_thread);
    }

    #[test]
    fn applies_schema_backed_report_specific_options() {
        let config = context(
            json!({
                "commands": {
                    "blocks": {
                        "active": true,
                        "recent": true,
                        "tokenLimit": "500000",
                        "sessionLength": 6.5
                    },
                    "statusline": {
                        "offline": false,
                        "noOffline": true,
                        "visualBurnRate": "emoji-text",
                        "costSource": "both",
                        "cache": false,
                        "noCache": true,
                        "refreshInterval": 3,
                        "contextLowThreshold": 45,
                        "contextMediumThreshold": 75,
                        "debug": true
                    }
                }
            }),
            "blocks",
            None,
            "blocks",
        );
        let mut blocks = BlocksArgs {
            shared: SharedArgs::default(),
            active: false,
            recent: false,
            token_limit: None,
            session_length: DEFAULT_SESSION_DURATION_HOURS,
        };
        apply_config_to_blocks_args(&mut blocks, &config);

        assert!(blocks.active);
        assert!(blocks.recent);
        assert_eq!(blocks.token_limit.as_deref(), Some("500000"));
        assert_eq!(blocks.session_length, 6.5);

        let config = context(
            json!({
                "commands": {
                    "statusline": {
                        "offline": false,
                        "noOffline": true,
                        "visualBurnRate": "emoji-text",
                        "costSource": "both",
                        "cache": false,
                        "noCache": true,
                        "refreshInterval": 3,
                        "contextLowThreshold": 45,
                        "contextMediumThreshold": 75,
                        "debug": true
                    }
                }
            }),
            "statusline",
            None,
            "statusline",
        );
        let mut statusline = StatuslineArgs::default();
        apply_config_to_statusline_args(&mut statusline, &config);

        assert!(!statusline.offline);
        assert!(statusline.no_offline);
        assert_eq!(statusline.visual_burn_rate, VisualBurnRate::EmojiText);
        assert_eq!(statusline.cost_source, crate::cli::CostSource::Both);
        assert!(!statusline.cache);
        assert!(statusline.no_cache);
        assert_eq!(statusline.refresh_interval, 3);
        assert_eq!(statusline.context_low_threshold, 45);
        assert_eq!(statusline.context_medium_threshold, 75);
        assert!(statusline.debug);
    }

    #[test]
    fn applies_schema_backed_agent_specific_options() {
        let mut weekly = WeeklyArgs {
            shared: SharedArgs::default(),
            start_of_week: WeekDay::Sunday,
        };
        apply_config_to_weekly_args(
            &mut weekly,
            &context(
                json!({
                    "claude": {
                        "commands": {
                            "weekly": {
                                "startOfWeek": "monday"
                            }
                        }
                    }
                }),
                "claude weekly",
                Some("claude"),
                "weekly",
            ),
        );

        assert_eq!(weekly.start_of_week, WeekDay::Monday);

        let mut speed = CodexSpeed::Auto;
        apply_config_to_agent_args(
            &mut speed,
            None,
            &context(
                json!({
                    "codex": {
                        "defaults": {
                            "speed": "fast"
                        }
                    }
                }),
                "codex daily",
                Some("codex"),
                "daily",
            ),
        );

        assert_eq!(speed, CodexSpeed::Fast);

        let mut speed = CodexSpeed::Auto;
        let mut pi_path = None;
        apply_config_to_agent_args(
            &mut speed,
            Some(&mut pi_path),
            &context(
                json!({
                    "pi": {
                        "defaults": {
                            "piPath": "/tmp/pi-sessions"
                        }
                    }
                }),
                "pi daily",
                Some("pi"),
                "daily",
            ),
        );

        assert_eq!(pi_path.as_deref(), Some("/tmp/pi-sessions"));
    }

    fn context(value: Value, raw: &str, agent: Option<&str>, report: &str) -> ConfigContext {
        ConfigContext {
            value: Some(value),
            command: ConfigCommand {
                raw: raw.to_string(),
                agent: agent.map(ToString::to_string),
                report: report.to_string(),
            },
        }
    }
}
