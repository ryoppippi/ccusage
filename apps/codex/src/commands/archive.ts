/**
 * @fileoverview Archive command for long-term storage of Codex usage data
 *
 * This command copies JSONL files from Codex data directories to a persistent
 * archive location, protecting them from potential cleanup.
 *
 * @module commands/archive
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline';
import { define } from 'gunshi';
import { glob } from 'tinyglobby';
import { getArchivePath, getArchivePathErrorMessage, getConfigFilePath } from '../_config.ts';
import { DEFAULT_CODEX_DIR, DEFAULT_SESSION_SUBDIR, SESSION_GLOB } from '../_consts.ts';
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
 * Get Codex session directory path
 * @returns Codex session directory path
 */
function getCodexSessionsDir(): string {
	const codexHome = process.env.CODEX_HOME ?? DEFAULT_CODEX_DIR;
	return path.join(codexHome, DEFAULT_SESSION_SUBDIR);
}

/**
 * Copy JSONL files from source to archive directory
 * Archive maintains the same structure as Codex data directory (/sessions/...)
 * @param sourceDir - Codex sessions directory
 * @param archiveDir - Archive destination directory (will contain /sessions/ subdirectory)
 * @param dryRun - If true, only simulate the operation
 * @returns Archive statistics
 */
async function copyJSONLFiles(
	sourceDir: string,
	archiveDir: string,
	dryRun: boolean,
): Promise<ArchiveStats> {
	const stats: ArchiveStats = {
		copiedFiles: 0,
		skippedFiles: 0,
		totalBytes: 0,
		errors: [],
	};

	if (!existsSync(sourceDir)) {
		logger.warn(`Sessions directory not found: ${sourceDir}`);
		return stats;
	}

	// Find all JSONL files
	const files = await glob(SESSION_GLOB, {
		cwd: sourceDir,
		absolute: true,
		onlyFiles: true,
	});

	logger.debug(`Found ${files.length} JSONL files in ${sourceDir}`);

	for (const sourceFile of files) {
		try {
			// Calculate relative path from sessions dir
			const relativePath = path.relative(sourceDir, sourceFile);
			// Archive maintains the same structure: archiveDir/sessions/...
			const archiveSessionsDir = path.join(archiveDir, DEFAULT_SESSION_SUBDIR);
			const destFile = path.join(archiveSessionsDir, relativePath);
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
async function askYesNo(question: string, defaultAnswer: boolean = true): Promise<boolean> {
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
 * Save archive path to config file
 * @param archivePath - Path to save in config
 */
function saveArchivePathToConfig(archivePath: string): void {
	const configPath = getConfigFilePath();
	const configDir = path.dirname(configPath);

	// Create config directory if needed
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Load existing config or create new one
	let config: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		try {
			const content = readFileSync(configPath, 'utf-8');
			config = JSON.parse(content) as Record<string, unknown>;
		}
		catch {
			// If config file is invalid, start fresh
		}
	}

	// Update archive path
	if (typeof config.archive !== 'object' || config.archive == null) {
		config.archive = {};
	}
	(config.archive as Record<string, unknown>).codex = archivePath;

	// Save config
	writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
	logger.info(`Saved archive path to ${configPath}`);
}

/**
 * Archive command implementation
 */
export const archiveCommand = define({
	name: 'archive',
	description: 'Archive Codex usage data for long-term storage',
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
			// Get source directory
			const sourceDir = getCodexSessionsDir();
			logger.info(`📁 Codex sessions directory: ${sourceDir}`);

			// Check if this is first-time usage (no config file and no CLI path)
			const configFilePath = getConfigFilePath();
			const isFirstTime = !existsSync(configFilePath)
				&& options.path == null
				&& process.env.CODEX_ARCHIVE_PATH == null;

			let archivePath: string;

			// Interactive setup for first-time users (unless --yes or --dry-run is used)
			if (isFirstTime && options.yes !== true && options.dryRun !== true) {
				// eslint-disable-next-line no-console
				console.log(`\n${'='.repeat(50)}`);
				// eslint-disable-next-line no-console
				console.log('Welcome to Codex archive! 🎉');
				// eslint-disable-next-line no-console
				console.log('='.repeat(50));
				// eslint-disable-next-line no-console
				console.log('\nThis tool helps you preserve Codex usage data');
				// eslint-disable-next-line no-console
				console.log('for long-term analysis and backup.');
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
					saveArchivePathToConfig(archivePath);
					// eslint-disable-next-line no-console
					console.log(`\n✓ Configuration saved to: ${configFilePath}\n`);
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
				else if (process.env.CODEX_ARCHIVE_PATH != null) {
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
			const stats = await copyJSONLFiles(sourceDir, archivePath, options.dryRun === true);

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
				console.log('   Make sure Codex has generated some usage data.');
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
