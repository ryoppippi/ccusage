---
name: bun-cpu-profile
description: Profiles Bun TypeScript and JavaScript package scripts. Use for launcher, benchmark, or packaging hot paths; use ccusage-rust-profile for native CLI performance.
---

# Bun CPU Profile

Use this skill for TypeScript package scripts. The production CLI is Rust-first,
so native command performance work should use the `ccusage-rust-profile` skill
instead.

## Workflow

Read `references/profile-workflow.md` before profiling. It contains the Bun
profiler commands, ccusage branch-vs-main setup, hyperfine validation,
profile-reading checklist, Bun reference lookup, and lessons from past ccusage
performance work.
