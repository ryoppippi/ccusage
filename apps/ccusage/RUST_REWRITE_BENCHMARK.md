# Rust Rewrite Benchmark

Measured on 2026-05-11 on macOS arm64 against the local Claude usage dataset.

## Commands

```sh
target/release/ccusage daily --json --offline > /tmp/ccusage-rs-bench.json
bun -e 'process.argv = [process.argv[0], "ccusage", ...process.argv.slice(1)]; import("./apps/ccusage/src/commands/index.ts").then(m => m.run())' daily --json --offline > /tmp/ccusage-ts-bench.json
```

Benchmark command:

```sh
, hyperfine --warmup 1 --runs 5 \
  "target/release/ccusage daily --json --offline > /tmp/ccusage-rs-bench.json" \
  "bun -e 'process.argv = [process.argv[0], \"ccusage\", ...process.argv.slice(1)]; import(\"./apps/ccusage/src/commands/index.ts\").then(m => m.run())' daily --json --offline > /tmp/ccusage-ts-bench.json"
```

## Results

| Implementation      |               Mean |            Range | Notes                        |
| ------------------- | -----------------: | ---------------: | ---------------------------- |
| Rust release binary |  1.242s +/- 0.040s |   1.201s..1.286s | `target/release/ccusage`     |
| TypeScript via Bun  | 10.749s +/- 0.665s | 10.237s..11.867s | direct command module import |

Rust was 8.65x +/- 0.60x faster for `daily --json --offline`.

## Binary Size

`target/release/ccusage` is 2.0 MB (`du`: 2.0 MB) with release settings optimized for size (`opt-level = "z"`, fat LTO, single codegen unit, stripped symbols, abort panics).

## Output Check

The benchmark output was compared against the TypeScript command path on the same live dataset with `jq -S` canonicalization.

The Rust and TypeScript JSON outputs were identical for `daily --json --offline`.
