---
name: profile
description: Profiles ccusage performance. Use when debugging slow Rust CLI commands, TypeScript package scripts, launchers, benchmarks, packaging hot paths, or branch-vs-main speed changes.
---

# ccusage Profile

Use this skill for ccusage performance work. The production CLI is Rust-first,
but TypeScript launcher, benchmark, and packaging scripts still need Bun
profiling when those paths are in scope.

## Rust

Read `references/rust.md` for native CLI profiling, branch-vs-main worktree
setup, `hyperfine` validation, JSON parity checks, and PR performance workflow
reproduction.

## TypeScript And Bun

Read `references/typescript.md` for Bun profiler commands, package script
profiling, TypeScript launcher/benchmark setup, profile reading, local Bun docs,
and ccusage-specific performance lessons.
