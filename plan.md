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

The unified Codex adapter must preserve this pricing behavior.

## Product Direction

Use `ccusage` as the unified usage dashboard.

Default behavior should favor the new unified all-agents experience:

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

`-a` / `--agent` should remain available only as a unified-view filter:

```sh
ccusage daily -a codex
ccusage monthly -a claude,codex
```

This is useful for users who want the all-agents report shape but filtered to one or more agents. It should not be the primary way to access agent-specific options or agent-specific aggregation behavior.

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
- Table columns changing to include `Agent` in unified reports.
- Companion package commands becoming wrappers with deprecation warnings.

Release strategy:

1. Ship this as a major release because `ccusage` defaults to all agents immediately.
2. Keep top-level `ccusage blocks` and `ccusage statusline` as deprecated aliases for one major if possible, forwarding to `ccusage claude blocks` and `ccusage claude statusline`.
3. Keep `ccusage daily -a claude --json` as the stable migration path for scripts that need old Claude-only JSON.
4. Add release notes with explicit before/after examples.

## Bundle Size Budget

Use the `pkg.pr.new` preview from `main` as the size baseline, not local sourcemap-heavy build output.

Measured on the `main` preview packages:

| Package             |   Packed | Unpacked |
| ------------------- | -------: | -------: |
| `ccusage`           |  44.3 KB | 165.8 KB |
| `@ccusage/codex`    |  56.3 KB | 243.1 KB |
| `@ccusage/opencode` |  58.4 KB | 252.4 KB |
| `@ccusage/amp`      |  52.6 KB | 229.7 KB |
| `@ccusage/pi`       |  45.7 KB | 180.3 KB |
| Naive sum           | 257.3 KB |  1.07 MB |

The final unified `ccusage` package should be comfortably under 1 MB packed. It may approach or exceed 1 MB unpacked if we simply concatenate every current app, but packed install/download size should stay well below 1 MB because shared runtime code, terminal table code, pricing helpers, and README/license/package metadata will no longer be duplicated across packages.

Bundle-size requirements:

- Keep the packed `ccusage-*.tgz` under 1 MB.
- Warn in CI above 750 KB packed size.
- Track unpacked size as a secondary metric, but do not optimize against sourcemaps because published `files` excludes maps today.
- Keep companion wrappers tiny; they should not bundle their old implementations.
- Add a CI/package-size check using `npm pack --json` or the existing performance script.
- Prefer lazy imports for agent implementations so `ccusage --help`, `ccusage --version`, and simple Claude paths do not eagerly load every adapter.

Dependency requirements:

- Do not reintroduce `fast-sort`, `tinyglobby`, or `es-toolkit` into `ccusage`.
- Do not implement the first unified version by importing sibling app commands wholesale if that pulls their old dependency graph into `ccusage`.
- Move agent logic into `ccusage` by porting it onto the optimized `ccusage` primitives first.
- Companion packages may temporarily keep their old dependencies until they become tiny wrappers, but the final wrapper packages should depend on `ccusage` only plus package tooling.

## Optimisation Migration Requirements

The purpose of the consolidation is not just one entry point; it is to let every coding-agent report benefit from the recent `ccusage` runtime work.

Use `ccusage` as the implementation baseline:

- Replace `tinyglobby` usage in Codex, OpenCode, Amp, and pi-agent loaders with the dependency-free recursive traversal approach used by `ccusage`.
- Replace `fast-sort` and `es-toolkit` usage with native `Array.prototype.sort`, `Map`, and small local helpers from `@ccusage/internal` where needed.
- Reuse the `ccusage` file-loading strategy: parallel directory traversal, bounded concurrency, size-aware work distribution, and worker-thread parsing for large file sets where the agent data format benefits from it.
- Keep columnar worker payloads or equivalent compact transfer shapes for hot paths that return many rows.
- Keep dedupe and aggregation on native `Map`/`Set` structures and avoid object-shape churn in hot loops.
- Preserve the existing optimized Claude Code path and extend the same patterns to new adapters instead of regressing it into a generic slow path.

Implementation rule:

- Before wiring an agent into the unified CLI, first remove or bypass that agent's old heavy dependencies and confirm the agent can build through `ccusage` without adding them to `apps/ccusage/package.json`.

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

