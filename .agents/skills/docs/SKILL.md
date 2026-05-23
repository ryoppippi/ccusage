---
name: docs
description: Routes ccusage documentation impact work. Use when code or behavior changes affect README files, docs guides, VitePress navigation, screenshots, schema docs, or user-facing commands/options.
---

# ccusage Docs

Use this skill when a change may affect user-facing documentation, even when the
edited files are outside `docs/`.

## Documentation Impact

When adding or changing a user-facing agent, command, option, report mode,
configuration shape, JSON field, screenshot-visible output, or example, audit:

- root `README.md`
- `apps/ccusage/README.md`
- relevant `docs/guide/` pages
- related cross-links
- VitePress navigation

The root `AGENTS.md` owns the cross-cutting flow. This skill exists to route the
documentation audit and point to the right local docs guidance.

## Local Guidance

- Read `docs/README.md` for docs site structure and commands.
- Read `docs/AGENTS.md` for docs writing conventions, screenshot placement,
  accessibility, schema-copy behavior, and markdown linting notes.
- Read `apps/ccusage/AGENTS.md` before changing package README content tied to
  the published npm package.

## Scope

Do not create or update docs proactively for internal-only refactors, test-only
changes, or skill/docs-maintenance changes unless they alter user-facing
commands, behavior, configuration, or examples.
