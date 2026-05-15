# Plan: Consolidate Agent Usage CLIs into ccusage

## Goal

Make `ccusage` the single entry point for coding agent usage reporting across Claude Code, Codex, OpenCode, Amp, and pi-agent.

The existing companion packages should remain temporarily as compatibility wrappers, but the implementation, optimizations, documentation, and future feature work should live in `ccusage`.

## Main Branch Baseline

This plan assumes the branch includes the latest `origin/main` commit:

```txt
14db99a feat(codex): account for fast mode pricing (#996)
```

That commit adds Codex fast mode pricing support:

- `apps/codex/src/codex-config.ts`
- `--speed auto|standard|fast`
- automatic `CODEX_HOME/config.toml` `service_tier` detection
- fast pricing multiplier support in `apps/codex/src/pricing.ts`

The all-agent Codex adapter must preserve this pricing behavior.

## Product Direction

Use `ccusage` as the all-agent usage dashboard.

Default behavior should favor the new all-agents experience:

```sh
ccusage
ccusage daily
```

These should show all detected agents by default.

Agent-specific reports should use an agent-first command namespace:

```sh
ccusage codex
ccusage codex daily
ccusage codex monthly --speed fast
ccusage claude daily --mode display
ccusage claude blocks
ccusage opencode weekly
ccusage amp session
ccusage pi daily --pi-path /path/to/sessions
```

`--all` should remain available as an explicit form:

```sh
ccusage daily --all
ccusage --all
```

Agent selection should stay on the command namespace:

```sh
ccusage codex daily
ccusage claude monthly
```

Do not add `-a` / `--agent` in the first implementation. Agent-specific options and aggregation behavior differ enough that a filter option would create two competing ways to express the same target.

Avoid first-class per-agent boolean flags such as:

```sh
ccusage daily --codex
ccusage daily --opencode
```

They look convenient, but they do not scale well with multiple agents, `--all`, config files, or future agent additions. Agent-first commands are clearer when the option and report semantics differ by agent.

## Breaking Change Assessment

This is a meaningful CLI behavior change and should be treated as a major release unless we deliberately keep the old top-level behavior for one transition release.

Breaking surfaces:

- `ccusage` and `ccusage daily` changing from Claude-only to all-agents output.
- Claude-specific top-level commands moving from `ccusage blocks` to `ccusage claude blocks`.
- Existing scripts expecting Claude-only JSON from `ccusage daily --json`.
- Table columns changing to include `Agent` in all-agent reports.
- Companion package commands becoming wrappers with deprecation warnings.

Release strategy:

1. Ship this as a major release because `ccusage` defaults to all agents immediately.
2. Keep top-level `ccusage blocks` and `ccusage statusline` as deprecated aliases for one major if possible, forwarding to `ccusage claude blocks` and `ccusage claude statusline`.
3. Keep `ccusage claude daily --json` as the stable migration path for scripts that need old Claude-only JSON.
4. Add release notes with explicit before/after examples.
5. After opening the PR, wait for CodeRabbit and Cubic reviews, address actionable feedback, rerun the full verification suite, push updates, and repeat until the automated review loop is clean or only explicitly accepted non-blocking comments remain.

## Bundle Size Budget

Use the `pkg.pr.new` preview from `main` as the size baseline, not local sourcemap-heavy build output.

The relevant optimization baseline is PR #984 (`perf(ccusage): optimize bundled cli performance`).
Important details from that PR:

- Preview install command was `pnpm dlx https://pkg.pr.new/ryoppippi/ccusage@984 -- --offline`; `bun x https://pkg.pr.new/...` did not work for that preview package.
- Published launchers auto-run the bundled Bun entrypoint when `bun` is available on `PATH`; `CCUSAGE_BUN_AUTO_RUN=0` forces the Node path.
- Performance comparisons should use built package entrypoints, `LOG_LEVEL=0`, `COLUMNS=200`, and `--offline --json` so LiteLLM fetches and terminal wrapping do not dominate measurements.
- The repeatable CI signal is the fixture comparison from `apps/ccusage/scripts/compare-pr-performance.ts`; local real-data numbers are directional.
- PR #984 fixed large stdout truncation by waiting for stream writes, so large JSON checks must pipe through `jq -e .` on both Node-forced and Bun-available paths.
- Worker-side chunk dedupe was explicitly rejected because it changed byte-identical JSON output through aggregation order and floating-point tails. Do not reintroduce worker-side dedupe unless byte-for-byte parity is preserved.
- Summary aggregation moved toward null-prototype object indexes and insertion-order model lists where exact string keys dominate hot paths.

