mod loader;
mod parser;
mod paths;
mod report;

use crate::cli::AgentCommandArgs;
use crate::{
    filter_loaded_entries_by_date, print_json_or_jq, print_usage_table, sort_summaries, wants_json,
    PricingMap, Result,
};

pub(crate) use loader::load_entries;
pub(crate) use report::{report_from_rows, summarize_entries};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load();
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, |row| {
        crate::adapter::opencode::summary_period(row)
    });
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    if rows.is_empty() {
        eprintln!("{}", empty_usage_message());
        return Ok(());
    }
    print_usage_table(
        "GitHub Copilot CLI Token Usage Report",
        crate::adapter::opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    )?;
    Ok(())
}

fn empty_usage_message() -> &'static str {
    "No GitHub Copilot CLI usage data found.\nEnable Copilot OpenTelemetry file export before starting or resuming Copilot sessions.\nSee https://ccusage.com/guide/copilot/#data-source"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_usage_message_links_to_copilot_docs() {
        let message = empty_usage_message();
        assert!(message.contains("https://ccusage.com/guide/copilot/#data-source"));
    }
}
