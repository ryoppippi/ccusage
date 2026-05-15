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

## ccusage A/B Setup

For branch-vs-main performance work, create a separate worktree so both versions can be built and profiled without switching the active checkout.

```sh
git fetch origin main
git worktree add /tmp/ccusage-main origin/main
pnpm install
pnpm --filter ccusage build
cd /tmp/ccusage-main
pnpm install
pnpm --filter ccusage build
```

Run the same command against both builds. Prefer the published Bun entry shape when profiling bundled CLI performance.

```sh
LOG_LEVEL=0 COLUMNS=200 bun -b apps/ccusage/dist/index.js daily --offline --json >/tmp/head.json
LOG_LEVEL=0 COLUMNS=200 bun -b /tmp/ccusage-main/apps/ccusage/dist/index.js daily --offline --json >/tmp/main.json
jq -e . /tmp/head.json >/dev/null
jq -e . /tmp/main.json >/dev/null
```

Measure end-to-end command latency with hyperfine before trusting a CPU profile change:

```sh
hyperfine --warmup 4 --runs 10 --shell none \
	"bun -b apps/ccusage/dist/index.js daily --offline --json" \
	"bun -b /tmp/ccusage-main/apps/ccusage/dist/index.js daily --offline --json" \
	--export-json /tmp/ccusage-hyperfine.json
```

If `hyperfine` is missing, use comma first:

```sh
, hyperfine --warmup 4 --runs 10 --shell none "bun -b apps/ccusage/dist/index.js daily --offline --json"
```

## Reading Profiles

Read `*.cpuprofile.md` before opening the full JSON profile. Look for:

- Hot self-time frames in application code, not only total-time parents.
- Native frames such as `Map#set`, `JSON.parse`, `Intl.DateTimeFormat`, string slicing, array construction, stdout writes, and worker message serialization.
- Whether the hot frame is in parsing, merging, aggregation, rendering, or process startup.
- Whether worker-thread changes moved cost from parsing into post-worker merge.
- Whether an apparent hotspot matters to end-to-end hyperfine results.

Use `rg` on markdown profiles to connect frames to source:

```sh
rg -n "Map#set|JSON.parse|Intl|postMessage|write|data-loader|table" profiles/*.md
```

For `.cpuprofile`, open Chrome DevTools Performance tab or VS Code's CPU profiler and inspect both bottom-up self time and call tree context.

## Bun References

Use Bun's local agent-readable docs before web docs. In this repo, the useful Bun docs live in `node_modules/bun-types`.

Read this first for profiling flags and benchmarking guidance:

```sh
sed -n '1,280p' node_modules/bun-types/docs/project/benchmarking.mdx
```

Use the type files for runtime APIs used in this repo, such as `Bun.$`, `Bun.file()`, `Bun.write()`, `Bun.spawn()`, `Bun.argv`, `Bun.deepEquals()`, `Bun.file().writer()`, `Bun.stdout`, `Bun.stderr`, and `Bun.stringWidth()`:

```sh
rg -n "cpu-prof|cpu-prof-md|Bun\\.\\$|function file|function write|function spawn|argv|deepEquals|stringWidth" \
	node_modules/bun-types
```

Relevant local docs are usually under:

- `node_modules/bun-types/README.md`
- `node_modules/.pnpm/bun-types*/node_modules/bun-types/docs/project/benchmarking.mdx`
- `node_modules/.pnpm/bun-types*/node_modules/bun-types/bun.d.ts`

If local docs are unavailable, use Bun's benchmarking docs: `https://bun.com/docs/project/benchmarking`.

## ccusage Lessons

Past ccusage performance work found wins by profiling the real bundled CLI on real Claude logs, then validating with hyperfine and JSON parity. Useful patterns:

- Replace hot exact-key `Map` indexes with null-prototype object indexes only when keys are plain strings and inherited keys are covered.
- Avoid adopting a profile-inspired prototype unless hyperfine shows an end-to-end win.
- Keep rejected experiments documented in commit messages when they explain why a tempting profile hotspot was not changed.
- Always verify output parity for `daily`, `session`, `monthly`, `weekly`, and `blocks` JSON when changing aggregation order.
- Pipe large JSON output through `jq -e .` because Bun CLIs can expose stdout flushing bugs under benchmark-style piping.

## Microbenchmarks

Use microbenchmarks for isolated language/runtime questions, not as proof of CLI wins. Prefer `mitata` for JavaScript microbenchmarks. Confirm any microbenchmark-driven change with the full CLI profile and hyperfine A/B run.