Measured on the `main` preview packages:

| Package             |   Packed | Unpacked |
| ------------------- | -------: | -------: |
| `ccusage`           |  44.3 KB | 165.8 KB |
| `@ccusage/codex`    |  56.3 KB | 243.1 KB |
| `@ccusage/opencode` |  58.4 KB | 252.4 KB |
| `@ccusage/amp`      |  52.6 KB | 229.7 KB |
| `@ccusage/pi`       |  45.7 KB | 180.3 KB |
| Naive sum           | 257.3 KB |  1.07 MB |

The final all-agent `ccusage` package should be comfortably under 1 MB packed. It may approach or exceed 1 MB unpacked if we simply concatenate every current app, but packed install/download size should stay well below 1 MB because shared runtime code, terminal table code, pricing helpers, and README/license/package metadata will no longer be duplicated across packages.

Bundle-size requirements:

- Keep the packed `ccusage-*.tgz` under 1 MB.
- Warn in CI above 750 KB packed size.
- Track unpacked size as a secondary metric, but do not optimize against sourcemaps because published `files` excludes maps today.
- Keep companion wrappers tiny; they should not bundle their old implementations.
- Add a CI/package-size check using `npm pack --json` or the existing performance script.
- Prefer lazy imports for agent implementations so `ccusage --help`, `ccusage --version`, and simple Claude paths do not eagerly load every adapter.

Dependency requirements:

- Do not reintroduce `fast-sort`, `tinyglobby`, or `es-toolkit` into `ccusage`.
- Do not implement the first all-agent version by importing sibling app commands wholesale if that pulls their old dependency graph into `ccusage`.
- Move agent logic into `ccusage` by porting it onto the optimized `ccusage` primitives first.
- Companion packages may temporarily keep their old dependencies until they become tiny wrappers, but the final wrapper packages should depend on `ccusage` only plus package tooling.

## Optimization Migration Requirements

The purpose of the consolidation is not just one entry point; it is to let every coding-agent report benefit from the recent `ccusage` runtime work.

Use `ccusage` as the implementation baseline:

- Replace `tinyglobby` usage in Codex, OpenCode, Amp, and pi-agent loaders with the dependency-free recursive traversal approach used by `ccusage`.
- Replace `fast-sort` and `es-toolkit` usage with native `Array.prototype.sort`, `Map`, and small local helpers from `@ccusage/internal` where needed.
- Reuse the PR #984 `ccusage` file-loading strategy: parallel directory traversal, bounded concurrency, buffered small-file reads, stream fallback for oversized files, size-aware work distribution, and worker-thread parsing for large file sets where the agent data format benefits from it.
- Reuse marker scanning and fast parsing where the format has stable JSONL markers. Codex and pi-agent JSONL loaders should avoid validating every hot-path line through Valibot once cheaper structural extraction is available.
- Keep columnar worker payloads or equivalent compact transfer shapes for hot paths that return many rows. Avoid cloning one full object per raw line across worker boundaries when compact numeric/string arrays are practical.
- Keep dedupe and aggregation on native `Map`/`Set` structures and avoid object-shape churn in hot loops.
- Prefer null-prototype object indexes in proven exact-string-key hot paths, matching PR #984, while preserving first-seen order where output depends on it.
- When adding missing agent-specific subcommands, design their cache behavior at the same time instead of treating caching as a later bolt-on.
- Reuse `@ccusage/internal/json-file-state` for persistent cache state where the command is repeatedly invoked, and prefer transcript/file modification checks plus time-based expiry for statusline-like hot paths.
- Preserve the existing optimized Claude Code path and extend the same patterns to new adapters instead of regressing it into a generic slow path.

Shared helper candidates from PR #984:

- dependency-free recursive directory walking
- sparse result slot allocation
- bounded concurrency mapping
- small JSONL buffer reads with large-file stream fallback
- JSONL marker scanning that decodes only candidate usage lines
- file-size-weighted worker chunking
- worker thread count selection with `CCUSAGE_JSONL_WORKER_THREADS`
- compact worker response encoding

