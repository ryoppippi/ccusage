---
name: profile
description: Profiles ccusage performance. Use when debugging slow Rust CLI commands, TypeScript package scripts, launchers, benchmarks, packaging hot paths, or branch-vs-main speed changes.
---

# ccusage Profile

Use this skill for ccusage performance work. The production CLI is Rust-first,
but the TypeScript launcher and Nushell benchmark/package scripts still need
focused profiling when those paths are in scope.

## Rust

Read `references/rust.md` for native CLI profiling, branch-vs-main worktree
setup, `hyperfine` validation, JSON parity checks, and PR performance workflow
reproduction.

## TypeScript And Scripts

Read `references/typescript.md` for Node profiler commands, package script
profiling, TypeScript launcher/Nushell benchmark setup, profile reading, and
ccusage-specific performance lessons.
