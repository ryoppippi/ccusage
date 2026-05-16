# ccusage Commands

Use root commands unless a narrower package command is more appropriate:

```sh
pnpm run test
pnpm run format
pnpm typecheck
pnpm run build
pnpm run prerelease
```

Useful main CLI commands:

```sh
pnpm --filter ccusage run start daily
pnpm --filter ccusage run start monthly
pnpm --filter ccusage run start session
pnpm --filter ccusage run start blocks
pnpm --filter ccusage run start daily --json
pnpm --filter ccusage run start daily --mode auto
pnpm --filter ccusage run start blocks --active
pnpm --filter ccusage run start blocks --recent
pnpm --filter ccusage run start blocks --token-limit max
pnpm --filter ccusage run test:statusline
cat apps/ccusage/test/statusline-test.json | pnpm --filter ccusage run start statusline
```
