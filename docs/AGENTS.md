# AGENTS.md - Documentation

Read `README.md` first for the documentation site structure and commands. This
file adds agent workflow rules for changes under `docs/`.

## Package Notes

- Guides live in `guide/`.
- Static assets and generated schema live in `public/`.
- VitePress configuration lives in `.vitepress/`.
- The public site is hosted on Cloudflare at https://ccusage.com.

Use the root `development` guidance for shared repository validation.

## Content Rules

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