Implementation rule:

- Before wiring an agent into the all-agent CLI, first remove or bypass that agent's old heavy dependencies and confirm the agent can build through `ccusage` without adding them to `apps/ccusage/package.json`.

## CLI Contract

Supported commands:

```sh
ccusage
ccusage daily
ccusage weekly
ccusage monthly
ccusage session

ccusage --all
ccusage daily --all

ccusage claude
ccusage codex
ccusage opencode
ccusage amp
ccusage pi

ccusage claude daily
ccusage codex monthly
ccusage opencode weekly
ccusage amp session
ccusage pi daily

```

Do not add report-mode boolean aliases in the first implementation:

```sh
ccusage --daily
ccusage codex --daily
```

Keep report modes as commands. This avoids mutually exclusive report flags such as `--daily --monthly` and keeps `daily`, `monthly`, and `session` aligned with Gunshi subcommands.

Option semantics:

- `--all`: include all detected supported agents explicitly.
- no `--all`: include all detected supported agents.
- agent selection is expressed with `<agent> <report>`, not `--agent`.
- `<agent> <report>`: run an agent-specific report engine with that agent's options.

Recommended agent IDs:

- `claude`
- `codex`
- `opencode`
- `amp`
- `pi`

Claude-specific commands should stay available, but should validate capability:

```sh
ccusage claude blocks
ccusage claude statusline
```

If a user asks for an unsupported combination, return a clear error:

```sh
ccusage codex blocks
```

Expected message shape:

```txt
The "blocks" report is only available for Claude Code usage.
Use `ccusage codex daily` for Codex usage reports.
```

## Gunshi Consideration

Gunshi 0.26.3 resolves the subcommand from the first positional token only.

Implement agent-specific commands as flat Gunshi subcommands generated from agent/report pairs. Normalize `argv` before calling `cli()`.

```sh
ccusage codex monthly  -> codex:monthly
ccusage claude blocks  -> claude:blocks
ccusage codex          -> codex:daily
```

Top-level reports remain normal Gunshi subcommands:

```sh
ccusage daily          -> daily
ccusage monthly        -> monthly
```

Do not support option-first agent selection syntax:

```sh
ccusage -a codex monthly
```

Gunshi treats this as the default command because the first token is an option. Keep documentation agent-first for dedicated reports and command-first for all-agent reports.

Subcommand map shape:

```ts
const subCommands = new Map([
	['daily', allDailyCommand],
	['monthly', allMonthlyCommand],
	['session', allSessionCommand],
	['codex:daily', codexDailyCommand],
	['codex:monthly', codexMonthlyCommand],
	['claude:blocks', claudeBlocksCommand],
]);
```

## Internal Architecture

Introduce a normalized usage event model in `ccusage`.

```ts
type AgentId = 'claude' | 'codex' | 'opencode' | 'amp' | 'pi';

type UsageEvent = {
	agent: AgentId;
	timestamp: string;
	sessionId?: string;
	project?: string;
	model?: string;
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	costUSD: number;
	metadata?: Record<string, unknown>;
};
```

Add an adapter interface for each agent:

```ts
type UsageAgentAdapter = {
	id: AgentId;
	label: string;
	loadEvents: (options: LoadOptions) => Promise<UsageEvent[]>;
	args?: Args;
	capabilities: {
		daily: boolean;
		weekly: boolean;
		monthly: boolean;
		session: boolean;
		blocks: boolean;
		statusline: boolean;
	};
};
```

The first implementation should move behavior with minimal risk:

- Keep existing Claude Code loaders mostly intact.
- Port Codex/OpenCode/Amp/pi loaders into `ccusage` as adapters after replacing their old dependency-heavy traversal/sort/grouping helpers.
- Normalize each adapter output into `UsageEvent[]`.
- Reuse one shared aggregation layer for daily, weekly, monthly, and session reports.
- Preserve agent-specific metadata where needed, such as Amp credits.

Core design principle:

- Consolidation and reuse are both required. The goal is not merely to collect multiple CLIs under one binary, and it is not to avoid consolidation either. The goal is to make `ccusage` the single entry point while running every supported coding agent on top of the optimized `ccusage` foundation.
- Agent-specific code should be limited to discovery, parsing, normalization, and genuinely agent-specific accounting rules.
- Date normalization, period grouping, sorting, totals, table rendering, JSON shape policy, stdout flushing, logging, pricing fetch sharing, and bundle/dependency policy should come from the existing `ccusage` foundation wherever possible.
- This is what makes the package smaller and future agents easier to add: a new agent should mostly provide an adapter and capability metadata, not a second table renderer, second date formatter, second logger, or second all-report implementation.

