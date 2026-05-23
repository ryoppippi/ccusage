# Documentation Site

This directory contains the VitePress documentation website for ccusage.

The public site is hosted on Cloudflare at https://ccusage.com.

## Structure

- `guide/` - user guides and tutorials.
- `public/` - screenshots, static assets, and generated config schema.
- `.vitepress/` - VitePress configuration and theme customization.

The docs build copies `apps/ccusage/config-schema.json` to
`docs/public/config-schema.json` before running VitePress.

## Commands

```sh
pnpm --filter docs dev
pnpm --filter docs build
pnpm --filter docs preview
pnpm --filter docs format
pnpm --filter docs typecheck
```
