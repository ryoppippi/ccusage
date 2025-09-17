#!/usr/bin/env node

/**
 * Post-processing script to update API index with module descriptions
 */

import { join } from 'node:path';
import process from 'node:process';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';

const descriptions = {
	// ccusage package
	'\\_consts': 'Internal constants (not exported in public API)',
	'calculate-cost': 'Cost calculation utilities for usage data analysis',
	'data-loader': 'Data loading utilities for Claude Code usage analysis',
	'debug': 'Debug utilities for cost calculation validation',
	'index': 'Main entry point for ccusage CLI tool',
	'logger': 'Logging utilities for the ccusage application',
	'pricing-fetcher': 'Model pricing data fetcher for cost calculations',
	// @ccusage/core package
	'core': 'Shared table utilities for formatting usage data',
} as const;

async function updateApiIndex() {
	const ccusageApiIndexPath = join(process.cwd(), 'api', 'ccusage', 'index.md');

	try {
		let content = await fs.readFile(ccusageApiIndexPath, 'utf8');

		// Replace empty descriptions with actual ones (excluding core)
		for (const [module, description] of Object.entries(descriptions)) {
			if (module === 'core') continue; // Skip core as it's in a separate package

			let linkPath = `${module}/index.md`;
			// Special case for _consts which links to consts/
			if (module === '\\_consts') {
				linkPath = 'consts/index.md';
			}

			const oldPattern = new RegExp(`\\|\\s*\\[${module}\\]\\(${linkPath}\\)\\s*\\|\\s*-\\s*\\|`, 'g');
			content = content.replace(oldPattern, `| [${module}](${linkPath}) | ${description} |`);
		}

		await fs.writeFile(ccusageApiIndexPath, content, 'utf8');
		console.log('✅ Updated ccusage API index with module descriptions');
	}
	catch (error) {
		console.error('❌ Failed to update ccusage API index:', error);
		process.exit(1);
	}
}

async function updateConstsPage() {
	const constsIndexPath = join(process.cwd(), 'api', 'ccusage', 'consts', 'index.md');

	try {
		let content = await fs.readFile(constsIndexPath, 'utf8');

		// Add note about constants not being exported (only if not already present)
		const noteText = '> **Note**: These constants are internal implementation details and are not exported in the public API. They are documented here for reference purposes only.';

		if (!content.includes(noteText)) {
			const oldHeader = '# \\_consts';
			const newHeader = `# \\_consts

${noteText}`;

			content = content.replace(oldHeader, newHeader);
		}

		await fs.writeFile(constsIndexPath, content, 'utf8');
		console.log('✅ Updated constants page with disclaimer');
	}
	catch (error) {
		console.error('❌ Failed to update constants page:', error);
		// Don't exit here as this is optional
	}
}

async function generateCoreApiDocs() {
	const { execFile } = await import('node:child_process');
	const execFileAsync = promisify(execFile);
	await execFileAsync('pnpm', ['typedoc', '--options', './typedoc.core.config.mjs']);
}

async function mergeCoreApiDocs() {
	// Core docs are now generated directly to api/core/, no copying needed
	const coreApiPath = join(process.cwd(), 'api', 'core');

	try {
		// Check if core API docs were generated
		const coreIndexPath = join(coreApiPath, 'index.md');
		const coreExists = await fs.access(coreIndexPath).then(() => true).catch(() => false);

		if (coreExists) {
			console.log('✅ Core API documentation generated successfully');
		}
	} catch (error) {
		console.error('❌ Failed to generate core API docs:', error);
	}
}

async function createOverallOverview() {
	const overviewPath = join(process.cwd(), 'api', 'index.md');

	const overviewContent = `# ccusage Monorepo API Reference

This documentation covers the API for the ccusage project, which consists of multiple packages:

## Packages

| Package | Description |
| ------ | ------ |
| [ccusage](ccusage/index.md) | Main CLI tool and library for Claude Code usage analysis |
| [@ccusage/core](core/index.md) | Shared table utilities for formatting usage data |

## Quick Links

### ccusage Package
The main package providing CLI functionality and core analysis features.

### @ccusage/core Package
Shared utilities for creating responsive tables and formatting usage data across the ccusage ecosystem.
`;

	try {
		await fs.writeFile(overviewPath, overviewContent, 'utf8');
		console.log('✅ Created overall API overview');
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('❌ Failed to create overall overview:', message);
	}
}

async function main() {
	const { execFile } = await import('node:child_process');
	const execFileAsync = promisify(execFile);

	// Generate ccusage API docs
	await execFileAsync('pnpm', ['typedoc', '--excludeInternal']);

	// Try to generate core API docs (skip if fails)
	try {
		await generateCoreApiDocs();
		await mergeCoreApiDocs();
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn('⚠️ Failed to generate core API docs, skipping:', message);
	}

	// Create overall API overview
	await createOverallOverview();

	// Update individual package documentation
	await updateApiIndex();
	await updateConstsPage();
}

await main();
