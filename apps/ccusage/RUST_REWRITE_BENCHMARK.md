# Rust Rewrite Benchmark

Measured on 2026-05-11 on macOS arm64 against the local Claude usage dataset.

## Commands

```sh
target/release/ccusage daily --json --offline > /tmp/ccusage-rs-bench.json
bun -e 'import("./apps/ccusage/src/commands/index.ts").then(m => m.run())' daily --json --offline > /tmp/ccusage-ts-bench.json
```

Benchmark command:

```sh
, hyperfine --warmup 1 --runs 5 \
  "target/release/ccusage daily --json --offline > /tmp/ccusage-rs-bench.json" \
  "bun -e 'import(\"./apps/ccusage/src/commands/index.ts\").then(m=>m.run())' daily --json --offline > /tmp/ccusage-ts-bench.json"
```

## Results

| Implementation      |               Mean |            Range | Notes                        |
| ------------------- | -----------------: | ---------------: | ---------------------------- |
| Rust release binary |  1.007s +/- 0.073s |   0.916s..1.105s | `target/release/ccusage`     |
| TypeScript via Bun  | 11.925s +/- 1.544s | 10.587s..14.351s | direct command module import |

Rust was 11.84x +/- 1.76x faster for `daily --json --offline`.

## Binary Size

`target/release/ccusage` is 2.1 MB (`du`: 2.0 MB) with release settings optimized for size (`opt-level = "z"`, fat LTO, single codegen unit, stripped symbols, abort panics).

## Output Check

The benchmark output was compared against the TypeScript command path on the same live dataset:

| Metric       |                Rust |          TypeScript |                          Delta |
| ------------ | ------------------: | ------------------: | -----------------------------: |
| Total tokens |       9,969,733,575 |       9,969,722,345 |           +11,230 (+0.000113%) |
| Total cost   | 10,678.421718150003 | 10,677.858528150002 | +0.563190000000759 (+0.00527%) |

The small delta comes from duplicate entries in the local dataset where the same message/request pair carries conflicting usage values. The Rust loader preserves sorted file/line processing order for deduplication, while still loading and parsing files in parallel.
