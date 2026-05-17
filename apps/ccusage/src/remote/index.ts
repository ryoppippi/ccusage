import type {
	MaterializedRemoteClaudeRoots,
	RemoteFetchFailure,
	RemoteFetchSuccess,
	RemoteHostSpec,
	RemoteOptions,
} from './types.ts';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { logger } from '../logger.ts';
import { fetchClaudeProjectsViaSSH, parseHostSpec } from './ssh.ts';
import { listTailscalePeers } from './tailscale.ts';

const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const TMP_PREFIX = 'ccusage-remote-';

export type CommandRemoteArgs = {
	remoteHost?: string;
	remoteTailscale?: boolean;
	remoteTmp?: string;
};

export function parseRemoteHostsArg(value: string | undefined): RemoteHostSpec[] {
	if (value == null || value.trim() === '') {
		return [];
	}
	const specs: RemoteHostSpec[] = [];
	const seen = new Set<string>();
	for (const entry of value.split(',')) {
		const spec = parseHostSpec(entry);
		if (spec == null) {
			logger.warn(`Ignoring invalid --remote-host entry: ${entry}`);
			continue;
		}
		if (seen.has(spec.label)) {
			continue;
		}
		seen.add(spec.label);
		specs.push(spec);
	}
	return specs;
}

export function shouldUseRemote(args: CommandRemoteArgs): boolean {
	if (args.remoteTailscale === true) {
		return true;
	}
	const hostStr = args.remoteHost ?? '';
	return hostStr.trim() !== '';
}

export async function materializeRemoteClaudeRoots(
	options: RemoteOptions,
): Promise<MaterializedRemoteClaudeRoots> {
	const baseSpecs: RemoteHostSpec[] = [];
	const seen = new Set<string>();
	for (const host of options.hosts) {
		const spec = parseHostSpec(host);
		if (spec == null || seen.has(spec.label)) {
			continue;
		}
		seen.add(spec.label);
		baseSpecs.push(spec);
	}
	if (options.useTailscale) {
		const discovered = await safelyListTailscalePeers();
		for (const spec of discovered) {
			if (seen.has(spec.label)) {
				continue;
			}
			seen.add(spec.label);
			baseSpecs.push(spec);
		}
	}

	if (baseSpecs.length === 0) {
		return {
			rootPaths: [],
			successes: [],
			failures: [],
			dispose: async () => {},
		};
	}

	const tmpRoot = await mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), TMP_PREFIX));
	// Process may exit synchronously via `process.exit(0)` inside a command
	// body, which skips async finally blocks. The synchronous rmSync hook
	// guarantees the temp tree is cleaned up even on hard exit.
	const exitListener = (): void => {
		try {
			rmSync(tmpRoot, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup; surface nothing during interpreter teardown.
		}
	};
	process.once('exit', exitListener);
	const successes: RemoteFetchSuccess[] = [];
	const failures: RemoteFetchFailure[] = [];

	const settled = await Promise.allSettled(
		baseSpecs.map(async (spec) => {
			const rootPath = path.join(tmpRoot, sanitizeLabelForPath(spec.label));
			await fetchClaudeProjectsViaSSH(spec, rootPath);
			return { spec, rootPath } satisfies RemoteFetchSuccess;
		}),
	);
	for (const [index, outcome] of settled.entries()) {
		const spec = baseSpecs[index]!;
		if (outcome.status === 'fulfilled') {
			successes.push(outcome.value);
			logger.info(`Fetched Claude usage from ${spec.label}`);
			continue;
		}
		const reason =
			outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
		failures.push({ host: spec.label, reason });
		logger.warn(`Skipped ${spec.label}: ${reason}`);
	}

	const dispose = async (): Promise<void> => {
		process.off('exit', exitListener);
		await rm(tmpRoot, { recursive: true, force: true });
	};

	return {
		rootPaths: successes.map((entry) => entry.rootPath),
		successes,
		failures,
		dispose,
	};
}

