use std::{env, ffi::OsString, path::PathBuf, process};

pub struct Cli {
    pub command: Option<Command>,
    pub shared: SharedArgs,
}

pub enum Command {
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
    Droid(AgentCommandArgs),
    Codebuff(AgentCommandArgs),
    Hermes(AgentCommandArgs),
    Pi(AgentCommandArgs),
    Goose(AgentCommandArgs),
    Kilo(AgentCommandArgs),
    Copilot(AgentCommandArgs),
    Gemini(AgentCommandArgs),
    Kimi(AgentCommandArgs),
    Qwen(AgentCommandArgs),
    OpenClaw(AgentCommandArgs),
}

#[derive(Clone, Default)]
pub struct SharedArgs {
    pub since: Option<String>,
    pub until: Option<String>,
    pub json: bool,
    pub mode: CostMode,
    pub debug: bool,
    pub debug_samples: usize,
    pub order: SortOrder,
    pub breakdown: bool,
    pub offline: bool,
    pub no_offline: bool,
    pub color: bool,
    pub no_color: bool,
    pub timezone: Option<String>,
    pub jq: Option<String>,
    pub config: Option<PathBuf>,
    pub compact: bool,
    pub single_thread: bool,
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

pub fn normalize_date_bound(value: &str) -> String {
    value.replace('-', "")
}

#[derive(Clone)]
pub struct DailyArgs {
    pub shared: SharedArgs,
    pub instances: bool,
    pub project: Option<String>,
    pub project_aliases: Option<String>,
}

#[derive(Clone)]
pub struct WeeklyArgs {
    pub shared: SharedArgs,
    pub start_of_week: WeekDay,
}

#[derive(Clone)]
pub struct SessionArgs {
    pub shared: SharedArgs,
    pub id: Option<String>,
}

#[derive(Clone)]
pub struct BlocksArgs {
    pub shared: SharedArgs,
    pub active: bool,
    pub recent: bool,
    pub token_limit: Option<String>,
    pub session_length: f64,
}

#[derive(Clone)]
pub struct StatuslineArgs {
    pub offline: bool,
    pub no_offline: bool,
    pub visual_burn_rate: VisualBurnRate,
    pub cost_source: CostSource,
    pub cache: bool,
    pub no_cache: bool,
    pub refresh_interval: u64,
    pub context_low_threshold: u8,
    pub context_medium_threshold: u8,
    pub timezone: Option<String>,
    pub config: Option<PathBuf>,
    pub debug: bool,
}

#[derive(Clone)]
pub struct AgentCommandArgs {
    pub shared: SharedArgs,
    pub kind: AgentReportKind,
    pub pi_path: Option<String>,
    pub open_claw_path: Option<String>,
    pub codex_speed: CodexSpeed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentReportKind {
    Daily,
    Weekly,
    Monthly,
    Session,
}

const STANDARD_AGENT_REPORTS: &[(&str, AgentReportKind)] = &[
    ("daily", AgentReportKind::Daily),
    ("monthly", AgentReportKind::Monthly),
    ("session", AgentReportKind::Session),
];

const OPENCODE_AGENT_REPORTS: &[(&str, AgentReportKind)] = &[
    ("daily", AgentReportKind::Daily),
    ("weekly", AgentReportKind::Weekly),
    ("monthly", AgentReportKind::Monthly),
    ("session", AgentReportKind::Session),
];

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CodexSpeed {
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
            timezone: None,
            config: None,
            debug: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CostMode {
    #[default]
    Auto,
    Calculate,
    Display,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SortOrder {
    Desc,
    #[default]
    Asc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WeekDay {
    Sunday,
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VisualBurnRate {
    Off,
    Emoji,
    Text,
    EmojiText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CostSource {
    Auto,
    Ccusage,
    Cc,
    Both,
}

pub trait CliConfig {
    fn apply_shared(&self, _shared: &mut SharedArgs) {}

    fn apply_daily_args(&self, _args: &mut DailyArgs) {}

    fn apply_weekly_args(&self, _args: &mut WeeklyArgs) {}

    fn apply_blocks_args(&self, _args: &mut BlocksArgs) {}

    fn apply_statusline_args(&self, _args: &mut StatuslineArgs) {}

    fn apply_agent_args(
        &self,
        _codex_speed: &mut CodexSpeed,
        _pi_path: Option<&mut Option<String>>,
        _open_claw_path: Option<&mut Option<String>>,
    ) {
    }
}

pub struct NoConfig;

impl CliConfig for NoConfig {}

impl Cli {
    pub fn parse() -> Self {
        Self::parse_from(env::args_os()).unwrap_or_else(|message| {
            eprintln!("{message}");
            eprintln!("Run 'ccusage --help' for usage.");
            process::exit(2);
        })
    }

    pub fn parse_from<I>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = OsString>,
    {
        Self::parse_from_with_config(args, &NoConfig, 5.0, env!("CARGO_PKG_VERSION"))
    }

    pub fn parse_from_with_config<I>(
        args: I,
        config: &dyn CliConfig,
        default_session_duration_hours: f64,
        version: &'static str,
    ) -> Result<Self, String>
    where
        I: IntoIterator<Item = OsString>,
    {
        let mut parser = ArgParser::new(args.into_iter().skip(1).collect(), version)?;
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
            print_version_and_exit(version);
        }
        if parser
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "-h" | "--help"))
        {
            print_help_and_exit(&parser.args);
        }

        let mut shared = SharedArgs::with_defaults();
        config.apply_shared(&mut shared);
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
                config,
                default_session_duration_hours,
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
    config: &dyn CliConfig,
    default_session_duration_hours: f64,
) -> Result<Command, String> {
    match command {
        "daily" => parse_all_command(parser, shared, AgentReportKind::Daily, config),
        "monthly" => parse_all_command(parser, shared, AgentReportKind::Monthly, config),
        "weekly" => parse_all_command(parser, shared, AgentReportKind::Weekly, config),
        "session" => parse_top_level_session_command(parser, shared, config),
        "blocks" => {
            let mut args = BlocksArgs {
                shared,
                active: false,
                recent: false,
                token_limit: None,
                session_length: default_session_duration_hours,
            };
            config.apply_blocks_args(&mut args);
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
            config.apply_statusline_args(&mut args);
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
                    "-z" | "--timezone" => args.timezone = Some(parser.value_for("--timezone")?),
                    "--config" => args.config = Some(PathBuf::from(parser.value_for("--config")?)),
                    "--debug" => args.debug = true,
                    flag => return Err(format!("Unknown statusline option '{flag}'")),
                }
            }
            Ok(Command::Statusline(args))
        }
        "claude" => parse_claude_command(parser, shared, config, default_session_duration_hours),
        "codex" => parse_codex_command(parser, shared, config),
        "opencode" => parse_basic_agent_command(
            parser,
            shared,
            "opencode",
            OPENCODE_AGENT_REPORTS,
            Command::OpenCode,
        ),
        "amp" => {
            parse_basic_agent_command(parser, shared, "amp", STANDARD_AGENT_REPORTS, Command::Amp)
        }
        "droid" => parse_basic_agent_command(
            parser,
            shared,
            "droid",
            STANDARD_AGENT_REPORTS,
            Command::Droid,
        ),
        "codebuff" => parse_basic_agent_command(
            parser,
            shared,
            "codebuff",
            STANDARD_AGENT_REPORTS,
            Command::Codebuff,
        ),
        "hermes" => parse_basic_agent_command(
            parser,
            shared,
            "hermes",
            STANDARD_AGENT_REPORTS,
            Command::Hermes,
        ),
        "pi" => parse_pi_command(parser, shared, config),
        "goose" => parse_basic_agent_command(
            parser,
            shared,
            "goose",
            STANDARD_AGENT_REPORTS,
            Command::Goose,
        ),
        "kilo" => parse_basic_agent_command(
            parser,
            shared,
            "kilo",
            STANDARD_AGENT_REPORTS,
            Command::Kilo,
        ),
        "copilot" => parse_basic_agent_command(
            parser,
            shared,
            "copilot",
            STANDARD_AGENT_REPORTS,
            Command::Copilot,
        ),
        "gemini" => parse_basic_agent_command(
            parser,
            shared,
            "gemini",
            STANDARD_AGENT_REPORTS,
            Command::Gemini,
        ),
        "kimi" => parse_basic_agent_command(
            parser,
            shared,
            "kimi",
            STANDARD_AGENT_REPORTS,
            Command::Kimi,
        ),
        "qwen" => parse_basic_agent_command(
            parser,
            shared,
            "qwen",
            STANDARD_AGENT_REPORTS,
            Command::Qwen,
        ),
        "openclaw" => parse_openclaw_command(parser, shared, config),
        _ => Err(format!("Unknown command '{command}'")),
    }
}

fn parse_all_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    kind: AgentReportKind,
    _config: &dyn CliConfig,
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

fn parse_top_level_session_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    _config: &dyn CliConfig,
) -> Result<Command, String> {
    let mut args = SessionArgs { shared, id: None };
    while parser.peek().is_some() {
        if matches!(parser.peek(), Some("--all")) {
            parser.next();
            continue;
        }
        if parse_shared_arg_for_command(parser, &mut args.shared)? {
            continue;
        }
        match parser.next_flag()?.as_str() {
            "-i" | "--id" => args.id = Some(parser.value_for("--id")?),
            flag => return Err(format!("Unknown session option '{flag}'")),
        }
    }

    if args.id.is_some() {
        return Ok(Command::Session(args));
    }

    Ok(Command::All(AgentCommandArgs {
        shared: args.shared,
        kind: AgentReportKind::Session,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }))
}

fn parse_claude_daily_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    config: &dyn CliConfig,
) -> Result<Command, String> {
    let mut args = DailyArgs {
        shared,
        instances: false,
        project: None,
        project_aliases: None,
    };
    config.apply_daily_args(&mut args);
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
    _config: &dyn CliConfig,
) -> Result<Command, String> {
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Monthly(shared))
}

