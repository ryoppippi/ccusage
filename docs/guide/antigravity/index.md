# Antigravity CLI Data Source (Beta)

> Antigravity CLI support is experimental and relies on estimating token usage from transcript character counts.

ccusage can read Antigravity CLI chat logs as one of its supported local data sources. Antigravity uses the same unified and focused report model as Claude Code, Gemini CLI, and other supported coding CLIs.

## Focused Views

```bash
# Daily Antigravity CLI usage
ccusage antigravity daily

# Monthly Antigravity CLI usage
ccusage antigravity monthly

# Antigravity CLI sessions
ccusage antigravity session
```

Most users can start with unified reports such as `ccusage daily`. Add the `antigravity` namespace only when you want to focus the same report shape on Antigravity CLI usage.

## Data Source

The CLI reads Antigravity CLI transcript files located under `ANTIGRAVITY_DATA_DIR` (defaults to `~/.gemini/antigravity-cli`). `ANTIGRAVITY_DATA_DIR` can be one directory or a comma-separated list of directories.

```bash
ANTIGRAVITY_DATA_DIR="$HOME/.gemini/antigravity-cli,/backup/antigravity" ccusage antigravity daily
```

```text
~/.gemini/antigravity-cli/
└── brain/
    └── <conversation-id>/
        └── .system_generated/
            └── logs/
                └── transcript.jsonl
```

## Report Views

| Focused view                  | Description                            | See also                                |
| ----------------------------- | -------------------------------------- | --------------------------------------- |
| `ccusage antigravity daily`   | Aggregate usage by date                | [Daily Usage](/guide/daily-reports)     |
| `ccusage antigravity monthly` | Aggregate usage by month               | [Monthly Usage](/guide/monthly-reports) |
| `ccusage antigravity session` | Group usage by Antigravity CLI session | [Session Usage](/guide/session-reports) |

These views support `--json`, `--compact`, and `--offline`.

## What Gets Calculated

- **Token usage** - Because Antigravity CLI does not record raw token counts locally, ccusage estimates input and output tokens based on character counts in `transcript.jsonl` (using an estimation of 1.5 tokens per character).
- **Reasoning tokens** - Antigravity CLI `thinking` blocks are included in total tokens and exposed as `reasoningTokens` in JSON output.
- **Pricing** - Costs are calculated from LiteLLM pricing data based on the selected Gemini model or a standard fallback (`google/gemini-1.5-flash`).

## Environment Variables

| Variable               | Description                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `ANTIGRAVITY_DATA_DIR` | Override the root directory, or comma-separated root directories, containing Antigravity data |
| `LOG_LEVEL`            | Adjust verbosity (0 silent ... 5 trace)                                                       |

## Troubleshooting

::: details No Antigravity CLI usage data found
Ensure Antigravity CLI has written transcripts under `~/.gemini/antigravity-cli/brain/`. Set `ANTIGRAVITY_DATA_DIR` if your data lives elsewhere.
:::

::: details Costs showing as $0.00
If the model cannot be mapped to the pricing database, the cost will fall back to `google/gemini-1.5-flash`. If it still shows $0.00, check your offline/online settings.
:::