export async function withRemoteClaudeRoots<T>(
	args: CommandRemoteArgs,
	run: () => Promise<T>,
): Promise<T> {
	if (!shouldUseRemote(args)) {
		return run();
	}
	const materialized = await materializeRemoteClaudeRoots({
		hosts: parseRemoteHostsArg(args.remoteHost).map((spec) => spec.label),
		useTailscale: args.remoteTailscale === true,
		tmpRoot: args.remoteTmp,
	});
	if (materialized.rootPaths.length === 0) {
		await materialized.dispose();
		logger.warn('No remote Claude roots were materialized; continuing with local data only.');
		return run();
	}
	const restore = augmentClaudeConfigDir(materialized.rootPaths);
	try {
		return await run();
	} finally {
		restore();
		await materialized.dispose();
	}
}

function augmentClaudeConfigDir(additionalRoots: readonly string[]): () => void {
	const previous = process.env[CLAUDE_CONFIG_DIR_ENV];
	const existing = previous == null || previous.trim() === '' ? [] : [previous];
	const merged = [...existing, ...additionalRoots].join(',');
	process.env[CLAUDE_CONFIG_DIR_ENV] = merged;
	return () => {
		if (previous == null) {
			delete process.env[CLAUDE_CONFIG_DIR_ENV];
		} else {
			process.env[CLAUDE_CONFIG_DIR_ENV] = previous;
		}
	};
}

function sanitizeLabelForPath(label: string): string {
	return label.replaceAll('@', '_at_').replaceAll('/', '_');
}

async function safelyListTailscalePeers(): Promise<RemoteHostSpec[]> {
	try {
		return await listTailscalePeers();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		logger.warn(`Failed to list Tailscale peers: ${reason}`);
		return [];
	}
}

if (import.meta.vitest != null) {
	describe('parseRemoteHostsArg', () => {
		it('parses comma-separated host list', () => {
			expect(parseRemoteHostsArg('ca-20036826, ogosh@home-mac-main').map((s) => s.label)).toEqual([
				'ca-20036826',
				'ogosh@home-mac-main',
			]);
		});

		it('drops empty values and duplicates', () => {
			expect(parseRemoteHostsArg(', , host-a, host-a ,host-b').map((s) => s.label)).toEqual([
				'host-a',
				'host-b',
			]);
		});

		it('returns empty for blank input', () => {
			expect(parseRemoteHostsArg(undefined)).toEqual([]);
			expect(parseRemoteHostsArg('')).toEqual([]);
			expect(parseRemoteHostsArg('   ')).toEqual([]);
		});

		it('drops invalid entries', () => {
			expect(parseRemoteHostsArg('-evil,good-host').map((s) => s.label)).toEqual(['good-host']);
		});
	});

	describe('shouldUseRemote', () => {
		it('returns false when both options are absent', () => {
			expect(shouldUseRemote({})).toBe(false);
		});

		it('returns true on explicit hosts', () => {
			expect(shouldUseRemote({ remoteHost: 'ca-20036826' })).toBe(true);
		});

		it('returns true on tailscale flag', () => {
			expect(shouldUseRemote({ remoteTailscale: true })).toBe(true);
		});
	});

	describe('withRemoteClaudeRoots', () => {
		const original = process.env[CLAUDE_CONFIG_DIR_ENV];

		afterEach(() => {
			if (original == null) {
				delete process.env[CLAUDE_CONFIG_DIR_ENV];
			} else {
				process.env[CLAUDE_CONFIG_DIR_ENV] = original;
			}
		});

		it('passes through when no remote args', async () => {
			let captured = 'unset';
			await withRemoteClaudeRoots({}, async () => {
				captured = process.env[CLAUDE_CONFIG_DIR_ENV] ?? 'unset';
			});
			expect(captured).toBe(original ?? 'unset');
		});
	});
}
