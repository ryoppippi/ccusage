use std::{env, ffi::OsString, path::PathBuf, process};

use crate::DEFAULT_SESSION_DURATION_HOURS;

pub(crate) struct Cli {
    pub(crate) command: Option<Command>,
    pub(crate) shared: SharedArgs,
}

pub(crate) enum Command {
    Daily(DailyArgs),
    Monthly(SharedArgs),
    Weekly(WeeklyArgs),
    Session(SessionArgs),
    Blocks(BlocksArgs),
    Statusline(StatuslineArgs),
    Codex(AgentCommandArgs),
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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AgentReportKind {
    Daily,
    Monthly,
    Session,
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
        if parser.peek_help_or_version() {
            parser.print_help_or_version();
        }

        let mut shared = SharedArgs::with_defaults();
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
            Some(command) => Some(parse_command(&command, &mut parser, shared.clone())?),
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
    mut shared: SharedArgs,
) -> Result<Command, String> {
    match command {
        "daily" => {
            let mut args = DailyArgs {
                shared,
                instances: false,
                project: None,
                project_aliases: None,
            };
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
        "monthly" => {
            while parser.peek().is_some() {
                parse_shared_arg(parser, &mut shared)?;
            }
            Ok(Command::Monthly(shared))
        }
        "weekly" => {
            let mut args = WeeklyArgs {
                shared,
                start_of_week: WeekDay::Sunday,
            };
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
        "session" => {
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
        "blocks" => {
            let mut args = BlocksArgs {
                shared,
                active: false,
                recent: false,
                token_limit: None,
                session_length: DEFAULT_SESSION_DURATION_HOURS,
            };
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
        "claude" => parse_claude_command(parser, shared),
        "codex" => parse_codex_command(parser, shared),
        _ => Err(format!("Unknown command '{command}'")),
    }
}

fn parse_claude_command(parser: &mut ArgParser, shared: SharedArgs) -> Result<Command, String> {
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
    parse_command(&command, parser, shared)
}

fn parse_codex_command(parser: &mut ArgParser, mut shared: SharedArgs) -> Result<Command, String> {
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
    while parser.peek().is_some() {
        parse_shared_arg(parser, &mut shared)?;
    }
    Ok(Command::Codex(AgentCommandArgs { shared, kind }))
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
        "daily" | "monthly" | "weekly" | "session" | "blocks" | "statusline" | "claude" | "codex"
    )
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
        if matches!(arg.as_str(), "-h" | "--help" | "-V" | "--version") {
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

    fn peek_help_or_version(&self) -> bool {
        matches!(self.peek(), Some("-h" | "--help" | "-V" | "--version"))
    }

    fn print_help_or_version(&mut self) -> ! {
        print_help_or_version_arg(self.next().as_deref().unwrap_or("--help"))
    }
}

fn print_help_or_version_arg(arg: &str) -> ! {
    match arg {
        "-V" | "--version" => println!("ccusage {}", env!("CARGO_PKG_VERSION")),
        _ => println!("{}", help_text()),
    }
    process::exit(0);
}

fn help_text() -> &'static str {
    "Usage: ccusage [OPTIONS] [COMMAND]\n\nCommands:\n  daily\n  monthly\n  weekly\n  session\n  blocks\n  statusline\n\nOptions:\n  -s, --since <YYYYMMDD>\n  -u, --until <YYYYMMDD>\n  -j, --json\n  -m, --mode <auto|calculate|display>\n  -d, --debug\n      --debug-samples <N>\n  -o, --order <asc|desc>\n  -b, --breakdown\n  -O, --offline\n      --no-offline\n      --color\n      --no-color\n  -z, --timezone <TZ>\n  -q, --jq <QUERY>\n      --config <PATH>\n      --compact\n      --single-thread\n  -h, --help\n  -V, --version"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Cli {
        Cli::parse_from(args.iter().map(OsString::from)).unwrap()
    }

    #[test]
    fn parses_daily_options() {
        let cli = parse(&[
            "ccusage",
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
    fn parses_claude_namespace_session_options() {
        let cli = parse(&["ccusage", "claude", "session", "--json", "--id", "abc"]);
        let Some(Command::Session(args)) = cli.command else {
            panic!("expected claude session command");
        };
        assert!(args.shared.json);
        assert_eq!(args.id.as_deref(), Some("abc"));
    }
}
