# CLAUDE.md - Documentation

This directory contains the VitePress-based documentation website for ccusage.

## Package Overview

**Name**: `@ccusage/docs`
**Description**: Documentation for ccusage
**Type**: VitePress documentation site (private package)

## Development Commands

**Documentation Development:**

- `pnpm run dev` - Start development server with schema copy
- `pnpm run build` - Build documentation site for production
- `pnpm run preview` - Preview built documentation locally
- `pnpm run lint` - Lint documentation files using ESLint
- `pnpm run format` - Format and auto-fix documentation files with ESLint
- `pnpm typecheck` - Type check TypeScript files

**Deployment:**

- `pnpm run deploy` - Deploy to Cloudflare using Wrangler

## Architecture

**Documentation Structure:**

- `guide/` - User guides and tutorials with screenshots
- `public/` - Static assets including screenshots and config schema
- `.vitepress/` - VitePress configuration and theme customization

**Key Files:**

- `public/config-schema.json` - JSON schema copied from ccusage package during build

## Documentation Guidelines

**Screenshot Usage:**

- **Placement**: Always place screenshots immediately after main headings (H1)
- **Purpose**: Provide immediate visual context before textual explanations
- **Guides with Screenshots**:
  - `/docs/guide/index.md` - Main usage screenshot
  - `/docs/guide/daily-reports.md` - Daily report output screenshot
  - `/docs/guide/live-monitoring.md` - Live monitoring dashboard screenshot
- **Image Path**: Use relative paths like `/screenshot.png` for images in `/docs/public/`
- **Alt Text**: Always include descriptive alt text for accessibility

**Content Organization:**

- User-facing guides in `guide/` directory
- Static assets and schemas in `public/` directory

## Build Process

1. **Schema Copy**: `config-schema.json` is copied from the ccusage package to public directory
2. **VitePress Build**: Standard VitePress build process creates static site
3. **Deployment**: Built site is deployed to Cloudflare using Wrangler

## Dependencies

**Key Dev Dependencies:**

- `vitepress` - Static site generator
- `wrangler` - Cloudflare deployment tool

**VitePress Plugins:**

- `vitepress-plugin-group-icons` - Group icons in navigation
- `vitepress-plugin-llms` - LLM-specific enhancements
- `@ryoppippi/vite-plugin-cloudflare-redirect` - Cloudflare redirect handling

## Development Workflow

1. **Start Development**: `pnpm run dev` copies the config schema and starts dev server
2. **Edit Content**: Modify markdown files in `guide/`
3. **Preview Changes**: Development server automatically reloads on changes
4. **Build for Production**: `pnpm run build` generates final static site
5. **Deploy**: `pnpm run deploy` pushes to Cloudflare

## Content Guidelines

- **No console.log**: Documentation scripts should use appropriate logging
- **Accessibility**: Always include alt text for images and screenshots
- **Visual First**: Lead with screenshots, then explain with text
- **Consistency**: Follow established patterns for new documentation pages
- **Cross-References**: Link between related guides and JSON output documentation
- **ESLint in Markdown**: For code blocks that should skip ESLint parsing (e.g., containing `...` syntax), add `<!-- eslint-skip -->` before the code block

## File Organization

```
docs/
├── guide/          # User guides and tutorials
├── public/         # Static assets (screenshots, schemas)
├── .vitepress/     # VitePress configuration
├── package.json    # Dependencies and scripts
└── CLAUDE.md       # This file
```
