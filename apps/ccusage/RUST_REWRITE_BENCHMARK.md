# Rust Rewrite Benchmark

Measured on 2026-05-11 on macOS arm64 against the local Claude usage dataset.

## Commands

```sh
target/release/ccusage daily --json --offline > /tmp/ccusage-rs-bench.json
bun -e 'process.argv = [process.argv[0], "ccusage", ...process.argv.slice(1)]; import("./apps/ccusage/src/commands/index.ts").then(m => m.run())' daily --json --offline > /tmp/ccusage-ts-bench.json
target/release/ccusage daily --json > /tmp/ccusage-rs-auto-bench.json
bun -e 'process.argv = [process.argv[0], "ccusage", ...process.argv.slice(1)]; import("./apps/ccusage/src/commands/index.ts").then(m => m.run())' daily --json > /tmp/ccusage-ts-auto-bench.json
```

Benchmark command:

```sh
, hyperfine --warmup 1 --runs 5 \
  "target/release/ccusage daily --json --offline > /tmp/ccusage-rs-bench.json" \
  "bun -e 'process.argv = [process.argv[0], \"ccusage\", ...process.argv.slice(1)]; import(\"./apps/ccusage/src/commands/index.ts\").then(m => m.run())' daily --json --offline > /tmp/ccusage-ts-bench.json"
```

Default auto mode benchmark command:

```sh
, hyperfine --warmup 1 --runs 5 \
  "target/release/ccusage daily --json > /tmp/ccusage-rs-auto-bench.json" \
  "bun -e 'process.argv = [process.argv[0], \"ccusage\", ...process.argv.slice(1)]; import(\"./apps/ccusage/src/commands/index.ts\").then(m => m.run())' daily --json > /tmp/ccusage-ts-auto-bench.json"
```

## Results

### Offline Mode

| Implementation      |               Mean |            Range | Notes                        |
| ------------------- | -----------------: | ---------------: | ---------------------------- |
| Rust release binary |  1.568s +/- 0.072s |   1.491s..1.683s | `target/release/ccusage`     |
| TypeScript via Bun  | 11.487s +/- 1.611s | 10.593s..14.359s | direct command module import |

Rust was 7.33x +/- 1.08x faster for `daily --json --offline`.

### Default Auto Mode

| Implementation      |               Mean |            Range | Notes                        |
| ------------------- | -----------------: | ---------------: | ---------------------------- |
| Rust release binary |  1.599s +/- 0.066s |   1.540s..1.699s | `target/release/ccusage`     |
| TypeScript via Bun  | 11.648s +/- 1.088s | 10.757s..13.518s | direct command module import |

Rust was 7.29x +/- 0.74x faster for `daily --json`.

## Binary Size

`target/release/ccusage` is 3.3 MB (`du`: 3.3 MB) with release settings optimized for size (`opt-level = "z"`, fat LTO, single codegen unit, stripped symbols, abort panics).

## Output Check

The benchmark output was compared against the TypeScript command path on the same live dataset with `jq -S` canonicalization.

The Rust and TypeScript JSON outputs were identical for `daily --json --offline` and `daily --json`.
