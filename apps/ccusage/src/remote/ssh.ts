import type { Buffer } from 'node:buffer';
import type { Readable, Writable } from 'node:stream';
import type { RemoteHostSpec } from './types.ts';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

// Why these patterns: we never want a user-controlled string to reach `ssh`
// with a leading dash (option spoofing such as `-oProxyCommand=...`) or with
// shell-metacharacters that could escape the constant remote command.
const SSH_USER_PATTERN = /^\w[\w.-]{0,63}$/u;
const SSH_HOST_PATTERN = /^\w[\w.-]{0,253}$/u;

// `~/.claude/projects` only. We deliberately do not include `~/.claude/`
// itself or any sibling files such as `.credentials.json`.
const REMOTE_TAR_TARGET = '.claude/projects';
const REMOTE_TAR_COMMAND = `tar -czf - -C "$HOME" ${REMOTE_TAR_TARGET}`;

const SSH_CONNECT_TIMEOUT_SECONDS = 10;

export type SSHCommand = {
	program: string;
	args: string[];
};

export function parseHostSpec(raw: string): RemoteHostSpec | null {
	const trimmed = raw.trim();
	if (trimmed === '') {
		return null;
	}
	const atIndex = trimmed.indexOf('@');
	if (atIndex === -1) {
		if (!SSH_HOST_PATTERN.test(trimmed)) {
			return null;
		}
		return { raw: trimmed, host: trimmed, label: trimmed };
	}
	const user = trimmed.slice(0, atIndex);
	const host = trimmed.slice(atIndex + 1);
	if (!SSH_USER_PATTERN.test(user) || !SSH_HOST_PATTERN.test(host)) {
		return null;
	}
	return { raw: trimmed, user, host, label: `${user}@${host}` };
}

export function buildSSHFetchCommand(spec: RemoteHostSpec): SSHCommand {
	const target = spec.user != null ? `${spec.user}@${spec.host}` : spec.host;
	return {
		program: 'ssh',
		args: [
			'-o',
			'BatchMode=yes',
			'-o',
			`ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
			target,
			REMOTE_TAR_COMMAND,
		],
	};
}

export function buildTarExtractCommand(destDir: string): SSHCommand {
	return {
		program: 'tar',
		args: ['-xzf', '-', '-C', destDir],
	};
}

type SpawnLike = (
	program: string,
	args: string[],
) => {
	stdin: Writable | null;
	stdout: Readable | null;
	stderr: Readable | null;
	on: (event: 'exit', listener: (code: number | null) => void) => void;
	kill: (signal?: NodeJS.Signals) => void;
};

export type FetchDependencies = {
	spawnProcess?: SpawnLike;
};

export async function fetchClaudeProjectsViaSSH(
	spec: RemoteHostSpec,
	destDir: string,
	deps: FetchDependencies = {},
): Promise<void> {
	await mkdir(destDir, { recursive: true });
	const launcher: SpawnLike =
		deps.spawnProcess ??
		((program, args) => spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false }));

	const sshCmd = buildSSHFetchCommand(spec);
	const tarCmd = buildTarExtractCommand(destDir);
	const ssh = launcher(sshCmd.program, sshCmd.args);
	const tar = launcher(tarCmd.program, tarCmd.args);

	const sshErrChunks: string[] = [];
	const tarErrChunks: string[] = [];
	ssh.stderr?.on('data', (chunk: Buffer) => sshErrChunks.push(chunk.toString('utf8')));
	tar.stderr?.on('data', (chunk: Buffer) => tarErrChunks.push(chunk.toString('utf8')));

	const sshExit = new Promise<number | null>((resolve) => ssh.on('exit', resolve));
	const tarExit = new Promise<number | null>((resolve) => tar.on('exit', resolve));

	if (ssh.stdout == null || tar.stdin == null) {
		ssh.kill('SIGTERM');
		tar.kill('SIGTERM');
		throw new Error(`Failed to wire ssh/tar pipeline for ${spec.label}`);
	}

	try {
		await pipeline(ssh.stdout, tar.stdin);
	} catch (error) {
		ssh.kill('SIGTERM');
		tar.kill('SIGTERM');
		throw new Error(
			`Failed to stream ${spec.label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const [sshCode, tarCode] = await Promise.all([sshExit, tarExit]);
	if (sshCode !== 0) {
		throw new Error(
			`ssh ${spec.label} exited with code ${String(sshCode)}: ${sshErrChunks.join('').trim()}`,
		);
	}
	if (tarCode !== 0) {
		throw new Error(
			`tar extract for ${spec.label} exited with code ${String(tarCode)}: ${tarErrChunks.join('').trim()}`,
		);
	}
}

export function expectedExtractRoot(destDir: string): string {
	return path.resolve(destDir);
}

if (import.meta.vitest != null) {
	describe('parseHostSpec', () => {
		it('accepts bare host names', () => {
			expect(parseHostSpec('ca-20036826')).toEqual({
				raw: 'ca-20036826',
				host: 'ca-20036826',
				label: 'ca-20036826',
			});
		});

		it('accepts user@host', () => {
			expect(parseHostSpec('ogosh@home-mac-main')).toEqual({
				raw: 'ogosh@home-mac-main',
				user: 'ogosh',
				host: 'home-mac-main',
				label: 'ogosh@home-mac-main',
			});
		});

		it('rejects hosts starting with a dash to avoid ssh option spoofing', () => {
			expect(parseHostSpec('-oProxyCommand=evil')).toBeNull();
			expect(parseHostSpec('alice@-evil')).toBeNull();
		});

		it('rejects shell metacharacters', () => {
			expect(parseHostSpec('host;rm -rf /')).toBeNull();
			expect(parseHostSpec('host$(whoami)')).toBeNull();
			expect(parseHostSpec('host with space')).toBeNull();
		});

		it('rejects empty input', () => {
			expect(parseHostSpec('')).toBeNull();
			expect(parseHostSpec('   ')).toBeNull();
		});
	});

	describe('buildSSHFetchCommand', () => {
		it('uses BatchMode and a fixed remote tar command', () => {
			const { program, args } = buildSSHFetchCommand({
				raw: 'ca-20036826',
				host: 'ca-20036826',
				label: 'ca-20036826',
			});
			expect(program).toBe('ssh');
			expect(args).toContain('BatchMode=yes');
			expect(args).toContain('ca-20036826');
			expect(args[args.length - 1]).toContain('.claude/projects');
			expect(args[args.length - 1]).not.toContain(';');
			expect(args[args.length - 1]).not.toContain('|');
		});

		it('targets user@host when a user is given', () => {
			const { args } = buildSSHFetchCommand({
				raw: 'ogosh@home-mac-main',
				user: 'ogosh',
				host: 'home-mac-main',
				label: 'ogosh@home-mac-main',
			});
			expect(args).toContain('ogosh@home-mac-main');
		});
	});
}
