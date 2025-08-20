#!/usr/bin/env -S bun

/**
 * Post-processing script to update API index with module descriptions
 */

import { join } from 'node:path';
import process from 'node:process';
import { $ } from 'bun';

const descriptions = {
	'\\_consts': 'Internal constants (not exported in public API)',
	'calculate-cost': 'Cost calculation utilities for usage data analysis',
	'data-loader': 'Data loading utilities for Claude Code usage analysis',
	'debug': 'Debug utilities for cost calculation validation',
	'index': 'Main entry point for ccusage CLI tool',
	'logger': 'Logging utilities for the ccusage application',
	'mcp': 'MCP (Model Context Protocol) server implementation',
	'pricing-fetcher': 'Model pricing data fetcher for cost calculations',
} as const;

async function updateApiIndex() {
	const apiIndexPath = join(process.cwd(), 'api', 'index.md');

	try {
		let content = await Bun.file(apiIndexPath).text();

		// Replace empty descriptions with actual ones
		for (const [module, description] of Object.entries(descriptions)) {
			let linkPath = `${module}/index.md`;
			// Special case for _consts which links to consts/
			if (module === '\\_consts') {
				linkPath = 'consts/index.md';
			}

			const oldPattern = new RegExp(`\\|\\s*\\[${module}\\]\\(${linkPath}\\)\\s*\\|\\s*-\\s*\\|`, 'g');
			content = content.replace(oldPattern, `| [${module}](${linkPath}) | ${description} |`);
		}

		await Bun.write(apiIndexPath, content);
		console.log('✅ Updated API index with module descriptions');
	}
	catch (error) {
		console.error('❌ Failed to update API index:', error);
		process.exit(1);
	}
}

async function updateConstsPage() {
	const constsIndexPath = join(process.cwd(), 'api', 'consts', 'index.md');

	try {
		let content = await Bun.file(constsIndexPath).text();

		// Add note about constants not being exported (only if not already present)
		const noteText = '> **Note**: These constants are internal implementation details and are not exported in the public API. They are documented here for reference purposes only.';

		if (!content.includes(noteText)) {
			const oldHeader = '# \\_consts';
			const newHeader = `# \\_consts

${noteText}`;

			content = content.replace(oldHeader, newHeader);
		}

		await Bun.write(constsIndexPath, content);
		console.log('✅ Updated constants page with disclaimer');
	}
	catch (error) {
		console.error('❌ Failed to update constants page:', error);
		// Don't exit here as this is optional
	}
}

async function main() {
	await $`bun typedoc --excludeInternal`
	await updateApiIndex();
	await updateConstsPage();
}

await main();
