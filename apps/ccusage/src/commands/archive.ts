/**
 * @fileoverview Archive command for long-term storage of Claude usage data
 *
 * This command copies JSONL files from Claude data directories to a persistent
 * archive location, protecting them from Claude Code's automatic cleanup.
 *
 * @module commands/archive
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline';
import { define } from 'gunshi';
import { glob } from 'tinyglobby';
import { getArchivePath, getArchivePathErrorMessage, getConfigFilePath, isAutoArchiveEnabled, isFirstTimeAutoArchiveSetup, saveConfig } from '../_config.ts';
import { CLAUDE_PROJECTS_DIR_NAME, USAGE_DATA_GLOB_PATTERN } from '../_consts.ts';
import { getClaudePaths } from '../data-loader.ts';
import { logger } from '../logger.ts';

/**
 * Archive statistics for reporting
 */
type ArchiveStats = {
	copiedFiles: number;
	skippedFiles: number;
	totalBytes: number;
	errors: Array<{ file: string; error: string }>;
};

/**
 * Copy JSONL files from source to archive directory
 * Archive maintains the same structure as Claude data directory (/projects/...)
 * @param sourceDirs - Claude data directories
 * @param archiveDir - Archive destination directory (will contain /projects/ subdirectory)
 * @param dryRun - If true, only simulate the operation
 * @returns Archive statistics
 */
export async function copyJSONLFiles(
	sourceDirs: string[],
	archiveDir: string,
	dryRun: boolean,
): Promise<ArchiveStats> {
	const stats: ArchiveStats = {
		copiedFiles: 0,
		skippedFiles: 0,
		totalBytes: 0,
		errors: [],
	};

	for (const sourceDir of sourceDirs) {
		const projectsDir = path.join(sourceDir, CLAUDE_PROJECTS_DIR_NAME);

		if (!existsSync(projectsDir)) {
			logger.warn(`Projects directory not found: ${projectsDir}`);
			continue;
		}

		// Find all JSONL files
		const files = await glob(USAGE_DATA_GLOB_PATTERN, {
			cwd: projectsDir,
			absolute: true,
			onlyFiles: true,
		});

		logger.debug(`Found ${files.length} JSONL files in ${projectsDir}`);

		for (const sourceFile of files) {
			try {
				// Calculate relative path from projects dir
				const relativePath = path.relative(projectsDir, sourceFile);
				// Archive maintains the same structure: archiveDir/projects/project/session.jsonl
				const archiveProjectsDir = path.join(archiveDir, CLAUDE_PROJECTS_DIR_NAME);
				const destFile = path.join(archiveProjectsDir, relativePath);
				const destDir = path.dirname(destFile);

				// Check if file already exists
				if (existsSync(destFile)) {
					logger.debug(`Skipping existing file: ${relativePath}`);
					stats.skippedFiles++;
					continue;
				}

				// Get file size
				const fileStats = statSync(sourceFile);
				stats.totalBytes += fileStats.size;

				if (dryRun) {
					logger.info(`[DRY RUN] Would copy: ${relativePath}`);
					stats.copiedFiles++;
					continue;
				}

				// Create destination directory if needed
				if (!existsSync(destDir)) {
					mkdirSync(destDir, { recursive: true });
				}

				// Copy file
				copyFileSync(sourceFile, destFile);
				logger.debug(`Copied: ${relativePath}`);
				stats.copiedFiles++;
			}
			catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.error(`Failed to copy ${sourceFile}: ${errorMsg}`);
				stats.errors.push({
					file: sourceFile,
					error: errorMsg,
				});
			}
		}
	}

	return stats;
}

/**
 * Format bytes to human-readable string
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "1.5 MB")
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) {
		return '0 B';
	}
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

/**
 * Ask user for confirmation with yes/no prompt
 * @param question - Question to ask
 * @param defaultAnswer - Default answer (true = yes, false = no)
 * @returns Promise resolving to user's answer
 */
export async function askYesNo(question: string, defaultAnswer: boolean = true): Promise<boolean> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const defaultText = defaultAnswer ? '[Y/n]' : '[y/N]';
	const answer = await new Promise<string>((resolve) => {
		rl.question(`${question} ${defaultText}: `, resolve);
	});
	rl.close();

	if (answer.trim() === '') {
		return defaultAnswer;
	}

	return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

/**
 * Ask user for custom archive path
 * @param defaultPath - Default path to suggest
 * @returns Promise resolving to user's chosen path
 */
async function askArchivePath(defaultPath: string): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const answer = await new Promise<string>((resolve) => {
		rl.question(`Archive path [${defaultPath}]: `, resolve);
	});
	rl.close();

	return answer.trim() === '' ? defaultPath : answer.trim();
}

/**
 * Run auto-archive if enabled in config or CLI
 * This function silently archives data in the background without user interaction
 * Used by report commands (daily, monthly, session, blocks, weekly)
 * @param cliOption - Auto-archive setting from CLI (undefined = not specified)
 * @param customArchivePath - Custom archive path from CLI (undefined = use default)
 * @param useJson - Whether JSON output mode is enabled (skips interactive prompts)
 */
