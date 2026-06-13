# TypeScript And Script Profiling

Use this reference for TypeScript launcher, benchmark, and packaging script
performance. The production CLI is Rust-first, so native command performance
work should use `references/rust.md`.

## Node Profiler Commands

Use Node's CPU profiler when launcher startup or package tooling is in scope.
Inspect script options with `--help`, but do not treat help output as a
profiling workload.

```sh
node --cpu-prof --cpu-prof-dir ./profiles apps/ccusage/dist/cli.js <args>
```

For package scripts, inject profiler flags without rewriting the command:

```sh
NODE_OPTIONS="--cpu-prof --cpu-prof-dir=./profiles" pnpm <script>
```

Keep benchmark runs quiet and deterministic:

```sh
LOG_LEVEL=0 COLUMNS=200 node --cpu-prof apps/ccusage/dist/cli.js <args>
```

## Branch Comparison

For branch-vs-main performance work, create a separate worktree so both versions
can be built and profiled without switching the active checkout.

```sh
git fetch origin main
git worktree add /tmp/ccusage-main origin/main
pnpm install
pnpm --filter ccusage build
cd /tmp/ccusage-main
pnpm install
pnpm --filter ccusage build
```

Run the same command against both builds. Prefer the published package entry
shape when profiling package startup or launcher behavior.

```sh
LOG_LEVEL=0 COLUMNS=200 node apps/ccusage/dist/cli.js daily --offline --json >/tmp/head.json
LOG_LEVEL=0 COLUMNS=200 node /tmp/ccusage-main/apps/ccusage/dist/cli.js daily --offline --json >/tmp/main.json
jq -e . /tmp/head.json >/dev/null
jq -e . /tmp/main.json >/dev/null
```

Measure end-to-end command latency with hyperfine before trusting a CPU profile
change:

```sh
hyperfine --warmup 4 --runs 10 --shell none \
	"node apps/ccusage/dist/cli.js daily --offline --json" \
	"node /tmp/ccusage-main/apps/ccusage/dist/cli.js daily --offline --json" \
	--export-json /tmp/ccusage-hyperfine.json
```

If `hyperfine` is missing, use comma first:

```sh
, hyperfine --warmup 4 --runs 10 --shell none "node apps/ccusage/dist/cli.js daily --offline --json"
```

## Reading Profiles

Read `*.cpuprofile.md` before opening the full JSON profile. Look for:

- Hot self-time frames in application code, not only total-time parents.
- Native frames such as `Map#set`, `JSON.parse`, `Intl.DateTimeFormat`, string
  slicing, array construction, stdout writes, and worker message serialization.
- Whether the hot frame is in parsing, merging, aggregation, rendering, or
  process startup.
- Whether worker-thread changes moved cost from parsing into post-worker merge.
- Whether an apparent hotspot matters to end-to-end hyperfine results.

Use `rg` on markdown profiles to connect frames to source:

```sh
rg -n "Map#set|JSON.parse|Intl|postMessage|write|data-loader|table" profiles/*.md
```

For `.cpuprofile`, open Chrome DevTools Performance tab or VS Code's CPU
profiler and inspect both bottom-up self time and call tree context.

## ccusage Lessons

- Past ccusage performance work found wins by profiling the real bundled CLI on
  real Claude logs, then validating with hyperfine and JSON parity.
- Avoid adopting a profile-inspired prototype unless hyperfine shows an
  end-to-end win.
- Keep rejected experiments documented in commit messages when they explain why
  a tempting profile hotspot was not changed.
- Always verify output parity for `daily`, `session`, `monthly`, `weekly`, and
  `blocks` JSON when changing aggregation order.
- Replace hot exact-key `Map` indexes with null-prototype object indexes only
  when keys are plain strings and inherited keys are covered.
- Pipe large JSON output through `jq -e .` so benchmark-style piping still
  verifies JSON parity.

Use microbenchmarks for isolated language/runtime questions, not as proof of CLI
wins. Confirm any microbenchmark-driven change with the full CLI profile and
hyperfine A/B run.
