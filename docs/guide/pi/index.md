# Pi-Agent Integration

The `@ccusage/pi` package provides unified usage tracking across Claude Code and [pi-agent](https://github.com/badlogic/pi-mono), an alternative Claude coding agent from [shittycodingagent.ai](https://shittycodingagent.ai).

## What is Pi-Agent?

Pi-agent is a third-party Claude coding agent that stores usage data in a similar JSONL format to Claude Code but in a different directory structure. The `@ccusage/pi` package combines data from both sources to give you a complete view of your Claude Max usage.

## Installation & Launch

```bash
# Recommended - always include @latest
npx @ccusage/pi@latest --help
bunx @ccusage/pi@latest --help  # ⚠️ MUST include @latest with bunx

# Alternative package runners
pnpm dlx @ccusage/pi --help
pnpx @ccusage/pi --help
```

::: warning ⚠️ Critical for bunx users
Bun's bunx prioritises binaries matching the package name suffix when given a scoped package. **Always use `bunx @ccusage/pi@latest` with the version tag** to force bunx to fetch and run the correct package.
:::

### Recommended: Shell Alias

Since `npx @ccusage/pi@latest` is quite long to type repeatedly, we strongly recommend setting up a shell alias for convenience:

```bash
# bash/zsh: alias ccusage-pi='bunx @ccusage/pi@latest'
# fish:     alias ccusage-pi 'bunx @ccusage/pi@latest'

# Then simply run:
ccusage-pi daily
ccusage-pi monthly --json
```

::: tip
After adding the alias to your shell config file (`.bashrc`, `.zshrc`, or `config.fish`), restart your shell or run `source` on the config file to apply the changes.
:::

## Data Sources

The CLI combines usage data from two sources:

| Source      | Label  | Default Path                                          |
| ----------- | ------ | ----------------------------------------------------- |
| Claude Code | `[cc]` | `~/.claude/projects/` or `~/.config/claude/projects/` |
| Pi-agent    | `[pi]` | `~/.pi/agent/sessions/`                               |

Reports display data from both sources with clear labels so you can identify where each entry originated.

## Available Commands

```bash
# Show daily combined usage (Claude Code + pi-agent)
ccusage-pi daily

# Show monthly combined usage
ccusage-pi monthly

# Show session-based usage
ccusage-pi session

# JSON output for automation
ccusage-pi daily --json

# Custom pi-agent path
ccusage-pi daily --pi-path /path/to/sessions

# Filter by date range
ccusage-pi daily --since 2025-12-01 --until 2025-12-19

# Show model breakdown
ccusage-pi daily --breakdown
```

## Environment Variables

| Variable            | Description                                    |
| ------------------- | ---------------------------------------------- |
| `PI_AGENT_DIR`      | Custom path to pi-agent sessions directory     |
| `CLAUDE_CONFIG_DIR` | Custom path(s) to Claude Code data directories |
| `LOG_LEVEL`         | Adjust logging verbosity (0 silent … 5 trace)  |

## Next Steps

- [Daily report command](./daily.md)
- [Monthly report command](./monthly.md)
- [Session report command](./session.md)

## Related

- [ccusage](https://github.com/ryoppippi/ccusage) - Main usage analysis tool for Claude Code
- [pi-agent](https://github.com/badlogic/pi-mono) - Alternative Claude coding agent
