use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::Arc,
};

use crate::{
    cli::{SharedArgs, SortOrder, WeekDay},
    cli_error, format_date, format_naive_date, parse_iso_date, LoadedEntry, ModelBreakdown, Result,
    TimestampMs, TokenCounts, UsageSummary,
};

pub(crate) fn summarize_by_key<F, M>(
    entries: &[LoadedEntry],
    key_fn: F,
    meta_fn: M,
) -> Result<Vec<UsageSummary>>
where
    F: Fn(&LoadedEntry) -> String,
    M: Fn(&str) -> (String, Option<String>),
{
    let mut groups: BTreeMap<String, UsageAccumulator> = BTreeMap::new();
    for entry in entries {
        groups.entry(key_fn(entry)).or_default().add_entry(entry);
    }

    let mut rows = Vec::with_capacity(groups.len());
    for (key, group) in groups {
        let (date, project) = meta_fn(&key);
        let mut summary = group.into_summary();
        summary.date = Some(date);
        summary.project = project;
        rows.push(summary);
    }
    Ok(rows)
}

#[derive(Default)]
struct UsageAccumulator {
    counts: TokenCounts,
    cost: f64,
    credits: Option<f64>,
    models: Vec<String>,
    seen_models: HashSet<String>,
    breakdowns: Vec<ModelBreakdown>,
    breakdown_indexes: HashMap<String, usize>,
}

impl UsageAccumulator {
    fn add_entry(&mut self, entry: &LoadedEntry) {
        let usage = entry.data.message.usage;
        self.counts.add_usage(usage);
        self.counts.add_extra_total_tokens(entry.extra_total_tokens);
        self.cost += entry.cost;
        if let Some(credits) = entry.credits {
            *self.credits.get_or_insert(0.0) += credits;
        }
        if let Some(model) = &entry.model {
            if self.seen_models.insert(model.clone()) {
                self.models.push(model.clone());
            }
            let index = *self
                .breakdown_indexes
                .entry(model.clone())
                .or_insert_with(|| {
                    let index = self.breakdowns.len();
                    self.breakdowns.push(ModelBreakdown {
                        model_name: model.clone(),
                        ..ModelBreakdown::default()
                    });
                    index
                });
            let breakdown = &mut self.breakdowns[index];
            breakdown.input_tokens += usage.input_tokens;
            breakdown.output_tokens += usage.output_tokens;
            breakdown.cache_creation_tokens += usage.cache_creation_input_tokens;
            breakdown.cache_read_tokens += usage.cache_read_input_tokens;
            breakdown.extra_total_tokens += entry.extra_total_tokens;
            breakdown.cost += entry.cost;
        }
    }

