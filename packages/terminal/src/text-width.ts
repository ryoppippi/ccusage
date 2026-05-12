import stringWidth from 'string-width';

type BunTextHelpers = {
	stringWidth?: (
		text: string,
		options?: {
			ambiguousIsNarrow?: boolean;
			countAnsiEscapeCodes?: boolean;
		},
	) => number;
};

function getBunTextHelpers(): BunTextHelpers | undefined {
	return (globalThis as { Bun?: BunTextHelpers }).Bun;
}

export function isBunRuntime(): boolean {
	return getBunTextHelpers() != null;
}

function hasCursorStateSequence(text: string): boolean {
	return text.includes('\u001B7') || text.includes('\u001B8');
}

export function getStringWidth(text: string): number {
	const bunTextHelpers = getBunTextHelpers();
	const bunStringWidth = bunTextHelpers?.stringWidth;
	if (isBunRuntime() && bunStringWidth != null && !hasCursorStateSequence(text)) {
		return bunStringWidth(text, {
			ambiguousIsNarrow: false,
			countAnsiEscapeCodes: false,
		});
	}
	return stringWidth(text);
}

if (import.meta.vitest != null) {
	describe('getStringWidth', () => {
		it.skipIf(!isBunRuntime())('uses Bun.stringWidth for ANSI and emoji width', () => {
			expect(getStringWidth('\x1B[31mhello\x1B[0m')).toBe(5);
			expect(getStringWidth('🔥')).toBe(2);
		});

		it('keeps cursor state sequence handling on the string-width fallback', () => {
			expect(getStringWidth('\u001B7🔥\u001B8\x1B[2C')).toBe(2);
		});
	});
}
