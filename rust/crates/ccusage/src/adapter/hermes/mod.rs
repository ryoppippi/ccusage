mod loader;
mod parser;
mod paths;
mod report;

use crate::{
    cli::AgentCommandArgs, filter_loaded_entries_by_date, print_json_or_jq, print_usage_table,
    sort_summaries, wants_json, PricingMap, Result,
};

pub(crate) use loader::load_entries;
pub(crate) use report::{report_from_rows, summarize_entries};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load_with_overrides(
        shared.offline,
        crate::log_level() != Some(0),
        shared.pricing_overrides.iter(),
    );
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(
        &mut rows,
        &shared.order,
        crate::adapter::opencode::summary_period,
    );
    if wants_json(&shared) {
        return print_json_or_jq(
            report_from_rows(&rows, args.kind),
            shared.jq.as_deref(),
            shared.no_cost,
        );
    }
    print_usage_table(
        "Hermes Token Usage Report",
        crate::adapter::opencode::first_column(args.kind),
        &rows,
        &shared,
        false,
        None,
    )?;
    Ok(())
}