All-agent implementation rules:

- Treat `all` as the internal and external name. Avoid `unified` naming in files, exported symbols, docs, and tests.
- Do not feed already-rendered agent report rows into the all-agent report path. Agent report rows may contain display-only dates such as `Sep 11, 2025`; all-agent aggregation needs canonical `YYYY-MM-DD` / `YYYY-MM` period keys first.
- Build all-agent daily, weekly, and monthly rows from canonical periods, sort by those period keys, then render through the shared ccusage table formatter.
- Group all-agent daily, weekly, and monthly output by period. Render one parent `All` row for the date/week/month and per-agent child rows beneath it, similar to `ccusage session --breakdown`; do not collapse agents into a multi-line Agent cell.
- Session output may remain one row per agent session because session IDs are not comparable across agents, but it must still sort by canonical last-activity timestamps where available rather than by already-formatted display strings.
- Use the ccusage date utilities for OpenCode, Amp, and any future timestamp-based adapter instead of ad hoc UTC string splitting.
- Keep date display consistent across Claude, all-agent, and agent-specific reports. Normalize to canonical keys for aggregation and use the shared table/date formatter for display.
- Never use display-formatted month/date strings as map keys or sort keys.
- Share one LiteLLM pricing fetcher in the online all-agent path so concurrent Codex/OpenCode/Amp costing performs one pricing load and reuses the in-flight result.
- Offline pricing must still use each adapter's cached provider dataset where supported. Amp cached pricing must include Anthropic Bedrock-style keys such as `anthropic.claude-3-5-haiku-20241022-v1:0`.
- The first table box should contain the report title and a second `Detected:` line, and it should be printed before heavy parsing/pricing work begins.
- Use `createUsageReportTable`, `formatUsageDataRow`, `formatTotalsRow`, `addEmptySeparatorRow`, and `writeStdoutLine` for all-agent output. Do not create a separate table renderer for all-agent reports.
- If the shared table needs an Agent column or better minimum widths, extend the shared table helper narrowly and use the same helper from all-agent reports.
- Table width priority: period/date and cost must remain readable before model names. If space is tight, shrink/wrap/truncate model names first; do not truncate dates or total cost in a way that hides the value.

## Proposed Directory Layout

Keep the extension point explicit. Do not put every new agent into one large shared loader or command file.

Recommended layout:

```txt
apps/ccusage/src/
  cli.ts
  main.ts
  commands/
    index.ts
    all/
      daily.ts
      weekly.ts
      monthly.ts
      session.ts
    agents/
      index.ts
      _create-agent-command.ts
  core/
    usage-event.ts
    agent.ts
    registry.ts
    selection.ts
    options.ts
    reports/
      daily.ts
      weekly.ts
      monthly.ts
      session.ts
    renderers/
      all-table.ts
      json.ts
  agents/
    claude/
      index.ts
      args.ts
      adapter.ts
      commands/
        daily.ts
        weekly.ts
        monthly.ts
        session.ts
        blocks.ts
        statusline.ts
      loaders/
      pricing/
    codex/
      index.ts
      args.ts
      adapter.ts
      commands/
        daily.ts
        monthly.ts
        session.ts
      loaders/
      pricing/
      codex-config.ts
    opencode/
      index.ts
      args.ts
      adapter.ts
      commands/
        daily.ts
        weekly.ts
        monthly.ts
        session.ts
      loaders/
      pricing/
    amp/
      index.ts
      args.ts
      adapter.ts
      commands/
        daily.ts
        monthly.ts
        session.ts
      loaders/
      pricing/
    pi/
      index.ts
      args.ts
      adapter.ts
      commands/
        daily.ts
        monthly.ts
        session.ts
      loaders/
      pricing/
```

Layering rules:

