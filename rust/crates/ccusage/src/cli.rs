use std::{env, ffi::OsString, path::PathBuf, process};

use crate::{
    config::{
        apply_config_to_agent_args, apply_config_to_blocks_args, apply_config_to_daily_args,
        apply_config_to_shared, apply_config_to_statusline_args, apply_config_to_weekly_args,
        ConfigContext,
    },
    DEFAULT_SESSION_DURATION_HOURS,
};

pub(crate) struct Cli {
    pub(crate) command: Option<Command>,
    pub(crate) shared: SharedArgs,
}

pub(crate) enum Command {
    All(AgentCommandArgs),
    Daily(DailyArgs),
    Monthly(SharedArgs),
    Weekly(WeeklyArgs),
    Session(SessionArgs),
    Blocks(BlocksArgs),
    Statusline(StatuslineArgs),
    Codex(AgentCommandArgs),
    OpenCode(AgentCommandArgs),
    Amp(AgentCommandArgs),
    Hermes(AgentCommandArgs),
    Pi(AgentCommandArgs),
    Goose(AgentCommandArgs),
    Kilo(AgentCommandArgs),
    Qwen(AgentCommandArgs),
    Copilot(AgentCommandArgs),
    Gemini(AgentCommandArgs),
    Kimi(AgentCommandArgs),
    OpenClaw(AgentCommandArgs),
}

#[derive(Clone, Default)]
pub(crate) struct SharedArgs {
    pub(crate) since: Option<String>,
    pub(crate) until: Option<String>,
    pub(crate) json: bool,
    pub(crate) mode: CostMode,
    pub(crate) debug: bool,
    pub(crate) debug_samples: usize,
    pub(crate) order: SortOrder,
    pub(crate) breakdown: bool,
    pub(crate) offline: bool,
    pub(crate) no_offline: bool,
    pub(crate) color: bool,
    pub(crate) no_color: bool,
    pub(crate) timezone: Option<String>,
    pub(crate) jq: Option<String>,
    pub(crate) config: Option<PathBuf>,
    pub(crate) compact: bool,
    pub(crate) single_thread: bool,
}

impl SharedArgs {
    fn with_defaults() -> Self {
        Self {
            mode: CostMode::Auto,
            debug_samples: 5,
            order: SortOrder::Asc,
            ..Self::default()
        }
    }
}

#[derive(Clone)]
pub(crate) struct DailyArgs {
    pub(crate) shared: SharedArgs,
    pub(crate) instances: bool,
    pub(crate) project: Option<String>,
    pub(crate) project_aliases: Option<String>,
}

#[derive(Clone)]
pub(crate) struct WeeklyArgs {
    pub(crate) shared: SharedArgs,
    pub(crate) start_of_week: WeekDay,
}

#[derive(Clone)]
pub(crate) struct SessionArgs {
    pub(crate) shared: SharedArgs,
    pub(crate) id: Option<String>,
}

#[derive(Clone)]
pub(crate) struct BlocksArgs {
    pub(crate) shared: SharedArgs,
    pub(crate) active: bool,
    pub(crate) recent: bool,
    pub(crate) token_limit: Option<String>,
    pub(crate) session_length: f64,
}

#[derive(Clone)]
pub(crate) struct StatuslineArgs {
    pub(crate) offline: bool,
    pub(crate) no_offline: bool,
    pub(crate) visual_burn_rate: VisualBurnRate,
    pub(crate) cost_source: CostSource,
    pub(crate) cache: bool,
    pub(crate) no_cache: bool,
    pub(crate) refresh_interval: u64,
    pub(crate) context_low_threshold: u8,
    pub(crate) context_medium_threshold: u8,
    pub(crate) config: Option<PathBuf>,
    pub(crate) debug: bool,
}

