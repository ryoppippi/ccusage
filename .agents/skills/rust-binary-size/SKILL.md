---
name: rust-binary-size
description: Guides Rust binary size reduction for ccusage. Use when changing release profiles, dependency features, native packaging size, or investigating Rust executable bloat.
paths:
  - 'rust/Cargo.toml'
  - 'rust/**/*.rs'
  - 'rust/**/*.toml'
  - 'apps/ccusage/scripts/**'
globs: 'rust/**/*.rs,rust/**/*.toml,apps/ccusage/scripts/**'
---

# Rust Binary Size

Use this skill when applying binary-size guidance to the Rust-first `ccusage`
CLI, release profiles, native package binaries, dependency features, or size
regression investigations.

Primary external reference: <https://github.com/johnthagen/min-sized-rust>

## Baseline

Start by checking the existing release profile before adding new size settings:

```sh
sed -n '1,120p' rust/Cargo.toml
```

This workspace should keep stable release settings aligned with
`min-sized-rust` unless a measured tradeoff argues otherwise:

- `opt-level = "z"` for workspace crates unless benchmarking shows `"s"` is smaller.
- `lto = "fat"` for maximum cross-crate dead-code elimination in release builds.
- `codegen-units = 1` for better release optimization.
- `panic = "abort"` only for binaries where stack unwinding is not required.
- `strip = "symbols"` or an equivalent stable strip setting for packaged binaries.

## Investigation

Prefer measurement before changing code or dependencies:

```sh
direnv exec . cargo build --manifest-path rust/Cargo.toml --release --bin ccusage
ls -lh rust/target/release/ccusage
```

When a size regression is not explained by the release profile, inspect
dependency features and large symbols before editing:

```sh
direnv exec . cargo tree --manifest-path rust/Cargo.toml -e features -p ccusage
direnv exec . cargo bloat --manifest-path rust/Cargo.toml --release --bin ccusage --crates
```

If `cargo bloat` is unavailable, use the `missing-tools` skill or run it through
the Nix/dev-shell path preferred by the repository. Do not add a new tool to the
flake unless repeated project work needs it.

## Safe Changes

Prefer stable, low-risk changes first:

- Disable unnecessary dependency default features when tests prove the disabled
  features are not required.
- Narrow optional dependency features instead of replacing a well-fitting crate.
- Remove unused code paths, generated assets, or format-heavy diagnostics from
  release-only paths only when behavior remains correct.
- Keep `ccusage` functionality, JSON output, table output, and packaging
  semantics unchanged unless the user explicitly asks for a behavior change.

## Risky Changes

Treat these as opt-in only unless the user explicitly asks for an aggressive
minimum-size experiment:

- Nightly-only flags such as `-Zlocation-detail`, `-Zfmt-debug`,
  `panic=immediate-abort`, or `build-std`.
- `#![no_std]`, `#![no_main]`, C entry points, or manual stdio.
- UPX or other binary packers, especially for distributed CLI artifacts.
- Dynamic Rust linking through `prefer-dynamic`, because deployment and ABI
  constraints make it unsuitable for ordinary CLI releases.

## Validation

After changes, run formatting and the relevant behavioral checks:

```sh
direnv exec . just fmt
direnv exec . just test
```

For release-profile or packaging changes, also build the native CLI and compare
the binary size with the previous measurement. Record the command and result in
the PR body or review reply.
