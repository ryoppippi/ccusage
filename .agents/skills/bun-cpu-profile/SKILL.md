---
name: bun-cpu-profile
description: Profiles Bun TypeScript and JavaScript package scripts. Use for launcher, benchmark, or packaging hot paths; use ccusage-rust-profile for native CLI performance.
---

# Bun CPU Profile

Use this skill for TypeScript package scripts. The production CLI is Rust-first,
so native command performance work should use the `ccusage-rust-profile` skill
instead.

## Workflow

Use Bun's markdown CPU profile first because it is grep-friendly and compact enough for agent analysis. Generate `.cpuprofile` as well when a flamegraph or Chrome DevTools / VS Code inspection is useful. Inspect script options with `--help`, but do not treat help output as a profiling workload.

```sh
pnpm exec bun --cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles --cpu-prof-name ccusage-perf.cpuprofile apps/ccusage/scripts/compare-pr-performance.ts \
	--base-dir /tmp/ccusage-main \
	--head-dir "$PWD" \
	--fixture-dir apps/ccusage/test/fixtures/claude \
	--codex-fixture-dir apps/ccusage/test/fixtures/codex \
	--runs 1 \
	--warmup 0 \
	--output /tmp/ccusage-perf-comment.md
```

For package scripts, inject profiler flags without rewriting the command:

```sh
BUN_OPTIONS="--cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles" pnpm exec bun apps/ccusage/scripts/compare-pr-performance.ts \
	--base-dir /tmp/ccusage-main \
	--head-dir "$PWD" \
	--fixture-dir apps/ccusage/test/fixtures/claude \
	--codex-fixture-dir apps/ccusage/test/fixtures/codex \
	--runs 1 \
	--warmup 0 \
	--output /tmp/ccusage-perf-comment.md
```

Keep benchmark runs quiet and deterministic:

```sh
LOG_LEVEL=0 COLUMNS=200 pnpm exec bun --cpu-prof-md apps/ccusage/scripts/compare-pr-performance.ts \
	--base-dir /tmp/ccusage-main \
	--head-dir "$PWD" \
	--fixture-dir apps/ccusage/test/fixtures/claude \
	--codex-fixture-dir apps/ccusage/test/fixtures/codex \
	--runs 1 \
	--warmup 0 \
	--output /tmp/ccusage-perf-comment.md
test -s /tmp/ccusage-perf-comment.md
```

For branch-vs-main profiling, reading profile output, and Bun reference lookup, read `references/profile-workflow.md`.

## ccusage Lessons

Past ccusage performance work found wins by profiling the real bundled CLI on real Claude logs, then validating with hyperfine and JSON parity:

- Avoid adopting a profile-inspired prototype unless hyperfine shows an end-to-end win.
- Keep rejected experiments documented in commit messages when they explain why a tempting profile hotspot was not changed.
- Always verify output parity for `daily`, `session`, `monthly`, `weekly`, and `blocks` JSON when changing aggregation order.

## Microbenchmarks

Use microbenchmarks for isolated language/runtime questions, not as proof of CLI wins. Prefer `mitata` for JavaScript microbenchmarks. Confirm any microbenchmark-driven change with the full CLI profile and hyperfine A/B run.
