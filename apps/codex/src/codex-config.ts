import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Result } from '@praha/byethrow';
import { CODEX_HOME_ENV, DEFAULT_CODEX_DIR } from './_consts.ts';
import { logger } from './logger.ts';

export type CodexSpeed = 'standard' | 'fast';
export type CodexSpeedOption = 'auto' | CodexSpeed;

type ParsedConfig = {
	profile?: string;
	serviceTier?: string;
	profiles: Map<string, { serviceTier?: string }>;
};

function codexHome(): string {
	const value = process.env[CODEX_HOME_ENV]?.trim();
	return value == null || value === '' ? DEFAULT_CODEX_DIR : path.resolve(value);
}

export function codexConfigPath(): string {
	return path.join(codexHome(), 'config.toml');
}

function parseStringValue(value: string): string | undefined {
	const trimmed = value.trim();
	const quoted = /^"([^"]*)"|'([^']*)'/.exec(trimmed);
	if (quoted != null) {
		return quoted[1] ?? quoted[2];
	}

	const bare = /^([^\s#]+)/.exec(trimmed);
	return bare?.[1];
}

function profileNameFromSection(section: string): string | undefined {
	const match = /^profiles\.(?:"([^"]+)"|'([^']+)'|([\w-]+))$/.exec(section);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function parseCodexConfig(content: string): ParsedConfig {
	const parsed: ParsedConfig = { profiles: new Map() };
	let section = '';

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}

		const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
		if (sectionMatch != null) {
			section = sectionMatch[1]!.trim();
			continue;
		}

		const assignmentIndex = line.indexOf('=');
		if (assignmentIndex === -1) {
			continue;
		}

		const key = line.slice(0, assignmentIndex).trim();
		if (!/^[\w-]+$/.test(key)) {
			continue;
		}

		const value = parseStringValue(line.slice(assignmentIndex + 1));
		if (value == null) {
			continue;
		}

		if (section === '') {
			if (key === 'profile') {
				parsed.profile = value;
			} else if (key === 'service_tier') {
				parsed.serviceTier = value;
			}
			continue;
		}

		if (key !== 'service_tier') {
			continue;
		}

		const profileName = profileNameFromSection(section);
		if (profileName == null) {
			continue;
		}

		const profile = parsed.profiles.get(profileName) ?? {};
		profile.serviceTier = value;
		parsed.profiles.set(profileName, profile);
	}

	return parsed;
}

function isFastServiceTier(serviceTier: string | undefined): boolean {
	const normalized = serviceTier?.trim().toLowerCase();
	return normalized === 'fast' || normalized === 'priority';
}

export function speedFromCodexConfig(content: string): CodexSpeed {
	const parsed = parseCodexConfig(content);
	const profileServiceTier =
		parsed.profile == null ? undefined : parsed.profiles.get(parsed.profile)?.serviceTier;
	return isFastServiceTier(profileServiceTier ?? parsed.serviceTier) ? 'fast' : 'standard';
}

export function normalizeSpeedOption(value: unknown): CodexSpeedOption {
	if (value == null || value === '') {
		return 'auto';
	}
	if (value === 'auto' || value === 'standard' || value === 'fast') {
		return value;
	}
	throw new Error('Invalid --speed value. Use auto, standard, or fast.');
}

export async function resolveCodexSpeed(option: CodexSpeedOption): Promise<CodexSpeed> {
	if (option !== 'auto') {
		return option;
	}

	const configPath = codexConfigPath();
	const configResult = await Result.try({
		try: readFile(configPath, 'utf8'),
		catch: (error) => error,
	});

	if (Result.isFailure(configResult)) {
		logger.debug('Codex config not found or unreadable; using standard pricing', {
			configPath,
			error: configResult.error,
		});
		return 'standard';
	}

	return speedFromCodexConfig(configResult.value);
}

if (import.meta.vitest != null) {
	describe('Codex config speed resolution', () => {
		it('detects top-level priority service tier as fast', () => {
			expect(speedFromCodexConfig('service_tier = "priority"')).toBe('fast');
		});

		it('detects legacy top-level fast service tier as fast', () => {
			expect(speedFromCodexConfig('service_tier = "fast"')).toBe('fast');
		});

		it('uses the active profile service tier over the top-level service tier', () => {
			const content = [
				'profile = "work"',
				'service_tier = "priority"',
				'',
				'[profiles.work]',
				'service_tier = "flex"',
			].join('\n');

			expect(speedFromCodexConfig(content)).toBe('standard');
		});

		it('defaults to standard when no fast tier is configured', () => {
			expect(speedFromCodexConfig('model = "gpt-5.3-codex"')).toBe('standard');
		});

		it('validates CLI speed options', () => {
			expect(normalizeSpeedOption(undefined)).toBe('auto');
			expect(normalizeSpeedOption('fast')).toBe('fast');
			expect(() => normalizeSpeedOption('slow')).toThrow('Invalid --speed value');
		});
	});
}
