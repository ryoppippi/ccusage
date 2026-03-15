import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import nanoSpawn from 'nano-spawn';
import pc from 'picocolors';
import { DEFAULT_CLAUDE_CODE_PATH, DEFAULT_CLAUDE_CONFIG_PATH, USER_HOME_DIR } from '../_consts.ts';
import { log } from '../logger.ts';

const runnerChoices = ['auto', 'bun', 'npx'] as const;
const visualBurnRateChoices = ['off', 'emoji', 'text', 'emoji-text'] as const;
const costSourceChoices = ['auto', 'ccusage', 'cc', 'both'] as const;
const promotionDisplayChoices = ['auto', 'active-only', 'off'] as const;

/**
 * Detects whether bun is available on the system
 */
async function detectBun(): Promise<boolean> {
	return Result.pipe(
		await Result.try({
			try: async () => {
				await nanoSpawn('bun', ['--version']);
				return true;
			},
			catch: () => false,
		})(),
		Result.unwrap(false),
	);
}

/**
 * Finds the Claude Code settings.json path
 * Prefers XDG config path, falls back to legacy path
 */
function findSettingsPath(): { settingsPath: string; isXdg: boolean } {
	const xdgSettingsPath = path.join(DEFAULT_CLAUDE_CONFIG_PATH, 'settings.json');
	const legacySettingsPath = path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH, 'settings.json');

	// Prefer XDG path if it exists, otherwise check legacy
	if (existsSync(xdgSettingsPath)) {
		return { settingsPath: xdgSettingsPath, isXdg: true };
	}
	if (existsSync(legacySettingsPath)) {
		return { settingsPath: legacySettingsPath, isXdg: false };
	}

	// Default to XDG path for new installations
	return { settingsPath: xdgSettingsPath, isXdg: true };
}

/**
 * Builds the statusline command string from options
 */
function buildCommand(
	runner: string,
	options: {
		visualBurnRate: string;
		showPromotions: boolean;
		promotionDisplay: string;
		costSource: string;
		showSessionDuration: boolean;
		showLinesChanged: boolean;
	},
): string {
	const prefix = runner === 'bun' ? 'bun x' : 'npx -y';
	const parts = [`${prefix} ccusage statusline`];

	if (options.visualBurnRate !== 'off') {
		parts.push(`--visual-burn-rate ${options.visualBurnRate}`);
	}

	if (!options.showPromotions) {
		parts.push('--no-show-promotions');
	}

	if (options.promotionDisplay !== 'auto') {
		parts.push(`--promotion-display ${options.promotionDisplay}`);
	}

	if (options.costSource !== 'auto') {
		parts.push(`--cost-source ${options.costSource}`);
	}

	if (!options.showSessionDuration) {
		parts.push('--no-show-session-duration');
	}

	if (!options.showLinesChanged) {
		parts.push('--no-show-lines-changed');
	}

	return parts.join(' ');
}

export const setupStatuslineCommand = define({
	name: 'setup-statusline',
	description: 'Auto-configure Claude Code statusline integration',
	toKebab: true,
	args: {
		runner: {
			type: 'enum',
			choices: runnerChoices,
			description: 'Package runner: auto (detect bun), bun, or npx',
			default: 'auto',
			negatable: false,
		},
		force: {
			type: 'boolean',
			short: 'f',
			description: 'Overwrite existing statusLine configuration',
			default: false,
		},
		dryRun: {
			type: 'boolean',
			description: 'Show what would be written without making changes',
			default: false,
			toKebab: true,
		},
		visualBurnRate: {
			type: 'enum',
			choices: visualBurnRateChoices,
			description: 'Burn rate visualization style',
			default: 'off',
			negatable: false,
			toKebab: true,
		},
		showPromotions: {
			type: 'boolean',
			description: 'Enable promotion display in statusline (default: true)',
			negatable: true,
			default: true,
			toKebab: true,
		},
		costSource: {
			type: 'enum',
			choices: costSourceChoices,
			description: 'Session cost source: auto, ccusage, cc, or both',
			default: 'auto',
			negatable: false,
			toKebab: true,
		},
		promotionDisplay: {
			type: 'enum',
			choices: promotionDisplayChoices,
			description: 'Promotion display: auto (with countdown), active-only (off-peak only), off',
			default: 'auto',
			negatable: false,
			toKebab: true,
		},
		showSessionDuration: {
			type: 'boolean',
			description: 'Show session duration in statusline (default: true)',
			negatable: true,
			default: true,
			toKebab: true,
		},
		showLinesChanged: {
			type: 'boolean',
			description: 'Show lines added/removed in statusline (default: true)',
			negatable: true,
			default: true,
			toKebab: true,
		},
	},
	async run(ctx) {
		// Detect runner
		const resolvedRunner = await (async (): Promise<'bun' | 'npx'> => {
			if (ctx.values.runner === 'bun') {
				return 'bun';
			}
			if (ctx.values.runner === 'npx') {
				return 'npx';
			}
			// auto detection
			const hasBun = await detectBun();
			return hasBun ? 'bun' : 'npx';
		})();

		log(`${pc.dim('Runner:')} ${pc.bold(resolvedRunner)}`);

		// Find settings path
		const { settingsPath } = findSettingsPath();
		log(`${pc.dim('Settings:')} ${settingsPath}`);

		// Read existing settings
		const existingSettings: Record<string, unknown> = existsSync(settingsPath)
			? (JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>)
			: {};

		// Check if statusLine already exists
		if ('statusLine' in existingSettings && !ctx.values.force) {
			log(`\n${pc.yellow('⚠')} statusLine is already configured in ${settingsPath}`);
			log(`  Use ${pc.bold('--force')} to overwrite the existing configuration.`);
			return;
		}

		// Build command
		const command = buildCommand(resolvedRunner, {
			visualBurnRate: ctx.values.visualBurnRate,
			showPromotions: ctx.values.showPromotions,
			promotionDisplay: ctx.values.promotionDisplay,
			costSource: ctx.values.costSource,
			showSessionDuration: ctx.values.showSessionDuration,
			showLinesChanged: ctx.values.showLinesChanged,
		});

		// Build new settings
		const newSettings = {
			...existingSettings,
			statusLine: {
				type: 'command',
				command,
				padding: 0,
			},
		};

		const settingsJson = JSON.stringify(newSettings, null, '\t');

		// Dry run mode
		if (ctx.values.dryRun) {
			log(`\n${pc.dim('--- dry run ---')}`);
			log(`${pc.dim('Would write to:')} ${settingsPath}`);
			log(settingsJson);
			log(pc.dim('--- end dry run ---'));
			return;
		}

		// Write settings
		mkdirSync(path.dirname(settingsPath), { recursive: true });
		writeFileSync(settingsPath, `${settingsJson}\n`, 'utf-8');

		log(`\n${pc.green('✓')} Statusline configured successfully!`);
		log(`  ${pc.dim('Command:')} ${command}`);
		log(`\n  ${pc.dim('Restart Claude Code to activate the statusline.')}`);
	},
});
