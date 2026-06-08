# ccusage Commands

`just` is the single entry point for repo-wide tasks. Run `just --list` to see
every recipe. Use these unless a narrower package command is more appropriate:

```sh
just test
just fmt
just typecheck
just build
just check
just release
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
