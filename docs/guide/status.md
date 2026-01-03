# Claude Status

Check the current operational status of Claude services directly from the command line.

## Basic Usage

```bash
ccusage status
```

## Example Output

```
Claude Status: All Systems Operational - https://status.claude.com
```

The status message is color-coded based on the current service state:

| Color  | Status      | Description                              |
| ------ | ----------- | ---------------------------------------- |
| Green  | Operational | All systems are working normally         |
| Yellow | Degraded    | Some services may be experiencing issues |
| Red    | Outage      | Partial or major service outage          |

## JSON Output

Export status data as JSON for programmatic use:

```bash
ccusage status --json
```

```json
{
	"status": {
		"description": "All Systems Operational",
		"indicator": "none"
	},
	"page": {
		"id": "...",
		"name": "Claude",
		"url": "https://status.claude.com",
		"time_zone": "Etc/UTC",
		"updated_at": "2025-01-15T12:00:00.000Z"
	}
}
```

### Status Indicators

The `indicator` field in JSON output can be:

- `none` - All systems operational
- `minor` - Minor issues or degraded performance
- `major` - Major outage affecting services
- `critical` - Critical outage

## Use Cases

### Quick Status Check

Before starting a coding session, verify Claude services are available:

```bash
ccusage status
```

### Scripting and Automation

Use JSON output in scripts to check Claude availability:

```bash
# Check if Claude is operational
if ccusage status --json | grep -q '"indicator": "none"'; then
  echo "Claude is ready!"
fi
```

### Troubleshooting

If you're experiencing issues with Claude Code, check the service status first:

```bash
ccusage status
# If not operational, visit the status page for more details
```

## Related Commands

- [Statusline Integration](/guide/statusline) - Compact usage display for Claude Code status bar
