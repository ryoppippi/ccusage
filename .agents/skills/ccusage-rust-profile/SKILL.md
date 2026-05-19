---
name: ccusage-rust-profile
description: Profiles ccusage native Rust CLI performance. Use when debugging slow Rust commands, comparing branch speed, reading profiles, or validating optimization work.
paths:
  - 'rust/**/*.rs'
  - 'rust/**/*.toml'
  - 'rust/**/build.rs'
globs: 'rust/**/*.rs,rust/**/*.toml,rust/**/build.rs'
---

# ccusage Rust Profile

Use this skill for native CLI performance work. Use `bun-cpu-profile` only for
TypeScript launcher, benchmark, or packaging scripts.

## Preparation

Read the relevant local Rust Performance Book pages before non-trivial
optimization:

```text
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/profiling.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/io.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/heap-allocations.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/parallelism.md
/Users/ryoppippi/ghq/github.com/nnethercote/perf-book/src/type-sizes.md
```

Build release binaries before timing:

```sh
direnv exec . cargo build --manifest-path rust/Cargo.toml --release --bin ccusage
```

## Compare End To End

Create a separate main worktree for branch-vs-main comparisons:

```sh
command git fetch origin main
command git worktree add /tmp/ccusage-main origin/main
direnv exec . cargo build --manifest-path rust/Cargo.toml --release --bin ccusage
cd /tmp/ccusage-main
direnv exec . cargo build --manifest-path rust/Cargo.toml --release --bin ccusage
```

Measure real commands with deterministic output settings:

```sh
hyperfine --warmup 4 --runs 10 --shell none \
	"env LOG_LEVEL=0 COLUMNS=200 NO_COLOR=1 TZ=UTC rust/target/release/ccusage daily --offline --json" \
	"env LOG_LEVEL=0 COLUMNS=200 NO_COLOR=1 TZ=UTC /tmp/ccusage-main/rust/target/release/ccusage daily --offline --json" \
	--export-json /tmp/ccusage-rust-hyperfine.json
```

For JSON parity, write both outputs and validate with `jq`:

```sh
env LOG_LEVEL=0 COLUMNS=200 NO_COLOR=1 TZ=UTC rust/target/release/ccusage daily --offline --json >/tmp/head.json
env LOG_LEVEL=0 COLUMNS=200 NO_COLOR=1 TZ=UTC /tmp/ccusage-main/rust/target/release/ccusage daily --offline --json >/tmp/main.json
jq -e . /tmp/head.json >/dev/null
jq -e . /tmp/main.json >/dev/null
```

## What To Check

- I/O count and buffering before CPU-only tweaks.
- Avoid unnecessary `String` allocation and cloning on hot paths; prefer borrowed
  `&str`, `Arc<str>`, or typed summaries where ownership is needed.
- Avoid returning large intermediate object vectors when aggregation can happen
  earlier without changing output.
- Use parallelism only when it improves end-to-end command time on real fixture
  shapes.
- Keep binary size visible when adding dependencies or enabling features.

## Validation

Profile before committing an optimization. Validate with end-to-end `hyperfine`
and JSON/table parity, not only microbenchmarks.

When CI performance comments are relevant, inspect or reproduce the
`ccusage-rust-perf` workflow command:

```sh
nix develop --command pnpm exec bun apps/ccusage/scripts/compare-pr-performance.ts --head-runtime rust --help
```
