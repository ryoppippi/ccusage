mod loader;
mod parser;
mod paths;
mod report;

use crate::{
    adapter::opencode, cli::AgentCommandArgs, filter_loaded_entries_by_date, print_json_or_jq,
    print_usage_table, sort_summaries, wants_json, PricingMap, Result,
};

pub(crate) use loader::load_entries;
pub(crate) use report::{report_from_rows, summarize_entries};

#[cfg(test)]
static GEMINI_DATA_DIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
struct GeminiDataDirEnvGuard {
    previous: Option<std::ffi::OsString>,
}

#[cfg(test)]
impl GeminiDataDirEnvGuard {
    fn set(path: &std::path::Path) -> Self {
        let previous = std::env::var_os(paths::GEMINI_DATA_DIR_ENV);
        std::env::set_var(paths::GEMINI_DATA_DIR_ENV, path);
        Self { previous }
    }
}

#[cfg(test)]
impl Drop for GeminiDataDirEnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(paths::GEMINI_DATA_DIR_ENV, value),
            None => std::env::remove_var(paths::GEMINI_DATA_DIR_ENV),
        }
    }
}

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load(shared.offline, crate::log_level() != Some(0));
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, |row| {
        opencode::summary_period(row)
    });
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    print_usage_table(
        "Gemini CLI Token Usage Report",
        opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    )?;
    Ok(())
}
