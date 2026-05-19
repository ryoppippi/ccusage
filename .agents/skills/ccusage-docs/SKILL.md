---
name: ccusage-docs
description: Guides ccusage VitePress documentation work. Use when editing docs, screenshots, accessibility, schema-copy behavior, markdown linting, or user-facing guides.
---

# ccusage Docs

The docs package is a VitePress site under `docs/`.

## Commands

```sh
pnpm --filter docs dev
pnpm --filter docs build
pnpm --filter docs preview
pnpm --filter docs format
pnpm --filter docs typecheck
```

The docs build copies `apps/ccusage/config-schema.json` to `docs/public/config-schema.json` before running VitePress.

## Structure

- `README.md` and `apps/ccusage/README.md` - package entrypoints for supported sources, common commands, features, and installation examples
- `docs/guide/` - user guides and tutorials
- `docs/public/` - screenshots, static assets, and generated config schema
- `docs/.vitepress/` - VitePress configuration and theme customization

## Content Rules

- When adding or changing a user-facing agent, command, option, report mode, or example, audit and update the root `README.md`, `apps/ccusage/README.md`, relevant `docs/guide/` pages, related cross-links, and VitePress navigation before finishing.
- Prefer the unified command form in new or edited docs: `ccusage codex ...`, `ccusage opencode ...`, `ccusage amp ...`, and `ccusage pi ...`.
- Standalone wrapper commands such as `ccusage-codex`, `ccusage-opencode`, `ccusage-amp`, and `ccusage-pi` have been removed. Do not promote or reintroduce them in docs.
- Place screenshots immediately after the page H1 when a guide has a primary screenshot.
- Use relative image paths such as `/screenshot.png` for files in `docs/public/`.
- Always include descriptive alt text for screenshots and images.
- Lead with visual context when a guide has an established screenshot pattern.
- Cross-link related guides and JSON output documentation where useful.
- For markdown code blocks that ESLint should skip, put `<!-- eslint-skip -->` before the block.

Known screenshot-led guides include:

- `docs/guide/index.md`
- `docs/guide/daily-reports.md`
- `docs/guide/live-monitoring.md`
