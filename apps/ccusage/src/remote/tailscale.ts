import type { Buffer } from 'node:buffer';
import type { RemoteHostSpec } from './types.ts';
import { spawn } from 'node:child_process';
import { parseHostSpec } from './ssh.ts';

type RawTailscalePeer = {
	HostName?: unknown;
	DNSName?: unknown;
	Online?: unknown;
	OS?: unknown;
};

type RawTailscaleStatus = {
	Self?: RawTailscalePeer;
	Peer?: Record<string, RawTailscalePeer>;
};

// macOS reports "macOS", linux reports "linux". Phase 1 only fetches from
// Unix-like remotes because the fetch command embeds `$HOME`.
const SSH_REACHABLE_OS = new Set(['macOS', 'linux', 'freebsd', 'openbsd']);

export function parseTailscaleStatus(jsonText: string): RemoteHostSpec[] {
	let parsed: RawTailscaleStatus;
	try {
		parsed = JSON.parse(jsonText) as RawTailscaleStatus;
	} catch {
		return [];
	}
	const peers = parsed.Peer != null && typeof parsed.Peer === 'object' ? parsed.Peer : {};
	const results: RemoteHostSpec[] = [];
	const seen = new Set<string>();
	for (const peer of Object.values(peers)) {
		if (peer.Online !== true) {
			continue;
		}
		if (typeof peer.OS === 'string' && !SSH_REACHABLE_OS.has(peer.OS)) {
			continue;
		}
		const hostName = typeof peer.HostName === 'string' ? peer.HostName : null;
		if (hostName == null) {
			continue;
		}
		const spec = parseHostSpec(hostName);
		if (spec == null || seen.has(spec.host)) {
			continue;
		}
		seen.add(spec.host);
		results.push(spec);
	}
	return results;
}

export async function listTailscalePeers(): Promise<RemoteHostSpec[]> {
	const status = await readTailscaleStatus();
	return parseTailscaleStatus(status);
}

async function readTailscaleStatus(): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn('tailscale', ['status', '--json'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: false,
		});
		const stdout: string[] = [];
		const stderr: string[] = [];
		child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString('utf8')));
		child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')));
		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve(stdout.join(''));
				return;
			}
			reject(new Error(`tailscale status exited ${String(code)}: ${stderr.join('').trim()}`));
		});
	});
}

if (import.meta.vitest != null) {
	describe('parseTailscaleStatus', () => {
		it('returns active Unix-like peers and skips offline ones', () => {
			const fixture = JSON.stringify({
				Self: { HostName: 'ultra2025', Online: true, OS: 'windows' },
				Peer: {
					a: { HostName: 'ca-20036826', Online: true, OS: 'macOS' },
					b: { HostName: 'home-mac-main', Online: true, OS: 'macOS' },
					c: { HostName: 'iphone-17', Online: false, OS: 'iOS' },
					d: { HostName: 'nicoyuri', Online: false, OS: 'windows' },
					e: { HostName: 'nicolas2025', Online: true, OS: 'windows' },
				},
			});
			expect(parseTailscaleStatus(fixture).map((s) => s.host)).toEqual([
				'ca-20036826',
				'home-mac-main',
			]);
		});

		it('returns an empty list for malformed JSON', () => {
			expect(parseTailscaleStatus('not json')).toEqual([]);
		});

		it('skips peers with missing or unsafe host names', () => {
			const fixture = JSON.stringify({
				Peer: {
					a: { Online: true, OS: 'macOS' },
					b: { HostName: 'good-host', Online: true, OS: 'linux' },
					c: { HostName: '-evil', Online: true, OS: 'linux' },
					d: { HostName: 'good-host', Online: true, OS: 'linux' },
				},
			});
			expect(parseTailscaleStatus(fixture).map((s) => s.host)).toEqual(['good-host']);
		});

		it('treats Self as not a peer', () => {
			const fixture = JSON.stringify({
				Self: { HostName: 'ultra2025', Online: true, OS: 'linux' },
				Peer: {},
			});
			expect(parseTailscaleStatus(fixture)).toEqual([]);
		});
	});
}
