---
name: bun-cpu-profile
description: Debug Bun CPU performance for TypeScript/JavaScript CLIs and scripts with Bun CPU profiles, markdown profiles, hyperfine comparisons, and git worktree A/B runs. Use when investigating slow Bun execution, validating performance optimizations, comparing a branch against main, or interpreting .cpuprofile / --cpu-prof-md output.
---

# Bun CPU Profile

## Workflow

Use Bun's markdown CPU profile first because it is grep-friendly and compact enough for agent analysis. Generate `.cpuprofile` as well when a flamegraph or Chrome DevTools / VS Code inspection is useful.

```sh
bun --cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles --cpu-prof-name ccusage.cpuprofile ./src/index.ts daily --offline --json
```

For package scripts, inject profiler flags without rewriting the command:

```sh
BUN_OPTIONS="--cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles" pnpm --filter ccusage run start daily --offline --json
```

Keep benchmark runs quiet and deterministic:

```sh
LOG_LEVEL=0 COLUMNS=200 bun --cpu-prof-md ./src/index.ts daily --offline --json >/tmp/ccusage.json
jq -e . /tmp/ccusage.json >/dev/null
```

For branch-vs-main profiling, reading profile output, and Bun reference lookup, read `references/profile-workflow.md`.

## ccusage Lessons

Past ccusage performance work found wins by profiling the real bundled CLI on real Claude logs, then validating with hyperfine and JSON parity:

- Avoid adopting a profile-inspired prototype unless hyperfine shows an end-to-end win.
- Keep rejected experiments documented in commit messages when they explain why a tempting profile hotspot was not changed.
- Always verify output parity for `daily`, `session`, `monthly`, `weekly`, and `blocks` JSON when changing aggregation order.

## Microbenchmarks

Use microbenchmarks for isolated language/runtime questions, not as proof of CLI wins. Prefer `mitata` for JavaScript microbenchmarks. Confirm any microbenchmark-driven change with the full CLI profile and hyperfine A/B run.
