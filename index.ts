#!/usr/bin/env bun

import process from "node:process";
import { cli, define } from "gunshi";
import { dailyCommand } from "./commands/daily.ts";
import { sessionCommand } from "./commands/session.ts";
import { description, name, version } from "./package.json";

// Create subcommands map
const subCommands = new Map();
subCommands.set("daily", dailyCommand);
subCommands.set("session", sessionCommand);

// Default command shows daily report
const command = define({
	description: "Claude Code usage report tool",
	async run(ctx) {
		// Show help when no subcommand is provided
		// The CLI will automatically show available subcommands
		return;
	},
});

await cli(process.argv.slice(2), command, {
	name,
	version,
	description,
	subCommands,
});