- `core/` cannot import from a concrete agent.
- `agents/<id>/` can import from `core/` and shared packages.
- top-level all-agent commands use `core/registry.ts` and `core/reports/*`.
- agent namespace commands delegate to `agents/<id>/commands/*`.
- each agent owns its loader quirks, option parsing, pricing behavior, and report-specific display differences.
- common table primitives stay in `@ccusage/terminal`; only reusable cross-agent aggregation belongs in `core/`.

Agent registration shape:

```ts
type AgentModule = {
	id: AgentId;
	label: string;
	defaultReport: 'daily';
	capabilities: AgentCapabilities;
	loadEvents: (options: AgentLoadOptions) => Promise<UsageEvent[]>;
	commands: Map<string, Command>;
};
```

Use a registry rather than hard-coded conditionals in commands:

```ts
const agentRegistry = new Map<AgentId, LazyAgentModule>([
	['claude', () => import('../agents/claude/index.ts')],
	['codex', () => import('../agents/codex/index.ts')],
	['opencode', () => import('../agents/opencode/index.ts')],
	['amp', () => import('../agents/amp/index.ts')],
	['pi', () => import('../agents/pi/index.ts')],
]);
```

This keeps future agents additive: create `agents/new-agent/`, register it, and add docs/tests. The all-agent report path should only need capability and event-shape support.

## Option Model

Do not force all existing package options into one flat common option surface.

The current CLIs differ enough that agent-first commands should own the rich option surface. The top-level all-agent reports should stay intentionally conservative.

Use two command families:

1. All-agent reports: `ccusage daily`, `ccusage weekly`, `ccusage monthly`, `ccusage session`.
2. Agent-specific reports: `ccusage codex daily`, `ccusage claude weekly`, `ccusage opencode weekly`, `ccusage amp session`.

Use three option layers:

1. Global report options accepted for every agent.
2. All-agent-view filter options accepted by top-level reports.
3. Agent-specific options accepted only under that agent namespace.

Recommended always-global options:

- `-j, --json`
- `-s, --since`
- `-u, --until`
- `-z, --timezone`
- `--compact`
- `--color`
- `--no-color`

Recommended all-agent-view-only options:

- `--all`

Current known agent-specific or limited options:

