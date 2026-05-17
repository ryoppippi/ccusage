import { regex } from 'arkregex';

type NodeVersion = readonly [number, number, number];

const nodeVersionRegex = regex('^v?(\\d+)\\.(\\d+)\\.(\\d+)$');

function parseNodeVersion(version: string): NodeVersion | undefined {
	const match = nodeVersionRegex.exec(version);
	if (match == null) {
		return undefined;
	}

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
		return undefined;
	}

	return [major, minor, patch];
}

export function isSupportedNodeVersion(version: string, minimum: NodeVersion): boolean {
	const actual = parseNodeVersion(version);
	if (actual == null) {
		return false;
	}

	for (const index of [0, 1, 2] as const) {
		if (actual[index] > minimum[index]) {
			return true;
		}
		if (actual[index] < minimum[index]) {
			return false;
		}
	}

	return true;
}

if (import.meta.vitest != null) {
	describe('isSupportedNodeVersion', () => {
		it('accepts the minimum version', () => {
			expect(isSupportedNodeVersion('v22.11.0', [22, 11, 0])).toBe(true);
		});

		it('accepts later major versions', () => {
			expect(isSupportedNodeVersion('v23.0.0', [22, 11, 0])).toBe(true);
		});

		it('rejects versions below the minimum minor version', () => {
			expect(isSupportedNodeVersion('v22.10.0', [22, 11, 0])).toBe(false);
		});

		it('rejects versions below the minimum patch version', () => {
			expect(isSupportedNodeVersion('v22.11.0', [22, 11, 1])).toBe(false);
		});

		it('rejects malformed versions', () => {
			expect(isSupportedNodeVersion('v22.11.0-nightly', [22, 11, 0])).toBe(false);
		});
	});
}
