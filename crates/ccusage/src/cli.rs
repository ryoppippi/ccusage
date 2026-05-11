use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

use crate::DEFAULT_SESSION_DURATION_HOURS;

#[derive(Parser)]
#[command(
    name = "ccusage",
    version,
    about = "Usage analysis tool for Claude Code"
)]
pub(crate) struct Cli {
    #[command(subcommand)]
    pub(crate) command: Option<Command>,

    #[command(flatten)]
    pub(crate) shared: SharedArgs,
}

#[derive(Subcommand)]
pub(crate) enum Command {
    Daily(DailyArgs),
    Monthly(SharedArgs),
    Weekly(WeeklyArgs),
    Session(SessionArgs),
    Blocks(BlocksArgs),
    Statusline(StatuslineArgs),
}

#[derive(Clone, Args, Default)]
pub(crate) struct SharedArgs {
    #[arg(short, long)]
    pub(crate) since: Option<String>,
    #[arg(short, long)]
    pub(crate) until: Option<String>,
    #[arg(short, long)]
    pub(crate) json: bool,
    #[arg(short, long, value_enum, default_value_t = CostMode::Auto)]
    pub(crate) mode: CostMode,
    #[arg(short, long)]
    pub(crate) debug: bool,
    #[arg(long, default_value_t = 5)]
    pub(crate) debug_samples: usize,
    #[arg(short, long, value_enum, default_value_t = SortOrder::Asc)]
    pub(crate) order: SortOrder,
    #[arg(short, long)]
    pub(crate) breakdown: bool,
    #[arg(short = 'O', long)]
    pub(crate) offline: bool,
    #[arg(long)]
    pub(crate) no_offline: bool,
    #[arg(long)]
    pub(crate) color: bool,
    #[arg(long)]
    pub(crate) no_color: bool,
    #[arg(short = 'z', long)]
    pub(crate) timezone: Option<String>,
    #[arg(short, long, default_value = "en-CA")]
    pub(crate) locale: String,
    #[arg(short = 'q', long)]
    pub(crate) jq: Option<String>,
    #[arg(long)]
    pub(crate) config: Option<PathBuf>,
    #[arg(long)]
    pub(crate) compact: bool,
}

#[derive(Clone, Args)]
pub(crate) struct DailyArgs {
    #[command(flatten)]
    pub(crate) shared: SharedArgs,
    #[arg(short = 'i', long)]
    pub(crate) instances: bool,
    #[arg(short, long)]
    pub(crate) project: Option<String>,
    #[arg(long)]
    pub(crate) project_aliases: Option<String>,
}

#[derive(Clone, Args)]
pub(crate) struct WeeklyArgs {
    #[command(flatten)]
    pub(crate) shared: SharedArgs,
    #[arg(short = 'w', long, value_enum, default_value_t = WeekDay::Sunday)]
    pub(crate) start_of_week: WeekDay,
}

#[derive(Clone, Args)]
pub(crate) struct SessionArgs {
    #[command(flatten)]
    pub(crate) shared: SharedArgs,
    #[arg(short, long)]
    pub(crate) id: Option<String>,
}

#[derive(Clone, Args)]
pub(crate) struct BlocksArgs {
    #[command(flatten)]
    pub(crate) shared: SharedArgs,
    #[arg(short, long)]
    pub(crate) active: bool,
    #[arg(short, long)]
    pub(crate) recent: bool,
    #[arg(short = 't', long)]
    pub(crate) token_limit: Option<String>,
    #[arg(short = 'n', long, default_value_t = DEFAULT_SESSION_DURATION_HOURS)]
    pub(crate) session_length: f64,
}

#[derive(Clone, Args)]
pub(crate) struct StatuslineArgs {
    #[arg(short = 'O', long, default_value_t = true)]
    pub(crate) offline: bool,
    #[arg(long)]
    pub(crate) no_offline: bool,
    #[arg(short = 'B', long, value_enum, default_value_t = VisualBurnRate::Off)]
    pub(crate) visual_burn_rate: VisualBurnRate,
    #[arg(long, value_enum, default_value_t = CostSource::Auto)]
    pub(crate) cost_source: CostSource,
    #[arg(long, default_value_t = true)]
    pub(crate) cache: bool,
    #[arg(long)]
    pub(crate) no_cache: bool,
    #[arg(long, default_value_t = 1)]
    pub(crate) refresh_interval: u64,
    #[arg(long, default_value_t = 50)]
    pub(crate) context_low_threshold: u8,
    #[arg(long, default_value_t = 80)]
    pub(crate) context_medium_threshold: u8,
    #[arg(long)]
    pub(crate) config: Option<PathBuf>,
    #[arg(long)]
    pub(crate) debug: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub(crate) enum CostMode {
    #[default]
    Auto,
    Calculate,
    Display,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
pub(crate) enum SortOrder {
    Desc,
    #[default]
    Asc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(crate) enum WeekDay {
    Sunday,
    Monday,
    Tuesday,
    Wednesday,
    Thursday,
    Friday,
    Saturday,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(crate) enum VisualBurnRate {
    Off,
    Emoji,
    Text,
    EmojiText,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(crate) enum CostSource {
    Auto,
    Ccusage,
    Cc,
    Both,
}