| Option                                | Owner         | Notes                                                                                                                         |
| ------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--mode auto \| calculate \| display` | Claude        | Claude JSONL can contain precomputed `costUSD`; other agents generally calculate from tokens.                                 |
| `--debug`                             | Claude        | Pricing mismatch/debug output for Claude cost mode behavior.                                                                  |
| `--debug-samples`                     | Claude        | Supports Claude debug output.                                                                                                 |
| `--single-thread`                     | Claude        | Controls Claude JSONL worker loading.                                                                                         |
| `--config`                            | Claude        | Current config loader is Claude-oriented and should not silently apply to all agents without a schema update.                 |
| `--breakdown`                         | Claude, pi    | Other agents may support model display differently; make this capability-driven.                                              |
| `--offline`                           | Claude, Codex | Both support cached pricing, but the cache/provider set differs. Can become common only if each selected agent implements it. |
| `--speed auto \| standard \| fast`    | Codex         | Added on main; `auto` reads Codex `config.toml` service tier.                                                                 |
| `--pi-path`                           | pi            | pi-agent session directory override. Prefer a normalized `--data-dir` later only if it can be made unambiguous.               |

Current report-shape differences:

| Agent    | Difference                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Claude   | Has `blocks`, `statusline`, config merging, precomputed cost modes, project/instance grouping, and session ID lookup. |
| Codex    | Tracks reasoning output tokens and fast/standard pricing tier.                                                        |
| OpenCode | Has weekly reports today and reads both SQLite and file-backed data.                                                  |
| Amp      | Tracks credits as a first-class metric and groups sessions by thread.                                                 |
| pi       | Has explicit `--pi-path`, descending default order, and project-path-oriented sessions.                               |

All-agent report policy:

- Include only metrics that have comparable meaning across selected agents in the main table.
- Keep agent-specific metrics in JSON `metadata` for all-agent reports.
- Show Amp credits as a first-class column only in `ccusage amp ...` reports.
- Show Codex reasoning tokens as a first-class column only in `ccusage codex ...` reports unless a later all-agent schema promotes reasoning tokens across agents.
- The all-agent table is an aggregated report, not a concatenation of per-agent tables. For daily/weekly/monthly, rows should represent periods; agents are values inside the period row.
- JSON should expose enough metadata to see which agents contributed to an aggregated period row, but the table should prioritize one readable period row over repeated same-date rows.
- Totals must be calculated from the same aggregated rows that are rendered, so table totals and JSON totals cannot diverge.

Validation rules:

- If an agent namespace is selected, allow that agent's specific options.
- If a top-level all-agent report is selected, reject agent-specific options unless the option is explicitly promoted to the all-agent report contract.
- Error messages should name the unsupported agent and suggest the filtered command.

Example:

```sh
ccusage daily --all --speed fast
```

Suggested error:

```txt
`--speed` only applies to Codex usage.
Use `ccusage codex daily --speed fast`.
```

This prevents options such as Codex `--speed` or Claude `--mode` from silently affecting only part of an all-agents report.

Adapter option shape:

```ts
type AdapterOptionSupport = {
	args: Args;
	appliesTo: AgentId[];
};
```

Implementation approach:

- Define common report args once.
- Let each adapter export its own args.
- Compose top-level all-agent commands from common args only.
- Compose agent-specific commands from common args plus that agent's args.
- After parsing, validate the selected agent set against the provided option names.
- Track explicitly provided options from Gunshi tokens so defaults do not trigger false validation failures.

## Report Display

All-agent reports should include an agent column by default.

Daily example:

```txt
Date        Agent     Models          Input     Output    Cache Read    Cost
2026-05-15  Claude    Sonnet 4        ...
2026-05-15  Codex     GPT-5 Codex     ...
2026-05-15  OpenCode  Claude Sonnet   ...
TOTAL       all       3 models        ...
```

Grouping defaults:

- `daily`: date + agent
- `weekly`: ISO week + agent
- `monthly`: month + agent
- `session`: agent + session

JSON output must include `agent` on every row/object so downstream consumers can safely distinguish sources.

## Compatibility Packages

Keep these packages for now:

- `@ccusage/codex`
- `@ccusage/opencode`
- `@ccusage/amp`
- `@ccusage/pi`

Convert each package into a thin wrapper that depends on `ccusage` and forwards to the all-agent CLI with the matching agent.

Examples:

```sh
ccusage-codex daily
```

Should print a deprecation warning, then execute:

```sh
ccusage codex daily
```

Warning text:

```txt
`@ccusage/codex` is deprecated and will be removed in a future version.
Use `ccusage codex` or `ccusage codex daily` instead.
```

Wrapper behavior:

- Print the warning to stderr.
- Preserve the original subcommand and options.
- Prefix the forwarded command with the matching agent namespace.
- Keep package names and binaries available during the migration window.
- Document that the wrappers are compatibility shims.

Package dependency direction:

- Companion packages depend on `ccusage`.
- `ccusage` must not depend on companion packages.

This keeps all bundle-size and runtime optimizations centralized in the main package.

## Documentation Updates

Update the main `ccusage` README and docs site around the all-agent entry point.

Primary examples:

```sh
npx ccusage@latest
npx ccusage@latest daily
npx ccusage@latest codex daily
npx ccusage@latest daily --all
```

Document supported agents in one table:

| Agent       | ID         | Former package      | Data location             |
| ----------- | ---------- | ------------------- | ------------------------- |
| Claude Code | `claude`   | `ccusage`           | Claude config directories |
| Codex       | `codex`    | `@ccusage/codex`    | `CODEX_HOME`              |
| OpenCode    | `opencode` | `@ccusage/opencode` | `OPENCODE_DATA_DIR`       |
| Amp         | `amp`      | `@ccusage/amp`      | Amp data directory        |
| pi-agent    | `pi`       | `@ccusage/pi`       | `PI_AGENT_DIR`            |

Update each companion package README:

- Mark the package as deprecated or compatibility-only.
- Put `ccusage <agent>` and `ccusage <agent> <report>` at the top.
- Keep old invocation examples only under a migration section.

Add migration examples:

```sh
npx @ccusage/codex@latest daily
# becomes
npx ccusage@latest codex daily

