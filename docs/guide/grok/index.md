# Grok Build Data Source (Experimental)

> Grok Build support is experimental. Expect breaking changes while both ccusage and Grok Build continue to evolve.

ccusage can read Grok Build session state as one of its supported local data sources, using the same focused and all-source report views as the rest of ccusage.

## Focused Views

::: code-group

```bash [bunx (Recommended)]
bunx ccusage grok --help
```

```bash [npx]
npx ccusage@latest grok --help
```

```bash [pnpm]
pnpm dlx ccusage grok --help
```

:::

## Data Source

The CLI reads Grok Build session files from `GROK_HOME` (defaults to `~/.grok`). `GROK_HOME` can be one directory or a comma-separated list of directories.

```bash
GROK_HOME="$HOME/.grok,/backup/grok" ccusage grok daily
```

```text
~/.grok/
└── sessions/
    └── <encoded-cwd>/
        └── <session-id>/
            ├── signals.json
            └── summary.json
```

## Report Views

| Focused view           | Description                       | See also                                |
| ---------------------- | --------------------------------- | --------------------------------------- |
| `ccusage grok daily`   | Aggregate usage by date           | [Daily Usage](/guide/daily-reports)     |
| `ccusage grok monthly` | Aggregate usage by month          | [Monthly Usage](/guide/monthly-reports) |
| `ccusage grok session` | Group usage by Grok Build session | [Session Usage](/guide/session-reports) |

These views support `--json`, `--compact`, `--breakdown`, and standard date filters.

## What Gets Calculated

- **Total tokens** - `contextTokensUsed` plus `totalTokensBeforeCompaction` from `signals.json` is reported as `totalTokens`.
- **Model attribution** - `primaryModelId`, `current_model_id`, or the first `modelsUsed` value is shown as the model name.
- **Session metadata** - `summary.json` supplies timestamps, session IDs, and project paths when available.
- **Cost** - Grok Build session state does not currently expose per-request input/output/cache token counts or recorded USD cost, so cost is reported as `$0.00`.

## Environment Variables

| Variable    | Description                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------- |
| `GROK_HOME` | Override the root directory, or comma-separated root directories, containing Grok Build data |
| `LOG_LEVEL` | Adjust verbosity (0 silent ... 5 trace)                                                      |

## Troubleshooting

::: details No Grok Build usage data found
Ensure the data directory exists at `~/.grok/sessions/` and contains session directories with `signals.json` files. Set `GROK_HOME` if your Grok Build data lives elsewhere or in multiple archive roots.
:::

::: details Costs showing as $0.00
This is expected for Grok Build rows today. ccusage reports the persisted context token totals, but Grok Build does not yet persist a stable per-request token breakdown or recorded USD cost that ccusage can price.
:::