#[derive(Clone)]
pub(crate) struct AgentCommandArgs {
    pub(crate) shared: SharedArgs,
    pub(crate) kind: AgentReportKind,
    pub(crate) pi_path: Option<String>,
    pub(crate) open_claw_path: Option<String>,
    pub(crate) codex_speed: CodexSpeed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentReportKind {
    Daily,
    Weekly,
    Monthly,
    Session,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum CodexSpeed {
    #[default]
    Auto,
    Standard,
    Fast,
}

impl Default for StatuslineArgs {
    fn default() -> Self {
        Self {
            offline: true,
            no_offline: false,
            visual_burn_rate: VisualBurnRate::Off,
            cost_source: CostSource::Auto,
            cache: true,
            no_cache: false,
            refresh_interval: 1,
            context_low_threshold: 50,
            context_medium_threshold: 80,
            config: None,
            debug: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum CostMode {
    #[default]
    Auto,
    Calculate,
    Display,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum SortOrder {
    Desc,
    #[default]
    Asc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WeekDay {
    Sunday,
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum VisualBurnRate {
    Off,
    Emoji,
    Text,
    EmojiText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CostSource {
    Auto,
    Ccusage,
    Cc,
    Both,
}

impl Cli {
    pub(crate) fn parse() -> Self {
        Self::parse_from(env::args_os()).unwrap_or_else(|message| {
            eprintln!("{message}");
            eprintln!("Run 'ccusage --help' for usage.");
            process::exit(2);
        })
    }

    fn parse_from<I>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut parser = ArgParser::new(args.into_iter().skip(1).collect())?;
        normalize_legacy_agent_command_args(&mut parser.args);
        if let Some(message) = report_flag_alias_error(&parser.args) {
            return Err(message);
        }
        if let Some(message) = agent_filter_option_error(&parser.args) {
            return Err(message);
        }
        if let Some(message) = unsupported_agent_report_error(&parser.args) {
            return Err(message);
        }
        if parser
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-v" | "-V" | "--version"))
        {
            print_version_and_exit();
        }
        if parser
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-h" | "--help"))
        {
            print_help_and_exit(&parser.args);
        }

        let mut shared = SharedArgs::with_defaults();
        let config = ConfigContext::from_args(&parser.args);
        apply_config_to_shared(&mut shared, &config);
        while let Some(arg) = parser.peek() {
            if is_command(arg) {
                break;
            }
            if !arg.starts_with('-') {
                return Err(format!("Unknown command '{arg}'"));
            }
            parse_shared_arg(&mut parser, &mut shared)?;
        }

        let command = match parser.next() {
            None => None,
            Some(command) => Some(parse_command(
                &command,
                &mut parser,
                shared.clone(),
                &config,
            )?),
        };
        if let Some(extra) = parser.next() {
            return Err(format!("Unexpected argument '{extra}'"));
        }
        Ok(Self { command, shared })
    }
}

fn parse_command(
    command: &str,
    parser: &mut ArgParser,
    shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    match command {
        "daily" => parse_all_command(parser, shared, AgentReportKind::Daily, config),
        "monthly" => parse_all_command(parser, shared, AgentReportKind::Monthly, config),
        "weekly" => parse_all_command(parser, shared, AgentReportKind::Weekly, config),
        "session" => parse_all_command(parser, shared, AgentReportKind::Session, config),
        "blocks" => {
            let mut args = BlocksArgs {
                shared,
                active: false,
                recent: false,
                token_limit: None,
                session_length: DEFAULT_SESSION_DURATION_HOURS,
            };
            apply_config_to_blocks_args(&mut args, config);
            while parser.peek().is_some() {
                if parse_shared_arg_for_command(parser, &mut args.shared)? {
                    continue;
                }
                match parser.next_flag()?.as_str() {
                    "-a" | "--active" => args.active = true,
                    "-r" | "--recent" => args.recent = true,
                    "-t" | "--token-limit" => {
                        args.token_limit = Some(parser.value_for("--token-limit")?)
                    }
                    "-n" | "--session-length" => {
                        args.session_length = parser
                            .value_for("--session-length")?
                            .parse()
                            .map_err(|_| "Invalid value for --session-length".to_string())?
                    }
                    flag => return Err(format!("Unknown blocks option '{flag}'")),
                }
            }
            Ok(Command::Blocks(args))
        }
        "statusline" => {
            let mut args = StatuslineArgs::default();
            apply_config_to_statusline_args(&mut args, config);
            while parser.peek().is_some() {
                match parser.next_flag()?.as_str() {
                    "-O" | "--offline" => args.offline = true,
                    "--no-offline" => args.no_offline = true,
                    "-B" | "--visual-burn-rate" => {
                        args.visual_burn_rate =
                            parse_visual_burn_rate(&parser.value_for("--visual-burn-rate")?)?
                    }
                    "--cost-source" => {
                        args.cost_source = parse_cost_source(&parser.value_for("--cost-source")?)?
                    }
                    "--cache" => args.cache = true,
                    "--no-cache" => args.no_cache = true,
                    "--refresh-interval" => {
                        args.refresh_interval = parser
                            .value_for("--refresh-interval")?
                            .parse()
                            .map_err(|_| "Invalid value for --refresh-interval".to_string())?
                    }
                    "--context-low-threshold" => {
                        args.context_low_threshold = parser
                            .value_for("--context-low-threshold")?
                            .parse()
                            .map_err(|_| "Invalid value for --context-low-threshold".to_string())?
                    }
                    "--context-medium-threshold" => {
                        args.context_medium_threshold = parser
                            .value_for("--context-medium-threshold")?
                            .parse()
                            .map_err(|_| {
                                "Invalid value for --context-medium-threshold".to_string()
                            })?
                    }
                    "--config" => args.config = Some(PathBuf::from(parser.value_for("--config")?)),
                    "--debug" => args.debug = true,
                    flag => return Err(format!("Unknown statusline option '{flag}'")),
                }
            }
            Ok(Command::Statusline(args))
        }
        "claude" => parse_claude_command(parser, shared, config),
        "codex" => parse_codex_command(parser, shared, config),
        "opencode" => parse_opencode_command(parser, shared, config),
        "amp" => parse_amp_command(parser, shared, config),
        "hermes" => parse_hermes_command(parser, shared, config),
        "pi" => parse_pi_command(parser, shared, config),
        "goose" => parse_goose_command(parser, shared, config),
        "kilo" => parse_kilo_command(parser, shared, config),
        "qwen" => parse_qwen_command(parser, shared, config),
        "copilot" => parse_copilot_command(parser, shared, config),
        "gemini" => parse_gemini_command(parser, shared, config),
        "kimi" => parse_kimi_command(parser, shared, config),
        "openclaw" => parse_openclaw_command(parser, shared, config),
        _ => Err(format!("Unknown command '{command}'")),
    }
}

fn parse_all_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    kind: AgentReportKind,
    _config: &ConfigContext,
) -> Result<Command, String> {
    while parser.peek().is_some() {
        if matches!(parser.peek(), Some("--all")) {
            parser.next();
            continue;
        }
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::All(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_claude_daily_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    let mut args = DailyArgs {
        shared,
        instances: false,
        project: None,
        project_aliases: None,
    };
    apply_config_to_daily_args(&mut args, config);
    while parser.peek().is_some() {
        if parse_shared_arg_for_command(parser, &mut args.shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "-i" | "--instances" => args.instances = true,
            "-p" | "--project" => args.project = Some(parser.value_for("--project")?),
            "--project-aliases" => {
                args.project_aliases = Some(parser.value_for("--project-aliases")?)
            }
            flag => return Err(format!("Unknown daily option '{flag}'")),
        }
    }
    Ok(Command::Daily(args))
}

fn parse_claude_monthly_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Monthly(shared))
}

fn parse_claude_weekly_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    let mut args = WeeklyArgs {
        shared,
        start_of_week: WeekDay::Sunday,
    };
    apply_config_to_weekly_args(&mut args, config);
    while parser.peek().is_some() {
        if parse_shared_arg_for_command(parser, &mut args.shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "-w" | "--start-of-week" => {
                args.start_of_week = parse_week_day(&parser.value_for("--start-of-week")?)?
            }
            flag => return Err(format!("Unknown weekly option '{flag}'")),
        }
    }
    Ok(Command::Weekly(args))
}

fn parse_claude_session_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let mut args = SessionArgs { shared, id: None };
    while parser.peek().is_some() {
        if parse_shared_arg_for_command(parser, &mut args.shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "-i" | "--id" => args.id = Some(parser.value_for("--id")?),
            flag => return Err(format!("Unknown session option '{flag}'")),
        }
    }
    Ok(Command::Session(args))
}

fn parse_claude_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    let command = match parser.peek() {
        Some(command @ ("daily" | "monthly" | "weekly" | "session" | "blocks" | "statusline")) => {
            let command = command.to_string();
            parser.next();
            command
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown claude command '{command}'"));
        }
        _ => "daily".to_string(),
    };
    match command.as_str() {
        "daily" => parse_claude_daily_command(parser, shared, config),
        "monthly" => parse_claude_monthly_command(parser, shared, config),
        "weekly" => parse_claude_weekly_command(parser, shared, config),
        "session" => parse_claude_session_command(parser, shared, config),
        "blocks" | "statusline" => parse_command(&command, parser, shared, config),
        _ => unreachable!("claude command is prevalidated"),
    }
}

fn parse_codex_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown codex command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    let mut codex_speed = CodexSpeed::Auto;
    apply_config_to_agent_args(&mut codex_speed, None, None, config);
    while parser.peek().is_some() {
        if parse_shared_arg_for_command(parser, &mut shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "--speed" => codex_speed = parse_codex_speed(&parser.value_for("--speed")?)?,
            flag => return Err(format!("Unknown codex option '{flag}'")),
        }
    }
    Ok(Command::Codex(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed,
    }))
}

fn parse_opencode_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("weekly") => {
            parser.next();
            AgentReportKind::Weekly
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown opencode command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::OpenCode(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_amp_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown amp command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Amp(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_hermes_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown hermes command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Hermes(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_pi_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown pi command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    let mut pi_path = None;
    let mut codex_speed = CodexSpeed::Auto;
    apply_config_to_agent_args(&mut codex_speed, Some(&mut pi_path), None, config);
    while parser.peek().is_some() {
        if parse_shared_arg_for_command(parser, &mut shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "--pi-path" => pi_path = Some(parser.value_for("--pi-path")?),
            flag => return Err(format!("Unknown pi option '{flag}'")),
        }
    }
    Ok(Command::Pi(AgentCommandArgs {
        shared,
        kind,
        pi_path,
        open_claw_path: None,
        codex_speed,
    }))
}

fn parse_goose_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown goose command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Goose(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_openclaw_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown openclaw command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    let mut open_claw_path = None;
    let mut codex_speed = CodexSpeed::Auto;
    apply_config_to_agent_args(&mut codex_speed, None, Some(&mut open_claw_path), config);
    while parser.peek().is_some() {
        if parse_shared_arg_for_command(parser, &mut shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "--open-claw-path" => open_claw_path = Some(parser.value_for("--open-claw-path")?),
            flag => return Err(format!("Unknown openclaw option '{flag}'")),
        }
    }
    Ok(Command::OpenClaw(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path,
        codex_speed,
    }))
}

fn parse_copilot_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown copilot command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Copilot(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_kilo_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown kilo command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Kilo(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_qwen_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown qwen command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Qwen(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_gemini_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown gemini command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Gemini(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_kimi_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    _config: &ConfigContext,
) -> Result<Command, String> {
    let kind = match parser.peek() {
        Some("daily") => {
            parser.next();
            AgentReportKind::Daily
        }
        Some("monthly") => {
            parser.next();
            AgentReportKind::Monthly
        }
        Some("session") => {
            parser.next();
            AgentReportKind::Session
        }
        Some(command) if !command.starts_with('-') => {
            return Err(format!("Unknown kimi command '{command}'"));
        }
        _ => AgentReportKind::Daily,
    };
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Kimi(AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_shared_arg_for_command(
    parser: &mut ArgParser,
    shared: &mut SharedArgs,
) -> Result<bool, String> {
    let Some(arg) = parser.peek() else {
        return Ok(false);
    };
    if is_shared_flag(arg) {
        parse_shared_arg(parser, shared)?;
        return Ok(true);
    }
    Ok(false)
}

fn parse_shared_arg(parser: &mut ArgParser, shared: &mut SharedArgs) -> Result<(), String> {
    match parser.next_flag()?.as_str() {
        "-s" | "--since" => shared.since = Some(parser.value_for("--since")?),
        "-u" | "--until" => shared.until = Some(parser.value_for("--until")?),
        "-j" | "--json" => shared.json = true,
        "-m" | "--mode" => shared.mode = parse_cost_mode(&parser.value_for("--mode")?)?,
        "-d" | "--debug" => shared.debug = true,
        "--debug-samples" => {
            shared.debug_samples = parser
                .value_for("--debug-samples")?
                .parse()
                .map_err(|_| "Invalid value for --debug-samples".to_string())?
        }
        "-o" | "--order" => shared.order = parse_sort_order(&parser.value_for("--order")?)?,
        "-b" | "--breakdown" => shared.breakdown = true,
        "-O" | "--offline" => shared.offline = true,
        "--no-offline" => shared.no_offline = true,
        "--color" => shared.color = true,
        "--no-color" => shared.no_color = true,
        "-z" | "--timezone" => shared.timezone = Some(parser.value_for("--timezone")?),
        "-q" | "--jq" => shared.jq = Some(parser.value_for("--jq")?),
        "--config" => shared.config = Some(PathBuf::from(parser.value_for("--config")?)),
        "--compact" => shared.compact = true,
        "--single-thread" => shared.single_thread = true,
        flag => return Err(format!("Unknown option '{flag}'")),
    }
    Ok(())
}

fn is_command(arg: &str) -> bool {
    matches!(
        arg,
        "daily"
            | "monthly"
            | "weekly"
            | "session"
            | "blocks"
            | "statusline"
            | "claude"
            | "codex"
            | "opencode"
            | "amp"
            | "hermes"
            | "pi"
            | "goose"
            | "openclaw"
            | "kilo"
            | "qwen"
            | "copilot"
            | "gemini"
            | "kimi"
    )
}

fn normalize_legacy_agent_command_args(args: &mut Vec<String>) {
    let Some(command) = args.first() else {
        return;
    };
    let Some((agent, report)) = command.split_once(':') else {
        return;
    };
    if !legacy_agent_report_supported(agent, report) {
        return;
    }
    args.splice(0..1, [agent.to_string(), report.to_string()]);
}

fn legacy_agent_report_supported(agent: &str, report: &str) -> bool {
    agent_report_supported(agent, report)
}

fn report_flag_alias_error(args: &[String]) -> Option<String> {
    let flag = args.iter().find(|arg| {
        matches!(
            arg.as_str(),
            "--daily" | "--weekly" | "--monthly" | "--session" | "--blocks" | "--statusline"
        )
    })?;
    Some(format!(
        "Report flags like {flag} are not supported. Use \"ccusage {}\" instead.",
        flag.trim_start_matches("--")
    ))
}

fn agent_filter_option_error(args: &[String]) -> Option<String> {
    let flag = args.iter().find_map(|arg| {
        if arg == "--agent" || arg.starts_with("--agent=") {
            return Some("--agent");
        }
        if arg == "-a" || arg.starts_with("-a=") {
            return Some("-a");
        }
        None
    })?;
    Some(format!(
        "Agent filters like {flag} are not supported. Use \"ccusage <agent> <report>\", for example \"ccusage codex daily\"."
    ))
}

fn unsupported_agent_report_error(args: &[String]) -> Option<String> {
    let tokens = command_tokens(args);
    let [agent, report, ..] = tokens.as_slice() else {
        return None;
    };
    if !is_agent_command(agent) || agent_report_supported(agent, report) {
        return None;
    }

    let display = agent_display_name(agent);
    let message = if matches!(report.as_str(), "blocks" | "statusline") {
        format!(
            "The \"{report}\" report is only available for Claude Code usage.\nUse \"ccusage {agent} daily\" for {display} usage reports."
        )
    } else {
        format!(
            "The \"{report}\" report is not available for {display} usage.\nUse \"ccusage {agent} daily\" for {display} usage reports."
        )
    };
    Some(message)
}

fn command_tokens(args: &[String]) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        if arg.starts_with('-') {
            if option_takes_value(arg) && !arg.contains('=') {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }
        tokens.push(arg.clone());
        index += 1;
    }
    tokens
}

fn option_takes_value(arg: &str) -> bool {
    matches!(
        arg,
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
            | "-p"
            | "--project"
            | "--project-aliases"
            | "-w"
            | "--start-of-week"
            | "-i"
            | "--id"
            | "-t"
            | "--token-limit"
            | "-n"
            | "--session-length"
            | "-B"
            | "--visual-burn-rate"
            | "--cost-source"
            | "--refresh-interval"
            | "--context-low-threshold"
            | "--context-medium-threshold"
            | "--speed"
            | "--pi-path"
            | "--open-claw-path"
    )
}

fn is_agent_command(command: &str) -> bool {
    matches!(
        command,
        "claude"
            | "codex"
            | "opencode"
            | "amp"
            | "hermes"
            | "pi"
            | "goose"
            | "kilo"
            | "qwen"
            | "copilot"
            | "gemini"
            | "kimi"
            | "openclaw"
    )
}

fn agent_report_supported(agent: &str, report: &str) -> bool {
    match agent {
        "claude" => matches!(
            report,
            "daily" | "weekly" | "monthly" | "session" | "blocks" | "statusline"
        ),
        "codex" => matches!(report, "daily" | "monthly" | "session"),
        "opencode" => matches!(report, "daily" | "weekly" | "monthly" | "session"),
        "amp" | "hermes" | "pi" | "goose" | "kilo" | "qwen" | "copilot" | "gemini" | "kimi"
        | "openclaw" => {
            matches!(report, "daily" | "monthly" | "session")
        }
        _ => false,
    }
}

fn agent_display_name(agent: &str) -> &'static str {
    match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        "amp" => "Amp",
        "hermes" => "Hermes",
        "pi" => "pi-agent",
        "goose" => "Goose",
        "kilo" => "Kilo",
        "qwen" => "Qwen",
        "copilot" => "GitHub Copilot CLI",
        "gemini" => "Gemini CLI",
        "kimi" => "Kimi",
        "openclaw" => "OpenClaw",
        _ => unreachable!("agent is prevalidated"),
    }
}

fn is_shared_flag(arg: &str) -> bool {
    matches!(
        arg.split_once('=').map_or(arg, |(name, _)| name),
        "-s" | "--since"
            | "-u"
            | "--until"
            | "-j"
            | "--json"
            | "-m"
            | "--mode"
            | "-d"
            | "--debug"
            | "--debug-samples"
            | "-o"
            | "--order"
            | "-b"
            | "--breakdown"
            | "-O"
            | "--offline"
            | "--no-offline"
            | "--color"
            | "--no-color"
            | "-z"
            | "--timezone"
            | "-q"
            | "--jq"
            | "--config"
            | "--compact"
            | "--single-thread"
    )
}

fn parse_cost_mode(value: &str) -> Result<CostMode, String> {
    match value {
        "auto" => Ok(CostMode::Auto),
        "calculate" => Ok(CostMode::Calculate),
        "display" => Ok(CostMode::Display),
        _ => Err(format!("Invalid cost mode '{value}'")),
    }
}

fn parse_sort_order(value: &str) -> Result<SortOrder, String> {
    match value {
        "asc" => Ok(SortOrder::Asc),
        "desc" => Ok(SortOrder::Desc),
        _ => Err(format!("Invalid sort order '{value}'")),
    }
}

fn parse_week_day(value: &str) -> Result<WeekDay, String> {
    match value {
        "sunday" => Ok(WeekDay::Sunday),
        "monday" => Ok(WeekDay::Monday),
        "tuesday" => Ok(WeekDay::Tuesday),
        "wednesday" => Ok(WeekDay::Wednesday),
        "thursday" => Ok(WeekDay::Thursday),
        "friday" => Ok(WeekDay::Friday),
        "saturday" => Ok(WeekDay::Saturday),
        _ => Err(format!("Invalid week day '{value}'")),
    }
}

fn parse_codex_speed(value: &str) -> Result<CodexSpeed, String> {
    match value {
        "auto" => Ok(CodexSpeed::Auto),
        "standard" => Ok(CodexSpeed::Standard),
        "fast" => Ok(CodexSpeed::Fast),
        _ => Err(format!("Invalid speed option '{value}'")),
    }
}

fn parse_visual_burn_rate(value: &str) -> Result<VisualBurnRate, String> {
    match value {
        "off" => Ok(VisualBurnRate::Off),
        "emoji" => Ok(VisualBurnRate::Emoji),
        "text" => Ok(VisualBurnRate::Text),
        "emoji-text" => Ok(VisualBurnRate::EmojiText),
        _ => Err(format!("Invalid visual burn rate '{value}'")),
    }
}

fn parse_cost_source(value: &str) -> Result<CostSource, String> {
    match value {
        "auto" => Ok(CostSource::Auto),
        "ccusage" => Ok(CostSource::Ccusage),
        "cc" => Ok(CostSource::Cc),
        "both" => Ok(CostSource::Both),
        _ => Err(format!("Invalid cost source '{value}'")),
    }
}

struct ArgParser {
    args: Vec<String>,
    index: usize,
    pending_value: Option<String>,
}

impl ArgParser {
    fn new(args: Vec<OsString>) -> Result<Self, String> {
        let mut parsed = Vec::with_capacity(args.len());
        for arg in args {
            parsed.push(
                arg.into_string()
                    .map_err(|_| "Arguments must be valid UTF-8".to_string())?,
            );
        }
        Ok(Self {
            args: parsed,
            index: 0,
            pending_value: None,
        })
    }

    fn peek(&self) -> Option<&str> {
        self.args.get(self.index).map(String::as_str)
    }

    fn next(&mut self) -> Option<String> {
        let value = self.args.get(self.index)?.clone();
        self.index += 1;
        Some(value)
    }

    fn next_flag(&mut self) -> Result<String, String> {
        let arg = self
            .next()
            .ok_or_else(|| "Expected option but reached end of arguments".to_string())?;
        if matches!(arg.as_str(), "-h" | "--help" | "-v" | "-V" | "--version") {
            print_help_or_version_arg(&arg);
        }
        if let Some((flag, value)) = arg.split_once('=') {
            self.pending_value = Some(value.to_string());
            return Ok(flag.to_string());
        }
        if arg.starts_with('-') {
            Ok(arg)
        } else {
            Err(format!("Expected option, got '{arg}'"))
        }
    }

    fn value_for(&mut self, flag: &str) -> Result<String, String> {
        if let Some(value) = self.pending_value.take() {
            if value.is_empty() {
                return Err(format!("Missing value for {flag}"));
            }
            return Ok(value);
        }
        let value = self
            .next()
            .ok_or_else(|| format!("Missing value for {flag}"))?;
        if value.starts_with('-') {
            return Err(format!("Missing value for {flag}"));
        }
        Ok(value)
    }
}

fn print_help_or_version_arg(arg: &str) -> ! {
    match arg {
        "-v" | "-V" | "--version" => print_version_and_exit(),
        _ => println!("{}", help_text()),
    }
    process::exit(0);
}

fn print_version_and_exit() -> ! {
    println!("ccusage {}", env!("CARGO_PKG_VERSION"));
    process::exit(0);
}

fn print_help_and_exit(args: &[String]) -> ! {
    println!("{}", help_text_for_args(args));
    process::exit(0);
}

fn help_text() -> String {
    root_help_text()
}

fn help_text_for_args(args: &[String]) -> String {
    let args = strip_program_name(args);
    let tokens = command_tokens(args);
    help_text_for_tokens(&tokens)
}

fn strip_program_name(args: &[String]) -> &[String] {
    if args.first().is_some_and(|arg| arg == "ccusage") {
        &args[1..]
    } else {
        args
    }
}

fn help_text_for_tokens(tokens: &[String]) -> String {
    match tokens {
        [] => root_help_text(),
        [command] => match command.as_str() {
            "daily" | "monthly" | "weekly" | "session" => all_report_help(command),
            "blocks" => blocks_help("ccusage blocks"),
            "statusline" => statusline_help("ccusage statusline"),
            "claude" => agent_help(
                "claude",
                &[
                    ("daily", "Show usage report grouped by date"),
                    ("monthly", "Show usage report grouped by month"),
                    ("weekly", "Show usage report grouped by week"),
                    ("session", "Show usage report grouped by conversation session"),
                    ("blocks", "Show usage report grouped by session billing blocks"),
                    (
                        "statusline",
                        "Display compact status line for Claude Code hooks with hybrid time+file caching (Beta)",
                    ),
                ],
            ),
            "codex" => agent_help(
                "codex",
                &[
                    ("daily", "Show Codex token usage grouped by day"),
                    ("monthly", "Show Codex token usage grouped by month"),
                    ("session", "Show Codex token usage grouped by session"),
                ],
            ),
            "opencode" => agent_help(
                "opencode",
                &[
                    ("daily", "Show OpenCode token usage grouped by day"),
                    ("weekly", "Show OpenCode token usage grouped by week"),
                    ("monthly", "Show OpenCode token usage grouped by month"),
                    ("session", "Show OpenCode token usage grouped by session"),
                ],
            ),
            "amp" => agent_help(
                "amp",
                &[
                    ("daily", "Show Amp token usage grouped by day"),
                    ("monthly", "Show Amp token usage grouped by month"),
                    ("session", "Show Amp token usage grouped by session"),
                ],
            ),
            "hermes" => agent_help(
                "hermes",
                &[
                    ("daily", "Show Hermes usage grouped by date"),
                    ("monthly", "Show Hermes usage grouped by month"),
                    ("session", "Show Hermes usage grouped by session"),
                ],
            ),
            "pi" => agent_help(
                "pi",
                &[
                    ("daily", "Show pi-agent usage grouped by date"),
                    ("monthly", "Show pi-agent usage grouped by month"),
                    ("session", "Show pi-agent usage grouped by session"),
                ],
            ),
            "goose" => agent_help(
                "goose",
                &[
                    ("daily", "Show Goose usage grouped by date"),
                    ("monthly", "Show Goose usage grouped by month"),
                    ("session", "Show Goose usage grouped by session"),
                ],
            ),
            "kilo" => agent_help(
                "kilo",
                &[
                    ("daily", "Show Kilo usage grouped by date"),
                    ("monthly", "Show Kilo usage grouped by month"),
                    ("session", "Show Kilo usage grouped by session"),
                ],
            ),
            "qwen" => agent_help(
                "qwen",
                &[
                    ("daily", "Show Qwen usage grouped by date"),
                    ("monthly", "Show Qwen usage grouped by month"),
                    ("session", "Show Qwen usage grouped by session"),
                ],
            ),
            "copilot" => agent_help(
                "copilot",
                &[
                    ("daily", "Show GitHub Copilot CLI usage grouped by date"),
                    ("monthly", "Show GitHub Copilot CLI usage grouped by month"),
                    ("session", "Show GitHub Copilot CLI usage grouped by session"),
                ],
            ),
            "gemini" => agent_help(
                "gemini",
                &[
                    ("daily", "Show Gemini CLI usage grouped by date"),
                    ("monthly", "Show Gemini CLI usage grouped by month"),
                    ("session", "Show Gemini CLI usage grouped by session"),
                ],
            ),
            "kimi" => agent_help(
                "kimi",
                &[
                    ("daily", "Show Kimi usage grouped by date"),
                    ("monthly", "Show Kimi usage grouped by month"),
                    ("session", "Show Kimi usage grouped by session"),
                ],
            ),
            "openclaw" => agent_help(
                "openclaw",
                &[
                    ("daily", "Show OpenClaw usage grouped by date"),
                    ("monthly", "Show OpenClaw usage grouped by month"),
                    ("session", "Show OpenClaw usage grouped by session"),
                ],
            ),
            _ => root_help_text(),
        },
        [agent, report, ..] => match agent.as_str() {
            "claude" => match report.as_str() {
                "daily" | "monthly" | "weekly" | "session" => claude_report_help(report),
                "blocks" => blocks_help("ccusage claude blocks"),
                "statusline" => statusline_help("ccusage claude statusline"),
                _ => root_help_text(),
            },
            "codex" => codex_report_help(report),
            "opencode" => opencode_report_help(report),
            "amp" => amp_report_help(report),
            "hermes" => hermes_report_help(report),
            "pi" => pi_report_help(report),
            "goose" => goose_report_help(report),
            "kilo" => kilo_report_help(report),
            "qwen" => qwen_report_help(report),
            "copilot" => copilot_report_help(report),
            "gemini" => gemini_report_help(report),
            "kimi" => kimi_report_help(report),
            "openclaw" => openclaw_report_help(report),
            _ => root_help_text(),
        },
    }
}

fn agent_help(agent: &str, commands: &[(&str, &str)]) -> String {
    let mut lines = vec![
        format!("Usage reports for {agent}."),
        String::new(),
        "USAGE:".to_string(),
        format!("  ccusage {agent} <COMMANDS>"),
        String::new(),
        "COMMANDS:".to_string(),
    ];
    for (command, description) in commands {
        lines.push(format!("  {command:<11} {description}"));
    }
    lines.push(String::new());
    lines.push("For more info, run any command with the `--help` flag:".to_string());
    for (command, _) in commands {
        lines.push(format!("  ccusage {agent} {command} --help"));
    }
    lines.join("\n")
}

fn root_help_text() -> String {
    let mut lines = [
        "USAGE:",
        "  ccusage [daily] <OPTIONS>",
        "  ccusage <COMMANDS>",
        "",
        "COMMANDS:",
        "  daily                      Show all detected coding (agent) CLI usage grouped by date",
        "  monthly                    Show all detected coding (agent) CLI usage grouped by month",
        "  weekly                     Show all detected coding (agent) CLI usage grouped by week",
        "  session                    Show all detected coding (agent) CLI usage grouped by session",
        "  blocks                     Show usage report grouped by session billing blocks",
        "  statusline                 Display compact status line for Claude Code hooks with hybrid time+file caching (Beta)",
        "  claude                     Show Claude Code usage commands",
        "  codex                      Show Codex token usage commands",
        "  opencode                   Show OpenCode token usage commands",
        "  amp                        Show Amp token usage commands",
        "  hermes                     Show Hermes usage commands",
        "  pi                         Show pi-agent usage commands",
        "  goose                      Show Goose usage commands",
        "  kilo                       Show Kilo usage commands",
        "  qwen                       Show Qwen usage commands",
        "  copilot                    Show GitHub Copilot CLI usage commands",
        "  gemini                     Show Gemini CLI usage commands",
        "  kimi                       Show Kimi usage commands",
        "  openclaw                   Show OpenClaw usage commands",
        "",
        "For more info, run any command with the `--help` flag:",
        "  ccusage daily --help",
        "  ccusage monthly --help",
        "  ccusage weekly --help",
        "  ccusage session --help",
        "  ccusage blocks --help",
        "  ccusage statusline --help",
        "  ccusage claude --help",
        "  ccusage codex --help",
        "  ccusage opencode --help",
        "  ccusage amp --help",
        "  ccusage hermes --help",
        "  ccusage pi --help",
        "  ccusage goose --help",
        "  ccusage kilo --help",
        "  ccusage qwen --help",
        "  ccusage copilot --help",
        "  ccusage gemini --help",
        "  ccusage kimi --help",
        "  ccusage openclaw --help",
        "",
    ]
    .map(str::to_string)
    .to_vec();
    lines.push(all_agent_options().to_string());
    lines.join("\n")
}

fn all_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show all detected coding (agent) CLI usage grouped by date",
        "monthly" => "Show all detected coding (agent) CLI usage grouped by month",
        "weekly" => "Show all detected coding (agent) CLI usage grouped by week",
        "session" => "Show all detected coding (agent) CLI usage grouped by session",
        _ => unreachable!("all-agent report is prevalidated"),
    };
    command_help(
        description,
        &format!("ccusage {report} <OPTIONS>"),
        all_agent_options(),
    )
}

fn claude_report_help(report: &str) -> String {
    let (description, options) = match report {
        "daily" => (
            "Show usage report grouped by date",
            command_options(&[shared_claude_options(), daily_options()]),
        ),
        "monthly" => (
            "Show usage report grouped by month",
            shared_claude_options().to_string(),
        ),
        "weekly" => (
            "Show usage report grouped by week",
            command_options(&[shared_claude_options(), weekly_options()]),
        ),
        "session" => (
            "Show usage report grouped by conversation session",
            command_options(&[shared_claude_options(), session_options()]),
        ),
        _ => unreachable!("Claude report is prevalidated"),
    };
    command_help(
        description,
        &format!("ccusage claude {report} <OPTIONS>"),
        &options,
    )
}

fn codex_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Codex token usage grouped by day",
        "monthly" => "Show Codex token usage grouped by month",
        "session" => "Show Codex token usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage codex {report} <OPTIONS>"),
        codex_options(),
    )
}

fn opencode_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show OpenCode token usage grouped by day",
        "weekly" => "Show OpenCode token usage grouped by week",
        "monthly" => "Show OpenCode token usage grouped by month",
        "session" => "Show OpenCode token usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage opencode {report} <OPTIONS>"),
        agent_options(),
    )
}

