# Test Coverage for Multi-Instance Feature - Critical Gap Analysis

## Core Insight

We shipped a major feature (`--instances` and `--project` flags) with ZERO automated tests for the command-level integration. While utility functions are well-tested, the user-facing functionality has no safety net. This is a critical gap that could lead to silent breakages.

## Phase 1: Command Integration Tests (HIGH PRIORITY)

### Essential Test Coverage - 30 minutes

- [x] **Add daily command --instances flag test**

  - **File**: `src/commands/daily.ts` (add in-source test block)
  - **Test**: Mock usage data with multiple projects, verify `--instances` groups by project in table output
  - **Specific**: Create fixture with 2 projects, verify project headers appear in table output
  - **Why**: Ensures core user-facing functionality works and doesn't regress

- [x] **Add daily command --project filter test**

  - **File**: `src/commands/daily.ts`
  - **Test**: Mock data for multiple projects, use `--project projectName`, verify only that project's data appears
  - **Specific**: Test both valid project name and non-existent project name
  - **Why**: Project filtering is core UX - must work reliably

- [x] **Add daily command --instances JSON output test**

  - **File**: `src/commands/daily.ts`
  - **Test**: Verify `--instances --json` produces `{projects: {...}}` structure vs flat `{daily: [...]}`
  - **Specific**: Check exact JSON schema matches between grouped/non-grouped modes
  - **Why**: API consumers depend on consistent JSON structure

- [x] **Add monthly command --instances integration test**

  - **File**: `src/commands/monthly.ts`
  - **Test**: Same pattern as daily - project grouping in table and JSON output
  - **Specific**: Test monthly aggregation preserves project information correctly
  - **Why**: Monthly view is critical for cost analysis per project

- [x] **Add session command --instances integration test**

  - **File**: `src/commands/session.ts`
  - **Test**: Verify session grouping by `projectPath` works correctly
  - **Specific**: Test that `projectPath` vs `project` naming difference doesn't break UX
  - **Why**: Session view has different project key - needs specific testing

- [x] **Add blocks command --instances integration test**
  - **File**: `src/commands/blocks.ts`
  - **Test**: Test `extractProjectFromBlock` works with `--instances` flag
  - **Specific**: Mock SessionBlock with file paths, verify project extraction and grouping
  - **Why**: Blocks command has custom project extraction logic - highest risk area

## Phase 2: Cross-Platform Compatibility (MEDIUM PRIORITY)

### Windows Path Testing - 15 minutes

- [x] **Test extractProjectFromBlock Windows path compatibility**

  - **File**: `src/commands/blocks.ts` (add test to existing function)
  - **Test**: Test paths with both `/` and `\` separators work correctly
  - **Specific**: `'projects/myproj/session/file.jsonl'` and `'projects\\myproj\\session\\file.jsonl'` both return `'myproj'`
  - **Why**: We fixed Windows path bug but didn't test it - could regress silently

- [x] **Test project extraction edge cases**
  - **File**: `src/commands/blocks.ts`
  - **Test**: Test malformed paths, missing projects directory, empty entries array
  - **Specific**: Verify graceful fallback to 'unknown' project name
  - **Why**: Defensive programming - handle real-world malformed data

## Phase 3: Integration Workflows (MEDIUM PRIORITY)

### End-to-End User Scenarios - 20 minutes

- [x] **Test --instances + --project flag combination**

  - **File**: `src/commands/daily.ts` (can reuse for other commands)
  - **Test**: Use both flags together, verify filtering works before grouping
  - **Specific**: `--instances --project myproj` should show only myproj data in project-grouped format
  - **Why**: Users will combine flags - interaction must work correctly

- [x] **Test empty state handling with --instances**

  - **File**: `src/commands/daily.ts`
  - **Test**: No data for specified project, verify graceful error message
  - **Specific**: Mock empty results, verify "No data found" message appears
  - **Why**: Empty states are common failure points in UX

- [x] **Test project name formatting in output**
  - **File**: Test integration with `formatProjectName` function
  - **Test**: Verify long project names are properly formatted in table headers
  - **Specific**: Test project alias resolution works in grouped output
  - **Why**: Project names directly impact user experience - must be readable

## Phase 4: Output Format Validation (LOW PRIORITY)

### JSON Schema Consistency - 10 minutes

- [ ] **Test JSON output schema consistency across commands**

  - **File**: Create cross-command integration test
  - **Test**: Verify all commands produce same JSON structure for `--instances` mode
  - **Specific**: Check `{projects: {...}}` wrapper is consistent between daily/monthly/session/blocks
  - **Why**: API consumers expect consistent interface across endpoints

- [ ] **Test missing tokenLimitStatus in blocks grouped JSON**
  - **File**: `src/commands/blocks.ts`
  - **Test**: Verify `--instances --json` includes `tokenLimitStatus` field (currently missing)
  - **Specific**: Compare grouped vs non-grouped JSON output for field completeness
  - **Why**: Known bug from code review - grouped output missing critical field

## Success Criteria

- [ ] All commands work reliably with `--instances` and `--project` flags
- [ ] Windows users can use project grouping without path issues
- [ ] JSON API remains consistent and complete across all commands
- [ ] Users get helpful error messages for invalid project names
- [ ] No regressions in existing functionality

## Carmack's Principles Applied

1. **Test what matters**: Focus on user-facing functionality, not internal implementation
2. **Fail fast**: Catch breaking changes immediately with automated tests
3. **Minimal effective dose**: Target the highest-risk areas first (command integration)
4. **Real-world scenarios**: Test flag combinations and edge cases users will encounter

**Estimated Total Time: 75 minutes to eliminate critical testing gap**

**Risk without tests**: Silent breakage of core multi-instance functionality, Windows incompatibility, API inconsistencies
