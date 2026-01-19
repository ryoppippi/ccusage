# OpenCode CLI Overview (Beta)

> The OpenCode companion CLI is experimental. Expect breaking changes while both ccusage and [OpenCode](https://github.com/sst/opencode) continue to evolve.

The `@ccusage/opencode` package reuses ccusage's responsive tables, pricing cache, and token accounting to analyze [OpenCode](https://github.com/sst/opencode) session logs. OpenCode is a terminal-based AI coding assistant that supports multiple AI providers.

## Installation & Launch

::: code-group

```bash [bunx (Recommended)]
bunx @ccusage/opencode@latest --help
```

```bash [npx]
npx @ccusage/opencode@latest --help
```

```bash [pnpm]
pnpm dlx @ccusage/opencode --help
```

```bash [opencode x]
BUN_BE_BUN=1 opencode x @ccusage/opencode@latest --help
```

:::

::: tip opencode x option
The `opencode x` option requires the native version of OpenCode. If you installed OpenCode via npm, use the `bunx` or `npx` options instead.
:::

### Recommended: Shell Alias

```bash
# bash/zsh
alias ccusage-opencode='bunx @ccusage/opencode@latest'

# fish
alias ccusage-opencode 'bunx @ccusage/opencode@latest'
```

## Data Source

The CLI reads OpenCode message and session JSON files located under `OPENCODE_DATA_DIR` (defaults to `~/.local/share/opencode`).

<!-- eslint-skip -->

```
~/.local/share/opencode/
└── storage/
    ├── message/{sessionID}/msg_{messageID}.json
    └── session/{projectHash}/{sessionID}.json
```

## Available Commands

| Command   | Description                                          | See also                                  |
| --------- | ---------------------------------------------------- | ----------------------------------------- |
| `daily`   | Aggregate usage by date (YYYY-MM-DD)                 | [Daily Reports](/guide/daily-reports)     |
| `weekly`  | Aggregate usage by ISO week (YYYY-Www)               | [Weekly Reports](/guide/weekly-reports)   |
| `monthly` | Aggregate usage by month (YYYY-MM)                   | [Monthly Reports](/guide/monthly-reports) |
| `session` | Per-session breakdown with parent/subagent hierarchy | [Session Reports](/guide/session-reports) |

All commands support `--json` for structured output and `--compact` for narrow terminals. See the linked ccusage documentation for detailed flag descriptions.

## Session Hierarchy

OpenCode supports subagent sessions. The session report displays:

- **Bold titles** for parent sessions with subagents
- **Indented rows** (`↳`) for subagent sessions
- **Subtotal rows** combining parent + subagents

## Environment Variables

| Variable            | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `OPENCODE_DATA_DIR` | Override the root directory containing OpenCode data |
| `LOG_LEVEL`         | Adjust verbosity (0 silent ... 5 trace)              |

## Cost Calculation

OpenCode stores `cost: 0` in message files. Costs are calculated from token counts using LiteLLM pricing. Model aliases (e.g., `gemini-3-pro-high` → `gemini-3-pro-preview`) are handled automatically.

## Troubleshooting

::: details No OpenCode usage data found
Ensure the data directory exists at `~/.local/share/opencode/storage/message/`. Set `OPENCODE_DATA_DIR` for custom paths.
:::

::: details Costs showing as $0.00
If a model is not in LiteLLM's database, the cost will be $0.00. [Open an issue](https://github.com/ryoppippi/ccusage/issues/new) to request alias support.
:::
