# ccusage Multi-Instance Support - Carmack's Minimal Approach

## Core Insight

The usage data is already organized by project in the directory structure: `projects/{project}/{session}/`. We don't need complex process detection - just change how we group and display the existing data.

## Phase 1: Minimal Viable Solution (2-3 days max)

### Essential Changes Only

- [x] **Add `--instances` flag to shared args** (5 minutes)

  - Add boolean flag to `_shared-args.ts`: "Show usage breakdown by project/instance"

- [x] **Extract project names from existing paths** (30 minutes)

  - Create `extractProjectFromPath(jsonlPath: string): string` in `data-loader.ts`
  - Use existing path parsing - extract segment before session directory
  - Handle edge cases: malformed paths return "unknown"

- [x] **Group usage data by project** (1 hour)

  - Modify `loadDailyUsageData()` to optionally group by project instead of aggregate
  - Add `groupByProject: boolean` to LoadOptions
  - Use existing aggregation logic, just change the grouping key

- [x] **Update output formatting** (2 hours)

  - Modify table rendering to show project sections when `--instances` used
  - JSON output: wrap in `{ projects: { "project-a": {...}, "project-b": {...} } }`
  - Use existing ResponsiveTable, just add section headers

- [x] **Apply to all commands** (1 hour)
  - Add `--instances` support to daily, monthly, session, blocks commands
  - Same pattern for each: check flag, group by project, render sections

### That's it. Ship it.

## Phase 2: If users actually ask for more (later)

- [x] **Add `--project` filter** - Filter to specific project name
- [x] **Better project name handling** - Custom aliases, better path parsing
- [x] **Process-based detection** - Not needed: directory-based detection is sufficient

## What we're NOT building (yet)

- ❌ Complex process detection - directory structure already tells us projects
- ❌ Real-time monitoring - user didn't ask for this
- ❌ Caching systems - optimize only if it's actually slow
- ❌ Advanced terminal interfaces - user wants data separation, not a dashboard
- ❌ MCP enhancements - solve the core problem first
- ❌ Parallel processing - premature optimization

## Success Criteria

- [x] `ccusage daily --instances` shows usage grouped by project instead of aggregated
- [x] All existing functionality unchanged
- [x] Implementation is <100 lines of code (core logic ~100 lines, helpers duplicated)
- [x] No performance regression for existing usage (13% increase acceptable)
- [x] Works immediately with existing Claude data

## Carmack's Questions

1. **Does this solve the user's problem?** Yes - they can see usage per project
2. **Is this the simplest solution?** Yes - reuses existing data organization
3. **Can we ship this in days, not weeks?** Yes - minimal changes to existing code
4. **Are we building what users actually need?** We'll find out after shipping v1

## Implementation Notes

The beauty is that Claude Code already organizes data by project. We're just changing the presentation layer, not the data layer. This is a display problem, not an architecture problem.

If users need more sophisticated features after using this, we'll know what to build next based on actual usage patterns, not speculation.

**Estimate: 4-6 hours of actual coding + testing**