fn amp_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Amp token usage grouped by day",
        "monthly" => "Show Amp token usage grouped by month",
        "session" => "Show Amp token usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage amp {report} <OPTIONS>"),
        agent_options(),
    )
}

fn hermes_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Hermes usage grouped by date",
        "monthly" => "Show Hermes usage grouped by month",
        "session" => "Show Hermes usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage hermes {report} <OPTIONS>"),
        agent_options(),
    )
}

fn pi_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show pi-agent usage grouped by date",
        "monthly" => "Show pi-agent usage grouped by month",
        "session" => "Show pi-agent usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage pi {report} <OPTIONS>"),
        &command_options(&[agent_options(), pi_options()]),
    )
}

fn goose_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Goose usage grouped by date",
        "monthly" => "Show Goose usage grouped by month",
        "session" => "Show Goose usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage goose {report} <OPTIONS>"),
        agent_options(),
    )
}

fn kilo_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Kilo usage grouped by date",
        "monthly" => "Show Kilo usage grouped by month",
        "session" => "Show Kilo usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage kilo {report} <OPTIONS>"),
        agent_options(),
    )
}

fn qwen_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Qwen usage grouped by date",
        "monthly" => "Show Qwen usage grouped by month",
        "session" => "Show Qwen usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage qwen {report} <OPTIONS>"),
        agent_options(),
    )
}

