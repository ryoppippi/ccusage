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

function getAsciiVisibleWidth(text: string): number | undefined {
	let width = 0;
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code === 27) {
			if (text.charCodeAt(index + 1) !== 91) {
				return undefined;
			}
			index += 2;
			while (index < text.length) {
				const sequenceCode = text.charCodeAt(index);
				if (sequenceCode >= 64 && sequenceCode <= 126) {
					break;
				}
				index++;
			}
			if (index >= text.length) {
				return undefined;
			}
			continue;
		}
		if (code > 126) {
			return undefined;
		}
		if (code >= 32) {
			width++;
		}
	}
	return width;
}

export function getStringWidth(text: string): number {
	const asciiVisibleWidth = getAsciiVisibleWidth(text);
	if (asciiVisibleWidth != null) {
		return asciiVisibleWidth;
	}

	const bunTextHelpers = getBunTextHelpers();
	const bunStringWidth = bunTextHelpers?.stringWidth;
	if (bunStringWidth != null && !hasCursorStateSequence(text)) {
		return bunStringWidth(text, {
			ambiguousIsNarrow: false,
			countAnsiEscapeCodes: false,
		});
	}
	return stringWidth(text);
}

if (import.meta.vitest != null) {
	describe('getStringWidth', () => {
		it('uses the ASCII fast path for plain text and SGR ANSI sequences', () => {
			expect(getStringWidth('hello')).toBe(5);
			expect(getStringWidth('\x1B[31mhello\x1B[0m')).toBe(5);
			expect(getStringWidth('a\nbb')).toBe(3);
		});

		it.skipIf(!isBunRuntime())('uses Bun.stringWidth for ANSI and emoji width', () => {
			expect(getStringWidth('\x1B[31mhello\x1B[0m')).toBe(5);
			expect(getStringWidth('🔥')).toBe(2);
		});

		it('keeps cursor state sequence handling on the string-width fallback', () => {
			expect(getStringWidth('\u001B7🔥\u001B8\x1B[2C')).toBe(2);
		});
	});
}
