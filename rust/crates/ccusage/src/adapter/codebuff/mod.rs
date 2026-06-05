mod loader;
mod parser;
mod paths;
mod report;

use crate::cli::AgentCommandArgs;
use crate::{
    filter_loaded_entries_by_date, print_json_or_jq, sort_summaries, wants_json, PricingMap, Result,
};

pub(crate) use loader::load_entries;
pub(crate) use report::{report_from_rows, summarize_entries};

pub(crate) fn run(args: AgentCommandArgs) -> Result<()> {
    let shared = args.shared;
    let pricing = PricingMap::load();
    let mut entries = load_entries(&shared, &pricing)?;
    filter_loaded_entries_by_date(&mut entries, &shared);
    let mut rows = summarize_entries(&entries, args.kind)?;
    sort_summaries(&mut rows, &shared.order, report::summary_period);
    if wants_json(&shared) {
        return print_json_or_jq(report_from_rows(&rows, args.kind), shared.jq.as_deref());
    }
    crate::adapter::amp::print_table_for_agent("Codebuff", args.kind, &rows, &shared)?;
    Ok(())
}