    fn into_summary(mut self) -> UsageSummary {
        self.breakdowns.sort_by(|a, b| b.cost.total_cmp(&a.cost));
        UsageSummary {
            date: None,
            month: None,
            week: None,
            session_id: None,
            project_path: None,
            last_activity: None,
            input_tokens: self.counts.input_tokens,
            output_tokens: self.counts.output_tokens,
            cache_creation_tokens: self.counts.cache_creation_tokens,
            cache_read_tokens: self.counts.cache_read_tokens,
            extra_total_tokens: self.counts.extra_total_tokens,
            total_cost: self.cost,
            credits: self.credits,
            models_used: self.models,
            model_breakdowns: self.breakdowns,
            project: None,
            versions: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct SessionAccumulator {
    usage: UsageAccumulator,
    latest: Option<(TimestampMs, Arc<str>, Arc<str>)>,
    versions: BTreeSet<String>,
}

impl SessionAccumulator {
    pub(crate) fn add_entry(&mut self, entry: &LoadedEntry) {
        self.usage.add_entry(entry);
        if self
            .latest
            .as_ref()
            .is_none_or(|(timestamp, _, _)| entry.timestamp > *timestamp)
        {
            self.latest = Some((
                entry.timestamp,
                Arc::clone(&entry.session_id),
                Arc::clone(&entry.project_path),
            ));
        }
        if let Some(version) = &entry.data.version {
            self.versions.insert(version.clone());
        }
    }

    pub(crate) fn into_summary(self, timezone: Option<&str>) -> Result<UsageSummary> {
        let Some((timestamp, session_id, project_path)) = self.latest else {
            return Err(cli_error("empty session group"));
        };
        let mut summary = self.usage.into_summary();
        summary.session_id = Some(session_id.to_string());
        summary.project_path = Some(project_path.to_string());
        summary.last_activity = Some(format_date(timestamp, timezone));
        summary.versions = Some(self.versions.into_iter().collect());
        Ok(summary)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum BucketKind {
    Monthly,
    Weekly,
}

pub(crate) fn summarize_summaries_by_bucket(
    rows: &[UsageSummary],
    kind: BucketKind,
    start: WeekDay,
) -> Vec<UsageSummary> {
    let mut groups: BTreeMap<String, Vec<&UsageSummary>> = BTreeMap::new();
    for row in rows {
        let Some(date) = row.date.as_deref() else {
            continue;
        };
        let bucket = match kind {
            BucketKind::Monthly => date.get(..7).unwrap_or(date).to_string(),
            BucketKind::Weekly => week_start(date, start).unwrap_or_else(|| date.to_string()),
        };
        groups.entry(bucket).or_default().push(row);
    }

    groups
        .into_iter()
        .map(|(bucket, rows)| {
            let mut summary = aggregate_summaries(&rows);
            match kind {
                BucketKind::Monthly => summary.month = Some(bucket),
                BucketKind::Weekly => summary.week = Some(bucket),
            }
            summary
        })
        .collect()
}

fn aggregate_summaries(rows: &[&UsageSummary]) -> UsageSummary {
    let mut summary = UsageSummary {
        date: None,
        month: None,
        week: None,
        session_id: None,
        project_path: None,
        last_activity: None,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        extra_total_tokens: 0,
        total_cost: 0.0,
        credits: None,
        models_used: Vec::new(),
        model_breakdowns: Vec::new(),
        project: None,
        versions: None,
    };
    let mut seen_models = HashSet::new();
    let mut breakdown_indexes = HashMap::<String, usize>::new();

    for row in rows {
        summary.input_tokens += row.input_tokens;
        summary.output_tokens += row.output_tokens;
        summary.cache_creation_tokens += row.cache_creation_tokens;
        summary.cache_read_tokens += row.cache_read_tokens;
        summary.extra_total_tokens += row.extra_total_tokens;
        summary.total_cost += row.total_cost;
        if let Some(credits) = row.credits {
            *summary.credits.get_or_insert(0.0) += credits;
        }
        for model in &row.models_used {
            if seen_models.insert(model.clone()) {
                summary.models_used.push(model.clone());
            }
        }
        for item in &row.model_breakdowns {
            let index = *breakdown_indexes
                .entry(item.model_name.clone())
                .or_insert_with(|| {
                    let index = summary.model_breakdowns.len();
                    summary.model_breakdowns.push(ModelBreakdown {
                        model_name: item.model_name.clone(),
                        ..ModelBreakdown::default()
                    });
                    index
                });
            let breakdown = &mut summary.model_breakdowns[index];
            breakdown.input_tokens += item.input_tokens;
            breakdown.output_tokens += item.output_tokens;
            breakdown.cache_creation_tokens += item.cache_creation_tokens;
            breakdown.cache_read_tokens += item.cache_read_tokens;
            breakdown.extra_total_tokens += item.extra_total_tokens;
            breakdown.cost += item.cost;
        }
    }
    summary
        .model_breakdowns
        .sort_by(|a, b| b.cost.total_cmp(&a.cost));
    summary
}

pub(crate) fn filter_and_sort_summaries<F>(
    rows: &mut Vec<UsageSummary>,
    shared: &SharedArgs,
    date_fn: F,
) where
    F: Fn(&UsageSummary) -> &str,
{
    if shared.since.is_some() || shared.until.is_some() {
        rows.retain(|row| {
            let date = date_fn(row).replace('-', "");
            shared.since.as_ref().is_none_or(|since| &date >= since)
                && shared.until.as_ref().is_none_or(|until| &date <= until)
        });
    }
    sort_summaries(rows, &shared.order, date_fn);
}

pub(crate) fn sort_summaries<F>(rows: &mut [UsageSummary], order: &SortOrder, date_fn: F)
where
    F: Fn(&UsageSummary) -> &str,
{
    rows.sort_by(|a, b| match order {
        SortOrder::Asc => date_fn(a).cmp(date_fn(b)),
        SortOrder::Desc => date_fn(b).cmp(date_fn(a)),
    });
}

pub(crate) fn week_start(date: &str, start: WeekDay) -> Option<String> {
    let date = parse_iso_date(date)?;
    let start_num = match start {
        WeekDay::Sunday => 0,
        WeekDay::Monday => 1,
        WeekDay::Tuesday => 2,
        WeekDay::Wednesday => 3,
        WeekDay::Thursday => 4,
        WeekDay::Friday => 5,
        WeekDay::Saturday => 6,
    };
    let day = date.weekday_from_sunday() as i64;
    let shift = (day - start_num + 7) % 7;
    Some(format_naive_date(date.checked_add_days(-shift)?))
}
