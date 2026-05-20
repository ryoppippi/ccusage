# ccusage A/B Setup

For branch-vs-main performance work, create a separate worktree so both versions
can be built and profiled without switching the active checkout.

```sh
git fetch origin main
git worktree add /tmp/ccusage-main origin/main
pnpm install
pnpm --filter ccusage build
cd /tmp/ccusage-main
pnpm install
pnpm --filter ccusage build
```

Run the same command against both builds. Prefer the published package entry
shape when profiling package startup or launcher behavior.

```sh
LOG_LEVEL=0 COLUMNS=200 node apps/ccusage/dist/cli.js daily --offline --json >/tmp/head.json
LOG_LEVEL=0 COLUMNS=200 node /tmp/ccusage-main/apps/ccusage/dist/cli.js daily --offline --json >/tmp/main.json
jq -e . /tmp/head.json >/dev/null
jq -e . /tmp/main.json >/dev/null
```

Measure end-to-end command latency with hyperfine before trusting a CPU profile
change:

```sh
hyperfine --warmup 4 --runs 10 --shell none \
	"node apps/ccusage/dist/cli.js daily --offline --json" \
	"node /tmp/ccusage-main/apps/ccusage/dist/cli.js daily --offline --json" \
	--export-json /tmp/ccusage-hyperfine.json
```

If `hyperfine` is missing, use comma first:

```sh
, hyperfine --warmup 4 --runs 10 --shell none "node apps/ccusage/dist/cli.js daily --offline --json"
```