export async function runAutoArchiveIfEnabled(cliOption?: boolean, customArchivePath?: string, useJson = false): Promise<void> {
	// First-time setup: ask user if they want to enable auto-archive
	if (cliOption == null && isFirstTimeAutoArchiveSetup() && !useJson) {
		// eslint-disable-next-line no-console
		console.log('\n💡 Tip: You can automatically archive usage data before generating reports.');
		// eslint-disable-next-line no-console
		console.log('   This helps preserve your data beyond Claude Code\'s automatic cleanup.\n');

		const enableAutoArchive = await askYesNo(
			'Would you like to enable automatic archiving for future reports?',
			false,
		);

		// Save user's choice to config
		saveConfig({ autoArchive: enableAutoArchive });

		if (enableAutoArchive) {
			// eslint-disable-next-line no-console
			console.log(`\n✓ Auto-archive enabled and saved to: ${getConfigFilePath()}`);
			// eslint-disable-next-line no-console
			console.log('💡 You can disable it anytime with --no-auto-archive or by editing the config file.\n');
		}
		else {
			// eslint-disable-next-line no-console
			console.log('\n✓ Auto-archive disabled. You can enable it later with --auto-archive\n');
			return; // Don't run archive if user chose not to enable it
		}
	}

	// Check if auto-archive is enabled
	if (!isAutoArchiveEnabled(cliOption)) {
		logger.debug('Auto-archive is disabled');
		return;
	}

	logger.debug('Auto-archive is enabled, starting...');

	try {
		// Get source directories
		const sourceDirs = getClaudePaths();
		if (sourceDirs.length === 0) {
			logger.debug('No Claude data directories found for auto-archive');
			return;
		}

		// Get archive path
		const archivePath = getArchivePath(customArchivePath);
		logger.debug(`Auto-archiving to: ${archivePath}`);

		// Check if archive parent directory exists
		if (!existsSync(path.dirname(archivePath))) {
			logger.warn(`Auto-archive skipped: parent directory does not exist (${archivePath})`);
			return;
		}

		// Perform archive silently
		const stats = await copyJSONLFiles(sourceDirs, archivePath, false);

		// Log summary only if files were copied
		if (stats.copiedFiles > 0) {
			logger.info(`📦 Auto-archived ${stats.copiedFiles} file${stats.copiedFiles === 1 ? '' : 's'} to ${archivePath}`);
		}
		else {
			logger.debug('Auto-archive: no new files to archive');
		}

		// Log errors if any
		if (stats.errors.length > 0) {
			logger.warn(`Auto-archive encountered ${stats.errors.length} error${stats.errors.length === 1 ? '' : 's'}`);
			for (const err of stats.errors) {
				logger.debug(`  ${err.file}: ${err.error}`);
			}
		}
	}
	catch (error) {
		// Don't fail the main command if auto-archive fails
		const errorMsg = error instanceof Error ? error.message : String(error);
		logger.warn(`Auto-archive failed: ${errorMsg}`);
		logger.debug('Continuing with report command...');
	}
}

/**
 * Archive command implementation
 */