fn copilot_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show GitHub Copilot CLI usage grouped by date",
        "monthly" => "Show GitHub Copilot CLI usage grouped by month",
        "session" => "Show GitHub Copilot CLI usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage copilot {report} <OPTIONS>"),
        agent_options(),
    )
}

fn gemini_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Gemini CLI usage grouped by date",
        "monthly" => "Show Gemini CLI usage grouped by month",
        "session" => "Show Gemini CLI usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage gemini {report} <OPTIONS>"),
        agent_options(),
    )
}

fn kimi_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Kimi usage grouped by date",
        "monthly" => "Show Kimi usage grouped by month",
        "session" => "Show Kimi usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage kimi {report} <OPTIONS>"),
        agent_options(),
    )
}

fn openclaw_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show OpenClaw usage grouped by date",
        "monthly" => "Show OpenClaw usage grouped by month",
        "session" => "Show OpenClaw usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage openclaw {report} <OPTIONS>"),
        &command_options(&[agent_options(), openclaw_options()]),
    )
}

fn blocks_help(usage: &str) -> String {
    command_help(
        "Show usage report grouped by session billing blocks",
        &format!("{usage} <OPTIONS>"),
        &command_options(&[shared_claude_options(), blocks_options()]),
    )
}

fn statusline_help(usage: &str) -> String {
    command_help(
        "Display compact status line for Claude Code hooks with hybrid time+file caching (Beta)",
        &format!("{usage} <OPTIONS>"),
        statusline_options(),
    )
}