fn parse_claude_weekly_command(
    parser: &mut ArgParser,
    shared: SharedArgs,
    config: &dyn CliConfig,
) -> Result<Command, String> {
    let mut args = WeeklyArgs {
        shared,
        start_of_week: WeekDay::Sunday,
    };
    config.apply_weekly_args(&mut args);
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
    _config: &dyn CliConfig,
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
    config: &dyn CliConfig,
    default_session_duration_hours: f64,
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
        "blocks" | "statusline" => parse_command(
            &command,
            parser,
            shared,
            config,
            default_session_duration_hours,
        ),
        _ => unreachable!("claude command is prevalidated"),
    }
}

fn parse_basic_agent_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    agent: &str,
    reports: &[(&str, AgentReportKind)],
    command: fn(AgentCommandArgs) -> Command,
) -> Result<Command, String> {
    let kind = parse_agent_report_kind(parser, agent, reports)?;
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(command(agent_command_args(shared, kind)))
}

fn parse_codex_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    config: &dyn CliConfig,
) -> Result<Command, String> {
    let kind = parse_agent_report_kind(parser, "codex", STANDARD_AGENT_REPORTS)?;
    let mut codex_speed = CodexSpeed::Auto;
    config.apply_agent_args(&mut codex_speed, None, None);
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

fn parse_pi_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    config: &dyn CliConfig,
) -> Result<Command, String> {
    let kind = parse_agent_report_kind(parser, "pi", STANDARD_AGENT_REPORTS)?;
    let mut pi_path = None;
    let mut codex_speed = CodexSpeed::Auto;
    config.apply_agent_args(&mut codex_speed, Some(&mut pi_path), None);
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

fn parse_openclaw_command(
    parser: &mut ArgParser,
    mut shared: SharedArgs,
    config: &dyn CliConfig,
) -> Result<Command, String> {
    let kind = parse_agent_report_kind(parser, "openclaw", STANDARD_AGENT_REPORTS)?;
    let mut open_claw_path = None;
    let mut codex_speed = CodexSpeed::Auto;
    config.apply_agent_args(&mut codex_speed, None, Some(&mut open_claw_path));
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

fn parse_agent_report_kind(
    parser: &mut ArgParser,
    agent: &str,
    reports: &[(&str, AgentReportKind)],
) -> Result<AgentReportKind, String> {
    let Some(command) = parser.peek() else {
        return Ok(AgentReportKind::Daily);
    };
    if let Some((_, kind)) = reports.iter().find(|(report, _)| *report == command) {
        parser.next();
        return Ok(*kind);
    }
    if !command.starts_with('-') {
        return Err(format!("Unknown {agent} command '{command}'"));
    }
    Ok(AgentReportKind::Daily)
}

fn agent_command_args(shared: SharedArgs, kind: AgentReportKind) -> AgentCommandArgs {
    AgentCommandArgs {
        shared,
        kind,
        pi_path: None,
        open_claw_path: None,
        codex_speed: CodexSpeed::Auto,
    }
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
        "-s" | "--since" => {
            shared.since = Some(normalize_date_bound(&parser.value_for("--since")?))
        }
        "-u" | "--until" => {
            shared.until = Some(normalize_date_bound(&parser.value_for("--until")?))
        }
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
            | "droid"
            | "codebuff"
            | "hermes"
            | "pi"
            | "goose"
            | "openclaw"
            | "kilo"
            | "copilot"
            | "gemini"
            | "kimi"
            | "qwen"
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
            | "droid"
            | "codebuff"
            | "hermes"
            | "pi"
            | "goose"
            | "kilo"
            | "copilot"
            | "gemini"
            | "kimi"
            | "qwen"
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
        "amp" | "droid" | "codebuff" | "hermes" | "pi" | "goose" | "kilo" | "copilot"
        | "gemini" | "kimi" | "qwen" | "openclaw" => {
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
        "droid" => "Droid",
        "codebuff" => "Codebuff",
        "hermes" => "Hermes",
        "pi" => "pi-agent",
        "goose" => "Goose",
        "kilo" => "Kilo",
        "copilot" => "GitHub Copilot CLI",
        "gemini" => "Gemini CLI",
        "kimi" => "Kimi",
        "qwen" => "Qwen",
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
    version: &'static str,
}

impl ArgParser {
    fn new(args: Vec<OsString>, version: &'static str) -> Result<Self, String> {
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
            version,
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
            print_help_or_version_arg(&arg, self.version);
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

fn print_help_or_version_arg(arg: &str, version: &'static str) -> ! {
    match arg {
        "-v" | "-V" | "--version" => print_version_and_exit(version),
        _ => println!("{}", help_text()),
    }
    process::exit(0);
}

fn print_version_and_exit(version: &str) -> ! {
    println!("ccusage {version}");
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
            "droid" => agent_help(
                "droid",
                &[
                    ("daily", "Show Droid usage grouped by date"),
                    ("monthly", "Show Droid usage grouped by month"),
                    ("session", "Show Droid usage grouped by session"),
                ],
            ),
            "codebuff" => agent_help(
                "codebuff",
                &[
                    ("daily", "Show Codebuff usage grouped by date"),
                    ("monthly", "Show Codebuff usage grouped by month"),
                    ("session", "Show Codebuff usage grouped by session"),
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
            "qwen" => agent_help(
                "qwen",
                &[
                    ("daily", "Show Qwen usage grouped by date"),
                    ("monthly", "Show Qwen usage grouped by month"),
                    ("session", "Show Qwen usage grouped by session"),
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
            "droid" => droid_report_help(report),
            "codebuff" => codebuff_report_help(report),
            "hermes" => hermes_report_help(report),
            "pi" => pi_report_help(report),
            "goose" => goose_report_help(report),
            "kilo" => kilo_report_help(report),
            "copilot" => copilot_report_help(report),
            "gemini" => gemini_report_help(report),
            "kimi" => kimi_report_help(report),
            "qwen" => qwen_report_help(report),
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
        "  droid                      Show Droid usage commands",
        "  codebuff                   Show Codebuff usage commands",
        "  hermes                     Show Hermes usage commands",
        "  pi                         Show pi-agent usage commands",
        "  goose                      Show Goose usage commands",
        "  kilo                       Show Kilo usage commands",
        "  copilot                    Show GitHub Copilot CLI usage commands",
        "  gemini                     Show Gemini CLI usage commands",
        "  kimi                       Show Kimi usage commands",
        "  qwen                       Show Qwen usage commands",
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
        "  ccusage droid --help",
        "  ccusage codebuff --help",
        "  ccusage hermes --help",
        "  ccusage pi --help",
        "  ccusage goose --help",
        "  ccusage kilo --help",
        "  ccusage copilot --help",
        "  ccusage gemini --help",
        "  ccusage kimi --help",
        "  ccusage qwen --help",
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
    let options = if report == "session" {
        all_agent_session_options()
    } else {
        all_agent_options()
    };
    command_help(description, &format!("ccusage {report} <OPTIONS>"), options)
}

fn claude_report_help(report: &str) -> String {
    let (description, options) = match report {
        "daily" => ("Show usage report grouped by date", claude_daily_options()),
        "monthly" => (
            "Show usage report grouped by month",
            shared_claude_options(),
        ),
        "weekly" => ("Show usage report grouped by week", claude_weekly_options()),
        "session" => (
            "Show usage report grouped by conversation session",
            claude_session_options(),
        ),
        _ => unreachable!("Claude report is prevalidated"),
    };
    command_help(
        description,
        &format!("ccusage claude {report} <OPTIONS>"),
        options,
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

fn droid_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Droid usage grouped by date",
        "monthly" => "Show Droid usage grouped by month",
        "session" => "Show Droid usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage droid {report} <OPTIONS>"),
        agent_options(),
    )
}

fn codebuff_report_help(report: &str) -> String {
    let description = match report {
        "daily" => "Show Codebuff usage grouped by date",
        "monthly" => "Show Codebuff usage grouped by month",
        "session" => "Show Codebuff usage grouped by session",
        _ => return root_help_text(),
    };
    command_help(
        description,
        &format!("ccusage codebuff {report} <OPTIONS>"),
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
        pi_combined_options(),
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
        openclaw_combined_options(),
    )
}

fn blocks_help(usage: &str) -> String {
    command_help(
        "Show usage report grouped by session billing blocks",
        &format!("{usage} <OPTIONS>"),
        blocks_combined_options(),
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

include!(concat!(env!("OUT_DIR"), "/cli-help.rs"));

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(args.iter().map(OsString::from)).unwrap()
    }

    fn parse_with_config(args: &[&str], config: &dyn CliConfig) -> Cli {
        Cli::parse_from_with_config(
            args.iter().map(OsString::from),
            config,
            5.0,
            env!("CARGO_PKG_VERSION"),
        )
        .unwrap()
    }

    fn parse_error(args: &[&str]) -> String {
        match Cli::parse_from(args.iter().map(OsString::from)) {
            Ok(_) => panic!("expected parse error"),
            Err(error) => error,
        }
    }

    #[derive(Default)]
    struct TestConfig {
        shared_json: Option<bool>,
        shared_order: Option<SortOrder>,
        shared_since: Option<&'static str>,
        shared_timezone: Option<&'static str>,
        shared_compact: Option<bool>,
        weekly_start: Option<WeekDay>,
        blocks_active: Option<bool>,
        blocks_token_limit: Option<&'static str>,
        blocks_session_length: Option<f64>,
        statusline_visual_burn_rate: Option<VisualBurnRate>,
        statusline_cost_source: Option<CostSource>,
        statusline_refresh_interval: Option<u64>,
        codex_speed: Option<CodexSpeed>,
        pi_path: Option<&'static str>,
        open_claw_path: Option<&'static str>,
    }

    impl CliConfig for TestConfig {
        fn apply_shared(&self, shared: &mut SharedArgs) {
            if let Some(json) = self.shared_json {
                shared.json = json;
            }
            if let Some(order) = self.shared_order {
                shared.order = order;
            }
            if let Some(since) = self.shared_since {
                shared.since = Some(since.to_string());
            }
            if let Some(timezone) = self.shared_timezone {
                shared.timezone = Some(timezone.to_string());
            }
            if let Some(compact) = self.shared_compact {
                shared.compact = compact;
            }
        }

        fn apply_weekly_args(&self, args: &mut WeeklyArgs) {
            if let Some(start_of_week) = self.weekly_start {
                args.start_of_week = start_of_week;
            }
        }

        fn apply_blocks_args(&self, args: &mut BlocksArgs) {
            if let Some(active) = self.blocks_active {
                args.active = active;
            }
            if let Some(token_limit) = self.blocks_token_limit {
                args.token_limit = Some(token_limit.to_string());
            }
            if let Some(session_length) = self.blocks_session_length {
                args.session_length = session_length;
            }
        }

        fn apply_statusline_args(&self, args: &mut StatuslineArgs) {
            if let Some(visual_burn_rate) = self.statusline_visual_burn_rate {
                args.visual_burn_rate = visual_burn_rate;
            }
            if let Some(cost_source) = self.statusline_cost_source {
                args.cost_source = cost_source;
            }
            if let Some(refresh_interval) = self.statusline_refresh_interval {
                args.refresh_interval = refresh_interval;
            }
        }

        fn apply_agent_args(
            &self,
            codex_speed: &mut CodexSpeed,
            pi_path: Option<&mut Option<String>>,
            open_claw_path: Option<&mut Option<String>>,
        ) {
            if let Some(speed) = self.codex_speed {
                *codex_speed = speed;
            }
            if let (Some(path), Some(pi_path)) = (self.pi_path, pi_path) {
                *pi_path = Some(path.to_string());
            }
            if let (Some(path), Some(open_claw_path)) = (self.open_claw_path, open_claw_path) {
                *open_claw_path = Some(path.to_string());
            }
        }
    }

    fn shared_snapshot(shared: &SharedArgs) -> Value {
        json!({
            "since": shared.since.as_deref(),
            "until": shared.until.as_deref(),
            "json": shared.json,
            "mode": format!("{:?}", shared.mode),
            "debug": shared.debug,
            "debugSamples": shared.debug_samples,
            "order": format!("{:?}", shared.order),
            "breakdown": shared.breakdown,
            "offline": shared.offline,
            "noOffline": shared.no_offline,
            "color": shared.color,
            "noColor": shared.no_color,
            "timezone": shared.timezone.as_deref(),
            "jq": shared.jq.as_deref(),
            "config": shared.config.as_ref().map(|path| path.to_string_lossy().to_string()),
            "compact": shared.compact,
            "singleThread": shared.single_thread,
        })
    }

    fn cli_snapshot(cli: Cli) -> Value {
        json!({
            "shared": shared_snapshot(&cli.shared),
            "command": command_snapshot(cli.command),
        })
    }

    fn command_snapshot(command: Option<Command>) -> Value {
        match command {
            None => Value::Null,
            Some(Command::All(args)) => agent_command_snapshot("all", args),
            Some(Command::Daily(args)) => json!({
                "type": "daily",
                "shared": shared_snapshot(&args.shared),
                "instances": args.instances,
                "project": args.project,
                "projectAliases": args.project_aliases,
            }),
            Some(Command::Monthly(shared)) => json!({
                "type": "monthly",
                "shared": shared_snapshot(&shared),
            }),
            Some(Command::Weekly(args)) => json!({
                "type": "weekly",
                "shared": shared_snapshot(&args.shared),
                "startOfWeek": format!("{:?}", args.start_of_week),
            }),
            Some(Command::Session(args)) => json!({
                "type": "session",
                "shared": shared_snapshot(&args.shared),
                "id": args.id,
            }),
            Some(Command::Blocks(args)) => json!({
                "type": "blocks",
                "shared": shared_snapshot(&args.shared),
                "active": args.active,
                "recent": args.recent,
                "tokenLimit": args.token_limit,
                "sessionLength": args.session_length,
            }),
            Some(Command::Statusline(args)) => json!({
                "type": "statusline",
                "offline": args.offline,
                "noOffline": args.no_offline,
                "visualBurnRate": format!("{:?}", args.visual_burn_rate),
                "costSource": format!("{:?}", args.cost_source),
                "cache": args.cache,
                "noCache": args.no_cache,
                "refreshInterval": args.refresh_interval,
                "contextLowThreshold": args.context_low_threshold,
                "contextMediumThreshold": args.context_medium_threshold,
                "config": args.config.as_ref().map(|path| path.to_string_lossy().to_string()),
                "debug": args.debug,
            }),
            Some(Command::Codex(args)) => agent_command_snapshot("codex", args),
            Some(Command::OpenCode(args)) => agent_command_snapshot("opencode", args),
            Some(Command::Amp(args)) => agent_command_snapshot("amp", args),
            Some(Command::Droid(args)) => agent_command_snapshot("droid", args),
            Some(Command::Codebuff(args)) => agent_command_snapshot("codebuff", args),
            Some(Command::Hermes(args)) => agent_command_snapshot("hermes", args),
            Some(Command::Pi(args)) => agent_command_snapshot("pi", args),
            Some(Command::Goose(args)) => agent_command_snapshot("goose", args),
            Some(Command::Kilo(args)) => agent_command_snapshot("kilo", args),
            Some(Command::Copilot(args)) => agent_command_snapshot("copilot", args),
            Some(Command::Gemini(args)) => agent_command_snapshot("gemini", args),
            Some(Command::Kimi(args)) => agent_command_snapshot("kimi", args),
            Some(Command::Qwen(args)) => agent_command_snapshot("qwen", args),
            Some(Command::OpenClaw(args)) => agent_command_snapshot("openclaw", args),
        }
    }

    fn agent_command_snapshot(agent: &str, args: AgentCommandArgs) -> Value {
        json!({
            "type": agent,
            "shared": shared_snapshot(&args.shared),
            "kind": format!("{:?}", args.kind),
            "piPath": args.pi_path,
            "openClawPath": args.open_claw_path,
            "codexSpeed": format!("{:?}", args.codex_speed),
        })
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
    fn parses_root_session_as_all_agent_report_without_id() {
        let cli = parse(&["ccusage", "session", "--json"]);
        let Some(Command::All(args)) = cli.command else {
            panic!("expected all-agent command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn applies_config_defaults_and_command_options_before_cli_options() {
        let config = TestConfig {
            shared_json: Some(true),
            shared_order: Some(SortOrder::Desc),
            shared_since: Some("20260102"),
            ..TestConfig::default()
        };

        let cli = parse_with_config(&["ccusage", "daily", "--order", "asc"], &config);
        let Some(Command::All(args)) = cli.command else {
            panic!("expected all-agent command");
        };
        assert!(args.shared.json);
        assert_eq!(args.shared.since.as_deref(), Some("20260102"));
        assert_eq!(args.shared.order, SortOrder::Asc);
    }

    #[test]
    fn applies_agent_namespace_config_to_codex_speed() {
        let config = TestConfig {
            codex_speed: Some(CodexSpeed::Fast),
            ..TestConfig::default()
        };

        let cli = parse_with_config(&["ccusage", "codex", "daily"], &config);
        let Some(Command::Codex(args)) = cli.command else {
            panic!("expected codex command");
        };
        assert_eq!(args.codex_speed, CodexSpeed::Fast);
    }

    #[test]
    fn applies_config_file_passed_after_agent_command() {
        let config = TestConfig {
            shared_json: Some(true),
            shared_timezone: Some("Asia/Tokyo"),
            shared_since: Some("20260101"),
            codex_speed: Some(CodexSpeed::Standard),
            ..TestConfig::default()
        };

        let cli = parse_with_config(
            &[
                "ccusage",
                "codex",
                "monthly",
                "--config",
                "/tmp/ccusage.json",
            ],
            &config,
        );
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
        let config = TestConfig {
            shared_json: Some(true),
            shared_compact: Some(true),
            weekly_start: Some(WeekDay::Monday),
            blocks_active: Some(true),
            blocks_token_limit: Some("500000"),
            blocks_session_length: Some(6.0),
            statusline_visual_burn_rate: Some(VisualBurnRate::EmojiText),
            statusline_cost_source: Some(CostSource::Both),
            statusline_refresh_interval: Some(3),
            pi_path: Some("/tmp/pi-sessions"),
            open_claw_path: Some("/tmp/openclaw"),
            ..TestConfig::default()
        };

        let cli = parse_with_config(&["ccusage", "claude", "weekly"], &config);
        let Some(Command::Weekly(args)) = cli.command else {
            panic!("expected weekly command");
        };
        assert!(args.shared.json);
        assert!(args.shared.compact);
        assert_eq!(args.start_of_week, WeekDay::Monday);

        let cli = parse_with_config(&["ccusage", "claude", "blocks"], &config);
        let Some(Command::Blocks(args)) = cli.command else {
            panic!("expected blocks command");
        };
        assert!(args.active);
        assert_eq!(args.token_limit.as_deref(), Some("500000"));
        assert_eq!(args.session_length, 6.0);

        let cli = parse_with_config(&["ccusage", "claude", "statusline"], &config);
        let Some(Command::Statusline(args)) = cli.command else {
            panic!("expected statusline command");
        };
        assert_eq!(args.visual_burn_rate, VisualBurnRate::EmojiText);
        assert_eq!(args.cost_source, CostSource::Both);
        assert_eq!(args.refresh_interval, 3);

        let cli = parse_with_config(&["ccusage", "pi", "daily"], &config);
        let Some(Command::Pi(args)) = cli.command else {
            panic!("expected pi command");
        };
        assert_eq!(args.pi_path.as_deref(), Some("/tmp/pi-sessions"));

        let cli = parse_with_config(&["ccusage", "openclaw", "daily"], &config);
        let Some(Command::OpenClaw(args)) = cli.command else {
            panic!("expected openclaw command");
        };
        assert_eq!(args.open_claw_path.as_deref(), Some("/tmp/openclaw"));
    }

    #[test]
    fn root_help_lists_agent_namespaces_without_nested_commands() {
        let help = help_text();
        let agents = [
            "claude", "codex", "opencode", "amp", "droid", "codebuff", "hermes", "pi", "goose",
            "kilo", "copilot", "gemini", "kimi", "qwen", "openclaw",
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
    fn contextual_root_session_help_lists_id_option() {
        let help = help_text_for_args(&["ccusage".to_string(), "session".to_string()]);

        assert!(help.contains("--id"));
    }

    #[test]
    fn contextual_statusline_help_lists_choice_options() {
        let help = help_text_for_args(&["ccusage".to_string(), "statusline".to_string()]);

        assert!(help.contains("choices: off | emoji | text | emoji-text"));
        assert!(help.contains("choices: auto | ccusage | cc | both"));
    }

    #[test]
    fn snapshots_root_and_contextual_help_text() {
        insta::assert_snapshot!("root_help", help_text());
        insta::assert_snapshot!(
            "claude_agent_help",
            help_text_for_args(&["ccusage".to_string(), "claude".to_string()])
        );
        insta::assert_snapshot!(
            "codex_daily_help",
            help_text_for_args(&[
                "ccusage".to_string(),
                "codex".to_string(),
                "daily".to_string(),
            ])
        );
        insta::assert_snapshot!(
            "statusline_help",
            help_text_for_args(&["ccusage".to_string(), "statusline".to_string()])
        );
    }

    #[test]
    fn snapshots_representative_cli_parse_shapes() {
        let cases = vec![
            json!({
                "case": "default all-agent daily",
                "cli": cli_snapshot(parse(&["ccusage"])),
            }),
            json!({
                "case": "root daily with shared flags",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "--json",
                    "--since=20260102",
                    "--until",
                    "20260110",
                    "--mode",
                    "calculate",
                    "--debug",
                    "--debug-samples",
                    "9",
                    "--order",
                    "desc",
                    "--breakdown",
                    "--offline",
                    "--no-offline",
                    "--color",
                    "--no-color",
                    "--timezone",
                    "Asia/Tokyo",
                    "--jq",
                    ".totals",
                    "--compact",
                    "--single-thread",
                    "daily",
                ])),
            }),
            json!({
                "case": "claude weekly monday",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "claude",
                    "weekly",
                    "--start-of-week",
                    "monday",
                ])),
            }),
            json!({
                "case": "claude daily project instances",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "claude",
                    "daily",
                    "--instances",
                    "--project",
                    "repo",
                    "--project-aliases",
                    "repo=Repository",
                ])),
            }),
            json!({
                "case": "codex monthly fast",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "codex",
                    "monthly",
                    "--speed=fast",
                ])),
            }),
            json!({
                "case": "opencode weekly",
                "cli": cli_snapshot(parse(&["ccusage", "opencode", "weekly", "--json"])),
            }),
            json!({
                "case": "pi session path",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "pi",
                    "session",
                    "--pi-path",
                    "/tmp/pi-sessions",
                ])),
            }),
            json!({
                "case": "openclaw session path",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "openclaw",
                    "session",
                    "--open-claw-path=/tmp/openclaw",
                ])),
            }),
            json!({
                "case": "blocks active recent",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "blocks",
                    "--active",
                    "--recent",
                    "--token-limit",
                    "max",
                    "--session-length=6.5",
                ])),
            }),
            json!({
                "case": "statusline thresholds",
                "cli": cli_snapshot(parse(&[
                    "ccusage",
                    "statusline",
                    "--no-offline",
                    "--visual-burn-rate",
                    "emoji-text",
                    "--cost-source",
                    "both",
                    "--no-cache",
                    "--refresh-interval",
                    "3",
                    "--context-low-threshold",
                    "45",
                    "--context-medium-threshold",
                    "75",
                    "--debug",
                ])),
            }),
        ];

        insta::assert_json_snapshot!(cases);
    }

    #[test]
    fn snapshots_cli_parse_error_guidance() {
        let cases = vec![
            json!({
                "args": ["ccusage", "--daily"],
                "error": parse_error(&["ccusage", "--daily"]),
            }),
            json!({
                "args": ["ccusage", "daily", "--agent", "codex"],
                "error": parse_error(&["ccusage", "daily", "--agent", "codex"]),
            }),
            json!({
                "args": ["ccusage", "codex", "blocks"],
                "error": parse_error(&["ccusage", "codex", "blocks"]),
            }),
            json!({
                "args": ["ccusage", "--mode", "bad"],
                "error": parse_error(&["ccusage", "--mode", "bad"]),
            }),
            json!({
                "args": ["ccusage", "blocks", "--session-length", "abc"],
                "error": parse_error(&["ccusage", "blocks", "--session-length", "abc"]),
            }),
            json!({
                "args": ["ccusage", "statusline", "--visual-burn-rate", "loud"],
                "error": parse_error(&[
                    "ccusage",
                    "statusline",
                    "--visual-burn-rate",
                    "loud",
                ]),
            }),
            json!({
                "args": ["ccusage", "pi", "weekly"],
                "error": parse_error(&["ccusage", "pi", "weekly"]),
            }),
        ];

        insta::assert_json_snapshot!(cases);
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
            "--timezone",
            "Asia/Tokyo",
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
        assert_eq!(args.timezone.as_deref(), Some("Asia/Tokyo"));
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
    fn parses_top_level_session_id_lookup() {
        let cli = parse(&["ccusage", "session", "--json", "--id", "abc"]);
        let Some(Command::Session(args)) = cli.command else {
            panic!("expected session command");
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
    fn parses_droid_session_options() {
        let cli = parse(&["ccusage", "droid", "session", "--json"]);
        let Some(Command::Droid(args)) = cli.command else {
            panic!("expected droid command");
        };
        assert_eq!(args.kind, AgentReportKind::Session);
        assert!(args.shared.json);
    }

    #[test]
    fn parses_codebuff_session_options() {
        let cli = parse(&["ccusage", "codebuff", "session", "--json"]);
        let Some(Command::Codebuff(args)) = cli.command else {
            panic!("expected codebuff command");
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