npx @ccusage/opencode@latest monthly --json
# becomes
npx ccusage@latest opencode monthly --json
```

## Implementation Phases

### Phase 1: Core CLI surface

- Add agent namespace commands: `claude`, `codex`, `opencode`, `amp`, and `pi`.
- Add `--all` to top-level all-agent report args.
- Keep agent selection on subcommands; do not add `-a, --agent`.
- Keep `ccusage`, `ccusage daily`, and `ccusage --all` on the all-agents path.
- Keep `ccusage <agent>` as that agent's default daily report.
- Add an `argv` normalization step that maps `ccusage <agent> <report>` to flat Gunshi commands like `<agent>:<report>`.
- Do not add `--daily`, `--monthly`, or `--session` report flag aliases in this implementation.
- Split top-level common options from agent-specific options.
- Add validation for unsupported agent-specific options.
- Keep deprecated top-level Claude aliases where practical: `blocks` and `statusline`.

### Phase 2: Adapter migration

- Create `core/` and `agents/` directories before moving logic so the migration does not collapse into one large command module.
- Extract dependency-free traversal, grouping, and bounded-concurrency helpers from the optimized Claude path into reusable `core/` or `@ccusage/internal` modules.
- Move Codex loader logic into `ccusage` after replacing `tinyglobby` and `fast-sort` usage with optimized shared/native helpers. Apply the PR #984 JSONL strategy: buffered reads, bounded concurrency, size-weighted workers, compact worker payloads, and a fast parser that avoids Valibot on the common hot path.
- Preserve Codex `--speed auto|standard|fast` behavior and `config.toml` service tier detection.
- Move OpenCode loader logic into `ccusage` after replacing `tinyglobby` and `es-toolkit` grouping with optimized shared/native helpers. Keep SQLite reads as the primary fast path, and apply bounded/worker file fallback loading for JSON storage files.
- Move Amp loader logic into `ccusage` after replacing `tinyglobby` with optimized shared traversal. Apply worker file loading for thread JSON files when the thread count is high enough to benefit.
- Move pi-agent loader logic into `ccusage` after replacing `tinyglobby` with optimized shared traversal. Apply the same JSONL buffering/worker approach as Codex where possible.
- Add worker-thread parsing where the data shape benefits from it, but retain lightweight inline parsing for small file counts and tests.
- Normalize all outputs to `UsageEvent[]`.
- Preserve current tests while adding adapter-level tests.

### Phase 3: Shared aggregation and output

- Build shared daily, weekly, monthly, and session aggregation over `UsageEvent[]`.
- Add Agent column support by extending the shared usage table helper, not by hand-building a separate `ResponsiveTable`.
- Ensure daily/weekly/monthly all-agent rows are grouped by period and sorted by canonical period key, then displayed as a parent `All` row plus per-agent child rows.
- Ensure date/month/week display is consistent with existing ccusage reports by using the shared date formatter only at render time.
- Ensure compact mode still works and preserves date/period, total tokens, and cost readability before model-name width. For narrow all-agent tables, drop to `period / Agent / Total Tokens / Cost (USD)`.
- Ensure `--json` includes `agent` for unaggregated rows or `agent: "all"` plus contributing agents metadata for aggregated all-agent rows.
- Preserve Claude-specific `blocks` and `statusline`.

### Phase 4: Compatibility wrappers

- Convert companion packages into wrappers around `ccusage`.
- Add deprecation warnings.
- Forward args under the correct agent namespace.
- Keep existing package binaries working.

### Phase 5: Documentation and release

- Update main README.
- Update docs site agent guides.
- Update companion package READMEs.
- Add release notes with migration examples.
- Treat this as a major release.
- Document package-size numbers from `pkg.pr.new`, warn over 750 KB packed, and fail over 1 MB packed.
- Record local smoke-test timings for representative commands, including `ccusage`, `ccusage codex daily`, `ccusage opencode daily`, `ccusage amp daily`, and `ccusage pi daily`, so runtime regressions are visible alongside bundle-size changes.
- Run timing smoke tests with `--offline --json` where supported so LiteLLM pricing fetches do not dominate the measurement.
- Include data-source size context in PR notes when useful, for example Codex log directory size and JSONL file count, because large local histories can dominate elapsed time.
- After submitting the PR, wait for CodeRabbit and Cubic, apply actionable review comments, rerun format/typecheck/test/build/package-size checks plus smoke timings, and push follow-up commits until the PR is ready for maintainer review.

## Testing Plan

Run after code changes:

```sh
pnpm run format
pnpm typecheck
pnpm run test
```

Add focused tests for:

- `--all` explicit all-agents path.
- default all-agents selection.
- `ccusage codex` default daily shortcut.
- agent-first form: `codex daily`.
- unsupported `--agent` filter form.
- JSON output includes `agent`.
- unsupported capability errors, especially `codex blocks`.
- unsupported option errors, for example `daily --all --speed fast`.
- supported option filtering, for example `codex daily --speed fast`.
- latest main Codex fast pricing behavior.
- local real-data smoke tests for each configured agent data directory.
- elapsed runtime for representative commands, with outputs redirected when measuring so terminal rendering does not dominate the result.
- `pnpm --filter ccusage bench` with explicit `--offline --json` arguments for the same representative commands when comparing built CLI performance.
- wrapper packages forward args correctly.
- wrapper packages preserve existing command arguments under the agent namespace.
- local wrapper-vs-ccusage JSON equality checks for every compatibility package.
- Codex wrapper-vs-ccusage equality checks should use `--until <yesterday>` or an equivalent stable date range because current-day Codex logs can change while the comparison is running.
- large JSON pipe checks: built CLI `--offline --json | jq -e .` on both Node-forced and Bun-available paths where applicable.
- packed package size remains under the chosen budget.
- deprecated aliases emit warnings and forward correctly.
- report flag aliases are not accepted: `--daily`, `--monthly`, and `--session`.

## cmux Debug Workflow

Use cmux terminal capture for visual table regressions and long-running CLI smoke tests.

This workflow is also available as the repo-local `cmux-debug` Codex skill because it combines command injection, pane/surface targeting, terminal geometry capture, scrollback capture, and visual regression checks.

Known working commands:

```sh
cmux capabilities --json | jq '.methods | index("surface.read_text")'
cmux list-pane-surfaces --workspace "$WORKSPACE_REF" --json
cmux read-screen --workspace "$WORKSPACE_REF" --surface "$SURFACE_REF" --lines 80
cmux capture-pane --workspace "$WORKSPACE_REF" --surface "$SURFACE_REF" --scrollback --lines 120
```

Set the target workspace/surface before running commands:

```txt
WORKSPACE_REF=<workspace_ref>
WORKSPACE_ID=<workspace_id>
PANE_REF=<pane_ref>
PANE_ID=<pane_id>
SURFACE_REF=<surface_ref>
SURFACE_ID=<surface_id>
PROJECT_DIR=<project_dir>
```

To run an arbitrary command in that surface and capture the rendered terminal:

```sh
cmux send --workspace "$WORKSPACE_REF" --surface "$SURFACE_REF" "printf '\\033c'; cd \"$PROJECT_DIR\"; ./dist/cli.js --offline\n"
cmux capture-pane --workspace "$WORKSPACE_REF" --surface "$SURFACE_REF" --scrollback --lines 120
```

When testing responsive tables, capture both the command output and the terminal geometry from the same surface:

```sh
cmux send --workspace "$WORKSPACE_REF" --surface "$SURFACE_REF" "printf '\\033c'; stty size; printf 'COLUMNS=%s\n' \"\$COLUMNS\"; cd \"$PROJECT_DIR\"; ./dist/cli.js --offline\n"
cmux read-screen --workspace "$WORKSPACE_REF" --surface "$SURFACE_REF" --lines 120
```

If plain CLI output is needed for assertions, use the socket RPC method exposed by the production build:

```sh
cmux rpc surface.read_text "{\"workspace_id\":\"$WORKSPACE_ID\",\"surface_id\":\"$SURFACE_ID\",\"scrollback\":true,\"lines\":120}"
```

## Release Notes Draft

```txt
ccusage now supports multiple coding agents from one CLI.

Use `ccusage` or `ccusage daily` to see all detected agent usage, or use an agent namespace for agent-specific reports:

  ccusage codex daily
  ccusage claude monthly
  ccusage opencode session

Agent-specific reports use namespaces:

  ccusage codex daily

The old companion packages such as `@ccusage/codex` now forward to `ccusage` and will be deprecated in a future version.
```

## Decisions

- Ship as a major release.
- Do not add `--daily` / `--monthly` / `--session` aliases initially.
- Keep Amp credits and Codex reasoning tokens first-class in agent-specific reports; keep them in metadata for all-agent reports.
- Do not add all-agent config defaults for agent filters in the first implementation.
- Warn over 750 KB packed size and fail over 1 MB packed size.
