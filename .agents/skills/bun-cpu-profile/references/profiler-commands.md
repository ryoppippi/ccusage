# Bun Profiler Commands

Use Bun's markdown CPU profile first because it is grep-friendly and compact
enough for agent analysis. Generate `.cpuprofile` as well when a flamegraph or
Chrome DevTools / VS Code inspection is useful. Inspect script options with
`--help`, but do not treat help output as a profiling workload.

```sh
pnpm exec bun --cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles <script> <args>
```

For package scripts, inject profiler flags without rewriting the command:

```sh
BUN_OPTIONS="--cpu-prof --cpu-prof-md --cpu-prof-dir ./profiles" pnpm <script>
```

Keep benchmark runs quiet and deterministic:

```sh
LOG_LEVEL=0 COLUMNS=200 pnpm exec bun --cpu-prof-md <script> <args>
```