export const archiveCommand = define({
	name: 'archive',
	description: 'Archive Claude usage data for long-term storage',
	args: {
		path: {
			type: 'string',
			description: 'Custom archive path (overrides config and env)',
		},
		dryRun: {
			type: 'boolean',
			description: 'Show what would be archived without copying files',
			default: false,
		},
		yes: {
			type: 'boolean',
			description: 'Skip interactive confirmation (use default path)',
			default: false,
		},
	},
	toKebab: true,
	async run(ctx) {
		const options = ctx.values;
		try {
			// Get source directories
			const sourceDirs = getClaudePaths();
			logger.info(`📁 Found ${sourceDirs.length} Claude data director${sourceDirs.length === 1 ? 'y' : 'ies'}`);

			// Check if this is first-time usage (no config file and no CLI path)
			const configFilePath = getConfigFilePath();
			const isFirstTime = !existsSync(configFilePath)
				&& options.path == null
				&& process.env.CCUSAGE_ARCHIVE_PATH == null;

			let archivePath: string;

			// Interactive setup for first-time users (unless --yes or --dry-run is used)
			if (isFirstTime && options.yes !== true && options.dryRun !== true) {
				// eslint-disable-next-line no-console
				console.log(`\n${'='.repeat(50)}`);
				// eslint-disable-next-line no-console
				console.log('Welcome to ccusage archive! 🎉');
				// eslint-disable-next-line no-console
				console.log('='.repeat(50));
				// eslint-disable-next-line no-console
				console.log('\nThis tool helps you preserve Claude Code usage data beyond');
				// eslint-disable-next-line no-console
				console.log('Claude Code\'s automatic cleanup period.');
				// eslint-disable-next-line no-console
				console.log('\n💡 Tip: You can adjust Claude Code\'s retention by setting');
				// eslint-disable-next-line no-console
				console.log('   "cleanupPeriodDays" in ~/.claude/settings.json');
				// eslint-disable-next-line no-console
				console.log('   However, archiving provides permanent backup regardless.');
				// eslint-disable-next-line no-console
				console.log('\nLet\'s set up your archive location...\n');

				// Get default path
				const defaultPath = getArchivePath();

				// Ask if user wants to customize the path
				const useCustomPath = await askYesNo(
					`Use default archive path (${defaultPath})?`,
					true,
				);

				if (!useCustomPath) {
					archivePath = await askArchivePath(defaultPath);
				}
				else {
					archivePath = defaultPath;
				}

				// Ask if user wants to save to config
				const saveToConfig = await askYesNo(
					'Save this path to config file for future use?',
					true,
				);

				if (saveToConfig) {
					// Also ask about enabling auto-archive
					// eslint-disable-next-line no-console
					console.log('\n💡 Tip: You can automatically archive data before generating reports.');
					const enableAutoArchive = await askYesNo(
						'Enable automatic archiving for future reports?',
						true,
					);

					// Save both archive path and auto-archive setting together
					saveConfig({
						archivePath,
						autoArchive: enableAutoArchive,
					});

					// eslint-disable-next-line no-console
					console.log(`\n✓ Configuration saved to: ${configFilePath}`);
					if (enableAutoArchive) {
						// eslint-disable-next-line no-console
						console.log('✓ Auto-archive enabled for future reports');
					}
					// eslint-disable-next-line no-console
					console.log('');
				}
				else {
					// eslint-disable-next-line no-console
					console.log('\n💡 Tip: Use --path option to specify archive path next time\n');
				}
			}
			else {
				// Get archive path from existing configuration
				archivePath = getArchivePath(options.path);
			}

			logger.info(`📦 Archive path: ${archivePath}`);

			// Check if archive path is writable (only for non-dry-run)
			if (options.dryRun !== true && !existsSync(path.dirname(archivePath))) {
				throw new Error(getArchivePathErrorMessage(
					archivePath,
					'Parent directory does not exist',
				));
			}

			// Show configuration source (only for non-first-time users)
			if (!isFirstTime) {
				if (options.path != null) {
					logger.info('   (from CLI option)');
				}
				else if (process.env.CCUSAGE_ARCHIVE_PATH != null) {
					logger.info('   (from environment variable)');
				}
				else if (existsSync(configFilePath)) {
					logger.info('   (from config file)');
				}
				else {
					logger.info('   (default)');
				}
			}

			if (options.dryRun === true) {
				logger.info('\n🔍 DRY RUN MODE - No files will be copied\n');
			}

			// Perform archive
			logger.info('Starting archive...\n');
			const stats = await copyJSONLFiles(sourceDirs, archivePath, options.dryRun === true);

			// Report results
			// eslint-disable-next-line no-console
			console.log(`\n${'─'.repeat(50)}`);
			// eslint-disable-next-line no-console
			console.log('Archive Summary:');
			// eslint-disable-next-line no-console
			console.log('─'.repeat(50));
			// eslint-disable-next-line no-console
			console.log(`✓ Copied:  ${stats.copiedFiles} file${stats.copiedFiles === 1 ? '' : 's'}`);
			// eslint-disable-next-line no-console
			console.log(`- Skipped: ${stats.skippedFiles} file${stats.skippedFiles === 1 ? '' : 's'} (already exists)`);
			if (stats.totalBytes > 0) {
				// eslint-disable-next-line no-console
				console.log(`📊 Size:    ${formatBytes(stats.totalBytes)}`);
			}

			if (stats.errors.length > 0) {
				// eslint-disable-next-line no-console
				console.log(`\n⚠️  Errors: ${stats.errors.length}`);
				for (const err of stats.errors) {
					// eslint-disable-next-line no-console
					console.log(`   ${err.file}: ${err.error}`);
				}
			}

			if (stats.copiedFiles === 0 && stats.skippedFiles === 0) {
				// eslint-disable-next-line no-console
				console.log('\n⚠️  No files found to archive');
				// eslint-disable-next-line no-console
				console.log('   Make sure Claude Code has generated some usage data.');
			}
			else if (options.dryRun === true) {
				// eslint-disable-next-line no-console
				console.log(`\n💡 Run without --dry-run to actually copy files`);
			}
			else if (stats.copiedFiles > 0) {
				// eslint-disable-next-line no-console
				console.log(`\n✨ Successfully archived to: ${archivePath}`);
			}
			else {
				// eslint-disable-next-line no-console
				console.log(`\n✓ All files already archived`);
			}

			// eslint-disable-next-line no-console
			console.log(`${'─'.repeat(50)}\n`);
		}
		catch (error) {
			if (error instanceof Error) {
				logger.error(`Archive failed: ${error.message}`);
			}
			else {
				logger.error(`Archive failed: ${String(error)}`);
			}
			process.exit(1);
		}
	},
});