ccusage daily --agent codex
ccusage daily -a claude,codex
```

Do not add report-mode boolean aliases in the first implementation:

```sh
ccusage --daily
ccusage codex --daily
```

Keep report modes as commands. This avoids mutually exclusive report flags such as `--daily --monthly` and keeps `daily`, `monthly`, and `session` aligned with Gunshi subcommands.

Option semantics:

- `--all`: include all detected supported agents.
- `-a, --agent <agent>`: filter a unified report to one or more specific agents.
- no `--all` or `--agent`: include all detected supported agents.
- `--all` and `--agent` are mutually exclusive.
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

Do not support option-first subcommand syntax:

```sh
ccusage -a codex monthly
```

Gunshi treats this as the default command because the first token is an option. Keep documentation agent-first for dedicated reports and command-first for unified reports.

Subcommand map shape:

```ts
const subCommands = new Map([
	['daily', unifiedDailyCommand],
	['monthly', unifiedMonthlyCommand],
	['session', unifiedSessionCommand],
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

## Proposed Directory Layout

Keep the extension point explicit. Do not put every new agent into one large shared loader or command file.

Recommended layout:

```txt
apps/ccusage/src/
  cli.ts
  main.ts
  commands/
    index.ts
    unified/
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
      unified-table.ts
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
- top-level unified commands use `core/registry.ts` and `core/reports/*`.
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

This keeps future agents additive: create `agents/new-agent/`, register it, and add docs/tests. The unified report path should only need capability and event-shape support.

## Option Model

Do not force all existing package options into one flat common option surface.

The current CLIs differ enough that agent-first commands should own the rich option surface. The top-level unified reports should stay intentionally conservative.

Use two command families:

1. Unified reports: `ccusage daily`, `ccusage monthly`, `ccusage session`.
2. Agent-specific reports: `ccusage codex daily`, `ccusage claude daily`, `ccusage amp session`.

Use three option layers:

1. Global report options accepted for every agent.
2. Unified-view filter options accepted by top-level reports.
3. Agent-specific options accepted only under that agent namespace.

Recommended always-global options:

- `-j, --json`
- `-s, --since`
- `-u, --until`
- `-z, --timezone`
- `--compact`
- `--color`
- `--no-color`

Recommended unified-view-only options:

- `-a, --agent <agent>`
- `--all`

Current known agent-specific or limited options:

| Option            | Owner         | Notes                                                                                                                         |
| ----------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| `--mode auto      | calculate     | display`                                                                                                                      | Claude | Claude JSONL can contain precomputed `costUSD`; other agents generally calculate from tokens. |
| `--debug`         | Claude        | Pricing mismatch/debug output for Claude cost mode behavior.                                                                  |
| `--debug-samples` | Claude        | Supports Claude debug output.                                                                                                 |
| `--single-thread` | Claude        | Controls Claude JSONL worker loading.                                                                                         |
| `--config`        | Claude        | Current config loader is Claude-oriented and should not silently apply to all agents without a schema update.                 |
| `--breakdown`     | Claude, pi    | Other agents may support model display differently; make this capability-driven.                                              |
| `--offline`       | Claude, Codex | Both support cached pricing, but the cache/provider set differs. Can become common only if each selected agent implements it. |
| `--speed auto     | standard      | fast`                                                                                                                         | Codex  | Added on main; `auto` reads Codex `config.toml` service tier.                                 |
| `--pi-path`       | pi            | pi-agent session directory override. Prefer a normalized `--data-dir` later only if it can be made unambiguous.               |

Current report-shape differences:

| Agent    | Difference                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Claude   | Has `blocks`, `statusline`, config merging, precomputed cost modes, project/instance grouping, and session ID lookup. |
| Codex    | Tracks reasoning output tokens and fast/standard pricing tier.                                                        |
| OpenCode | Has weekly reports today and reads both SQLite and file-backed data.                                                  |
| Amp      | Tracks credits as a first-class metric and groups sessions by thread.                                                 |
| pi       | Has explicit `--pi-path`, descending default order, and project-path-oriented sessions.                               |

Unified report policy:

- Include only metrics that have comparable meaning across selected agents in the main table.
- Keep agent-specific metrics in JSON `metadata` for unified reports.
- Show Amp credits as a first-class column only in `ccusage amp ...` reports.
- Show Codex reasoning tokens as a first-class column only in `ccusage codex ...` reports unless a later unified schema promotes reasoning tokens across agents.

Validation rules:

- If an agent namespace is selected, allow that agent's specific options.
- If a top-level unified report is selected, reject agent-specific options unless the option is explicitly promoted to the unified report contract.
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
- Compose top-level unified commands from common args only.
- Compose agent-specific commands from common args plus that agent's args.
- After parsing, validate the selected agent set against the provided option names.
- Track explicitly provided options from Gunshi tokens so defaults do not trigger false validation failures.

## Report Display

Unified reports should include an agent column by default.

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

Convert each package into a thin wrapper that depends on `ccusage` and forwards to the unified CLI with the matching agent.

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

Update the main `ccusage` README and docs site around the unified entry point.

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
- Add `-a, --agent` and `--all` to top-level unified report args.
- Validate `--all` and `--agent` conflicts.
- Keep `ccusage`, `ccusage daily`, and `ccusage --all` on the unified all-agents path.
- Keep `ccusage <agent>` as that agent's default daily report.
- Add an `argv` normalization step that maps `ccusage <agent> <report>` to flat Gunshi commands like `<agent>:<report>`.
- Do not add `--daily`, `--monthly`, or `--session` report flag aliases in this implementation.
- Split top-level common options from agent-specific options.
- Add validation for unsupported agent-specific options.
- Keep deprecated top-level Claude aliases where practical: `blocks` and `statusline`.

### Phase 2: Adapter migration

- Create `core/` and `agents/` directories before moving logic so the migration does not collapse into one large command module.
- Extract dependency-free traversal, grouping, and bounded-concurrency helpers from the optimized Claude path into reusable `core/` or `@ccusage/internal` modules.
- Move Codex loader logic into `ccusage` after replacing `tinyglobby` and `fast-sort` usage with optimized shared/native helpers.
- Preserve Codex `--speed auto|standard|fast` behavior and `config.toml` service tier detection.
- Move OpenCode loader logic into `ccusage` after replacing `tinyglobby` and `es-toolkit` grouping with optimized shared/native helpers.
- Move Amp loader logic into `ccusage` after replacing `tinyglobby` with optimized shared traversal.
- Move pi-agent loader logic into `ccusage` after replacing `tinyglobby` with optimized shared traversal.
- Add worker-thread parsing only where profiling or data shape shows it is beneficial; keep small-file paths lightweight.
- Normalize all outputs to `UsageEvent[]`.
- Preserve current tests while adding adapter-level tests.

### Phase 3: Shared aggregation and output

- Build shared daily, weekly, monthly, and session aggregation over `UsageEvent[]`.
- Add agent column to table output.
- Ensure compact mode still works.
- Ensure `--json` includes `agent`.
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

## Testing Plan

Run after code changes:

```sh
pnpm run format
pnpm typecheck
pnpm run test
```

Add focused tests for:

- `--all` vs `--agent` conflict.
- default all-agents selection.
- `ccusage codex` default daily shortcut.
- agent-first form: `codex daily`.
- top-level filter form: `daily -a codex`.
- JSON output includes `agent`.
- unsupported capability errors, especially `codex blocks`.
- unsupported option errors, for example `daily --all --speed fast`.
- supported option filtering, for example `codex daily --speed fast`.
- latest main Codex fast pricing behavior.
- wrapper packages forward args correctly.
- wrapper packages preserve existing command arguments under the agent namespace.
- packed package size remains under the chosen budget.
- deprecated aliases emit warnings and forward correctly.
- report flag aliases are not accepted: `--daily`, `--monthly`, and `--session`.

## Release Notes Draft

```txt
ccusage now supports multiple coding agents from one CLI.

Use `ccusage` or `ccusage daily` to see all detected agent usage, or use an agent namespace for agent-specific reports:

  ccusage codex daily
  ccusage claude monthly
  ccusage opencode session

Top-level unified reports can still be filtered:

  ccusage daily -a codex

The old companion packages such as `@ccusage/codex` now forward to `ccusage` and will be deprecated in a future version.
```

## Decisions

- Ship as a major release.
- Do not add `--daily` / `--monthly` / `--session` aliases initially.
- Keep Amp credits and Codex reasoning tokens first-class in agent-specific reports; keep them in metadata for unified reports.
- Do not add unified config defaults for agent filters in the first implementation.
- Warn over 750 KB packed size and fail over 1 MB packed size.