fn command_help(description: &str, usage: &str, options: &str) -> String {
    [
        description,
        "",
        "USAGE:",
        &format!("  {usage}"),
        "",
        options,
    ]
    .join("\n")
}

fn command_options(parts: &[&str]) -> String {
    for part in parts {
        debug_assert!(part.starts_with("OPTIONS:\n"));
    }
    let option_lines = parts
        .iter()
        .flat_map(|part| part.lines().skip(1))
        .collect::<Vec<_>>()
        .join("\n");
    format!("OPTIONS:\n{option_lines}")
}

include!(concat!(env!("OUT_DIR"), "/cli-help.rs"));

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(args.iter().map(OsString::from)).unwrap()
    }

    fn parse_error(args: &[&str]) -> String {
        match Cli::parse_from(args.iter().map(OsString::from)) {
            Ok(_) => panic!("expected parse error"),
            Err(error) => error,
        }
    }

    fn temp_config_path(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("ccusage-cli-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir.join("ccusage.json")
    }

    #[test]
    fn parses_root_daily_as_all_agent_report() {
        let cli = parse(&["ccusage", "daily", "--json", "--since", "20260102"]);
        let Some(Command::All(args)) = cli.command else {
            panic!("expected all-agent command");
        };
        assert_eq!(args.kind, AgentReportKind::Daily);
        assert!(args.shared.json);
        assert_eq!(args.shared.since.as_deref(), Some("20260102"));
    }

    #[test]
    fn applies_config_defaults_and_command_options_before_cli_options() {
        let path = temp_config_path("daily");
        fs::write(
            &path,
            r#"{
                "defaults": { "json": true, "order": "desc" },
                "commands": { "daily": { "since": "20260102", "order": "desc" } }
            }"#,
        )
        .unwrap();
        let path = path.to_string_lossy().to_string();

        let cli = parse(&[
            "ccusage",
            "--config",
            path.as_str(),
            "daily",
            "--order",
            "asc",
        ]);
        let Some(Command::All(args)) = cli.command else {
            panic!("expected all-agent command");
        };
        assert!(args.shared.json);
        assert_eq!(args.shared.since.as_deref(), Some("20260102"));
        assert_eq!(args.shared.order, SortOrder::Asc);
    }

    #[test]
    fn applies_agent_namespace_config_to_codex_speed() {
        let path = temp_config_path("codex");
        fs::write(
            &path,
            r#"{
                "codex": {
                    "commands": { "daily": { "speed": "fast" } }
                }
            }"#,
        )
        .unwrap();
        let path = path.to_string_lossy().to_string();

        let cli = parse(&["ccusage", "--config", path.as_str(), "codex", "daily"]);
        let Some(Command::Codex(args)) = cli.command else {
            panic!("expected codex command");
        };
        assert_eq!(args.codex_speed, CodexSpeed::Fast);
    }

    #[test]
    fn applies_config_file_passed_after_agent_command() {
        let path = temp_config_path("codex-postfix");
        fs::write(
            &path,
            r#"{
                "$schema": "https://ccusage.com/config-schema.json",
                "defaults": {
                    "json": true,
                    "timezone": "Asia/Tokyo"
                },
                "codex": {
                    "commands": {
                        "monthly": {
                            "speed": "standard",
                            "since": "20260101"
                        }
                    }
                }
            }"#,
        )
        .unwrap();
        let path = path.to_string_lossy().to_string();

        let cli = parse(&["ccusage", "codex", "monthly", "--config", path.as_str()]);
        let Some(Command::Codex(args)) = cli.command else {
            panic!("expected codex command");
        };
        assert_eq!(args.kind, AgentReportKind::Monthly);
        assert!(args.shared.json);
        assert_eq!(args.shared.timezone.as_deref(), Some("Asia/Tokyo"));
        assert_eq!(args.shared.since.as_deref(), Some("20260101"));
        assert_eq!(args.codex_speed, CodexSpeed::Standard);
    }

    #[test]
    fn applies_schema_documented_config_file_options() {
        let path = temp_config_path("schema-documented");
        fs::write(
            &path,
            r#"{
                "$schema": "https://ccusage.com/config-schema.json",
                "defaults": {
                    "json": true,
                    "compact": true
                },
                "claude": {
                    "commands": {
                        "weekly": {
                            "startOfWeek": "monday"
                        },
                        "blocks": {
                            "active": true,
                            "tokenLimit": "500000",
                            "sessionLength": 6
                        },
                        "statusline": {
                            "visualBurnRate": "emoji-text",
                            "costSource": "both",
                            "refreshInterval": 3
                        }
                    }
                },
                "pi": {
                    "commands": {
                        "daily": {
                            "piPath": "/tmp/pi-sessions"
                        }
                    }
                },
                "openclaw": {
                    "commands": {
                        "daily": {
                            "openClawPath": "/tmp/openclaw"
                        }
                    }
                }
            }"#,
        )
        .unwrap();
        let path = path.to_string_lossy().to_string();

        let cli = parse(&["ccusage", "claude", "weekly", "--config", path.as_str()]);
        let Some(Command::Weekly(args)) = cli.command else {
            panic!("expected weekly command");
        };
        assert!(args.shared.json);
        assert!(args.shared.compact);
        assert_eq!(args.start_of_week, WeekDay::Monday);

        let cli = parse(&["ccusage", "claude", "blocks", "--config", path.as_str()]);
        let Some(Command::Blocks(args)) = cli.command else {
            panic!("expected blocks command");
        };
        assert!(args.active);
        assert_eq!(args.token_limit.as_deref(), Some("500000"));
        assert_eq!(args.session_length, 6.0);

        let cli = parse(&["ccusage", "claude", "statusline", "--config", path.as_str()]);
        let Some(Command::Statusline(args)) = cli.command else {
            panic!("expected statusline command");
        };
        assert_eq!(args.visual_burn_rate, VisualBurnRate::EmojiText);
        assert_eq!(args.cost_source, CostSource::Both);
        assert_eq!(args.refresh_interval, 3);

        let cli = parse(&["ccusage", "pi", "daily", "--config", path.as_str()]);
        let Some(Command::Pi(args)) = cli.command else {
            panic!("expected pi command");
        };
        assert_eq!(args.pi_path.as_deref(), Some("/tmp/pi-sessions"));

        let cli = parse(&["ccusage", "openclaw", "daily", "--config", path.as_str()]);
        let Some(Command::OpenClaw(args)) = cli.command else {
            panic!("expected openclaw command");
        };
        assert_eq!(args.open_claw_path.as_deref(), Some("/tmp/openclaw"));
    }

    #[test]
    fn root_help_lists_agent_namespaces_without_nested_commands() {
        let help = help_text();
        let agents = [
            "claude", "codex", "opencode", "amp", "hermes", "pi", "goose", "kilo", "copilot",
            "gemini", "qwen", "kimi", "openclaw",
        ];

        for agent in agents {
            assert!(help.contains(&format!("\n  {agent} ")));
            assert!(!help.contains(&format!("\n  {agent} daily")));
        }
    }

    #[test]
    fn root_help_lists_command_descriptions_and_follow_up_help_commands() {
        let help = help_text();

        assert!(help.contains("codex                      Show Codex token usage commands"));
        assert!(help.contains("For more info, run any command with the `--help` flag:"));
        assert!(help.contains("ccusage codex --help"));
        assert!(!help.contains("ccusage codex daily --help"));
    }

    #[test]
    fn contextual_codex_help_lists_speed_choices() {
        let help = help_text_for_args(&[
            "ccusage".to_string(),
            "codex".to_string(),
            "daily".to_string(),
            "--help".to_string(),
        ]);

        assert!(help.contains("Show Codex token usage grouped by day"));
        assert!(help.contains("USAGE:\n  ccusage codex daily <OPTIONS>"));
        assert!(help.contains("choices: auto | standard | fast"));
    }

    #[test]
    fn contextual_agent_help_lists_agent_subcommands() {
        let help = help_text_for_args(&["ccusage".to_string(), "claude".to_string()]);

        assert!(help.contains("USAGE:\n  ccusage claude <COMMANDS>"));
        assert!(help.contains("daily       Show usage report grouped by date"));
        assert!(help.contains("statusline  Display compact status line for Claude Code hooks"));
        assert!(help.contains("ccusage claude statusline --help"));
        assert!(!help.contains("ccusage claude daily <OPTIONS>"));
    }

    #[test]
    fn contextual_all_agent_help_lists_color_options() {
        let help = help_text_for_args(&["ccusage".to_string(), "daily".to_string()]);

        assert!(help.contains("--color"));
        assert!(help.contains("--no-color"));
    }

    #[test]
    fn contextual_statusline_help_lists_choice_options() {
        let help = help_text_for_args(&["ccusage".to_string(), "statusline".to_string()]);

        assert!(help.contains("choices: off | emoji | text | emoji-text"));
        assert!(help.contains("choices: auto | ccusage | cc | both"));
    }

    #[test]
    fn cargo_version_matches_npm_package_version() {
        let package_json = serde_json::from_str::<serde_json::Value>(include_str!(
            "../../../../apps/ccusage/package.json"
        ))
        .unwrap();

        assert_eq!(
            env!("CARGO_PKG_VERSION"),
            package_json
                .get("version")
                .and_then(serde_json::Value::as_str)
                .unwrap()
        );
    }

    #[test]
    fn parses_claude_daily_options() {
        let cli = parse(&[
            "ccusage",
            "claude",
            "daily",
            "--json",
            "--mode",
            "display",
            "--instances",
            "--project",
            "repo",
        ]);
        let Some(Command::Daily(args)) = cli.command else {
            panic!("expected daily command");
        };
        assert!(args.shared.json);
        assert_eq!(args.shared.mode, CostMode::Display);
        assert!(args.instances);
        assert_eq!(args.project.as_deref(), Some("repo"));
    }

    #[test]
    fn rejects_removed_locale_option() {
        let result = Cli::parse_from(
            ["ccusage", "--locale", "en-CA"]
                .into_iter()
                .map(OsString::from),
        );
        assert!(result.is_err());
    }

    #[test]
    fn parses_blocks_defaults_and_values() {
        let cli = parse(&[
            "ccusage",
            "blocks",
            "--active",
            "--token-limit=max",
            "--session-length",
            "6",
        ]);
        let Some(Command::Blocks(args)) = cli.command else {
            panic!("expected blocks command");
        };
        assert!(args.active);
        assert_eq!(args.token_limit.as_deref(), Some("max"));
        assert_eq!(args.session_length, 6.0);
    }

    #[test]
    fn parses_statusline_options() {
        let cli = parse(&[
            "ccusage",
            "statusline",
            "--no-cache",
            "--visual-burn-rate",
            "emoji-text",
            "--cost-source",
            "both",
        ]);
        let Some(Command::Statusline(args)) = cli.command else {
            panic!("expected statusline command");
        };
        assert!(args.offline);
        assert!(args.no_cache);
        assert_eq!(args.visual_burn_rate, VisualBurnRate::EmojiText);
        assert_eq!(args.cost_source, CostSource::Both);
    }

    #[test]
    fn parses_codex_default_daily_options() {
        let cli = parse(&["ccusage", "codex", "--json", "--since", "20260102"]);
        let Some(Command::Codex(args)) = cli.command else {
            panic!("expected codex command");
        };
        assert_eq!(args.kind, AgentReportKind::Daily);
        assert!(args.shared.json);
        assert_eq!(args.shared.since.as_deref(), Some("20260102"));
    }

    #[test]
    fn parses_codex_speed_option() {
        let cli = parse(&["ccusage", "codex", "daily", "--speed", "fast"]);
        let Some(Command::Codex(args)) = cli.command else {
            panic!("expected codex command");
        };
        assert_eq!(args.codex_speed, CodexSpeed::Fast);
    }

    #[test]
    fn parses_legacy_colon_agent_commands() {
        let cli = parse(&["ccusage", "codex:monthly", "--json"]);
        let Some(Command::Codex(args)) = cli.command else {
            panic!("expected codex command");
        };
        assert_eq!(args.kind, AgentReportKind::Monthly);
        assert!(args.shared.json);
    }

    #[test]
    fn rejects_report_flag_aliases_with_guidance() {
        let error = parse_error(&["ccusage", "--daily"]);
        assert_eq!(
            error,
            "Report flags like --daily are not supported. Use \"ccusage daily\" instead."
        );
    }

    #[test]
    fn rejects_agent_filter_options_with_guidance() {
        let error = parse_error(&["ccusage", "daily", "--agent", "codex"]);
        assert_eq!(
            error,
            "Agent filters like --agent are not supported. Use \"ccusage <agent> <report>\", for example \"ccusage codex daily\"."
        );
    }

    #[test]
    fn rejects_unsupported_agent_reports_with_guidance() {
        let error = parse_error(&["ccusage", "codex", "blocks"]);
        assert_eq!(
            error,
            "The \"blocks\" report is only available for Claude Code usage.\nUse \"ccusage codex daily\" for Codex usage reports."
        );
    }

    #[test]
    fn parses_claude_namespace_session_options() {
        let cli = parse(&["ccusage", "claude", "session", "--json", "--id", "abc"]);
        let Some(Command::Session(args)) = cli.command else {
            panic!("expected claude session command");
        };
        assert!(args.shared.json);
        assert_eq!(args.id.as_deref(), Some("abc"));
    }

    #[test]
    fn parses_opencode_weekly_options() {
        let cli = parse(&["ccusage", "opencode", "weekly", "--json"]);
        let Some(Command::OpenCode(args)) = cli.command else {
            panic!("expected opencode command");
        };
        assert_eq!(args.kind, AgentReportKind::Weekly);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_amp_session_options() {
        let cli = parse(&["ccusage", "amp", "session", "--json"]);
        let Some(Command::Amp(args)) = cli.command else {
            panic!("expected amp command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_pi_session_options() {
        let cli = parse(&[
            "ccusage",
            "pi",
            "session",
            "--json",
            "--pi-path",
            "/tmp/pi-sessions",
        ]);
        let Some(Command::Pi(args)) = cli.command else {
            panic!("expected pi command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
        assert_eq!(args.pi_path.as_deref(), Some("/tmp/pi-sessions"));
    }

    #[test]
    fn parses_kilo_session_options() {
        let cli = parse(&["ccusage", "kilo", "session", "--json"]);
        let Some(Command::Kilo(args)) = cli.command else {
            panic!("expected kilo command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_qwen_session_options() {
        let cli = parse(&["ccusage", "qwen", "session", "--json"]);
        let Some(Command::Qwen(args)) = cli.command else {
            panic!("expected qwen command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_goose_session_options() {
        let cli = parse(&["ccusage", "goose", "session", "--json"]);
        let Some(Command::Goose(args)) = cli.command else {
            panic!("expected goose command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_copilot_session_options() {
        let cli = parse(&["ccusage", "copilot", "session", "--json"]);
        let Some(Command::Copilot(args)) = cli.command else {
            panic!("expected copilot command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_gemini_session_options() {
        let cli = parse(&["ccusage", "gemini", "session", "--json"]);
        let Some(Command::Gemini(args)) = cli.command else {
            panic!("expected gemini command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_kimi_session_options() {
        let cli = parse(&["ccusage", "kimi", "session", "--json"]);
        let Some(Command::Kimi(args)) = cli.command else {
            panic!("expected kimi command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_openclaw_session_options() {
        let cli = parse(&[
            "ccusage",
            "openclaw",
            "session",
            "--json",
            "--open-claw-path",
            "/tmp/openclaw",
        ]);
        let Some(Command::OpenClaw(args)) = cli.command else {
            panic!("expected openclaw command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
        assert_eq!(args.open_claw_path.as_deref(), Some("/tmp/openclaw"));
    }
}
