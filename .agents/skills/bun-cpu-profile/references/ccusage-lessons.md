# ccusage Lessons

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
- Pipe large JSON output through `jq -e .` because Bun CLIs can expose stdout
  flushing bugs under benchmark-style piping.

## Microbenchmarks

Use microbenchmarks for isolated language/runtime questions, not as proof of CLI
wins. Prefer `mitata` for JavaScript microbenchmarks. Confirm any
microbenchmark-driven change with the full CLI profile and hyperfine A/B run.
