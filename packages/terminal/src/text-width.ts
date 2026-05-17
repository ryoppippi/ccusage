type BunTextHelpers = {
	stringWidth?: (
		text: string,
		options?: {
			ambiguousIsNarrow?: boolean;
			countAnsiEscapeCodes?: boolean;
		},
	) => number;
};

let segmenter: Intl.Segmenter | undefined;

function getBunTextHelpers(): BunTextHelpers | undefined {
	return (globalThis as { Bun?: BunTextHelpers }).Bun;
}

export function isBunRuntime(): boolean {
	return getBunTextHelpers() != null;
}

function hasCursorStateSequence(text: string): boolean {
	return text.includes('\u001B7') || text.includes('\u001B8');
}

function stripTerminalSequences(text: string): string {
	let output = '';
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code !== 27) {
			output += text[index]!;
			continue;
		}

		const nextCode = text.charCodeAt(index + 1);
		if (nextCode === 55 || nextCode === 56) {
			index++;
			continue;
		}
		if (nextCode !== 91) {
			continue;
		}

		index += 2;
		while (index < text.length) {
			const sequenceCode = text.charCodeAt(index);
			if (sequenceCode >= 64 && sequenceCode <= 126) {
				break;
			}
			index++;
		}
	}
	return output;
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

function isCombiningOrIgnorable(codePoint: number): boolean {
	return (
		(codePoint >= 0x0300 && codePoint <= 0x036F) ||
		(codePoint >= 0x1AB0 && codePoint <= 0x1AFF) ||
		(codePoint >= 0x1DC0 && codePoint <= 0x1DFF) ||
		(codePoint >= 0x20D0 && codePoint <= 0x20FF) ||
		(codePoint >= 0xFE00 && codePoint <= 0xFE0F) ||
		codePoint === 0x200D
	);
}

function isWideCodePoint(codePoint: number): boolean {
	return (
		codePoint === 0x2329 ||
		codePoint === 0x232A ||
		codePoint === 0x3000 ||
		(codePoint >= 0x1100 && codePoint <= 0x115F) ||
		(codePoint >= 0x231A && codePoint <= 0x231B) ||
		(codePoint >= 0x23E9 && codePoint <= 0x23EC) ||
		(codePoint >= 0x25FD && codePoint <= 0x25FE) ||
		codePoint === 0x26A1 ||
		codePoint === 0x2705 ||
		codePoint === 0x274C ||
		(codePoint >= 0x2753 && codePoint <= 0x2755) ||
		(codePoint >= 0x2795 && codePoint <= 0x2797) ||
		codePoint === 0x27B0 ||
		codePoint === 0x27BF ||
		(codePoint >= 0x2E80 && codePoint <= 0xA4CF) ||
		codePoint === 0x2B50 ||
		codePoint === 0x2B55 ||
		(codePoint >= 0xAC00 && codePoint <= 0xD7A3) ||
		(codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
		(codePoint >= 0xFE10 && codePoint <= 0xFE19) ||
		(codePoint >= 0xFE30 && codePoint <= 0xFE6F) ||
		(codePoint >= 0xFF00 && codePoint <= 0xFF60) ||
		(codePoint >= 0xFFE0 && codePoint <= 0xFFE6) ||
		(codePoint >= 0x1F300 && codePoint <= 0x1FAFF) ||
		(codePoint >= 0x20000 && codePoint <= 0x3FFFD)
	);
}

function getFallbackStringWidth(text: string): number {
	const normalizedText = stripTerminalSequences(text);
	segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });

	let width = 0;
	for (const { segment } of segmenter.segment(normalizedText)) {
		let segmentWidth = 0;
		let hasEmojiVariation = false;
		for (const char of segment) {
			const codePoint = char.codePointAt(0)!;
			if (codePoint === 0xFE0F) {
				hasEmojiVariation = true;
			}
			if (codePoint < 32 || isCombiningOrIgnorable(codePoint)) {
				continue;
			}
			segmentWidth = Math.max(segmentWidth, isWideCodePoint(codePoint) ? 2 : 1);
		}
		if (hasEmojiVariation) {
			segmentWidth = Math.max(segmentWidth, 2);
		}
		width += segmentWidth;
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
	if (bunStringWidth != null) {
		const normalizedText = hasCursorStateSequence(text) ? stripTerminalSequences(text) : text;
		return bunStringWidth(normalizedText, {
			ambiguousIsNarrow: false,
			countAnsiEscapeCodes: false,
		});
	}
	return getFallbackStringWidth(text);
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

		it('handles cursor state sequences around emoji', () => {
			expect(getStringWidth('\u001B7🔥\u001B8\x1B[2C')).toBe(2);
		});

		it('handles wide Unicode text without Bun helpers', () => {
			expect(getFallbackStringWidth('表')).toBe(2);
			expect(getFallbackStringWidth('コンテキスト')).toBe(12);
			expect(getFallbackStringWidth('á')).toBe(1);
			expect(getFallbackStringWidth('🏳️‍🌈')).toBe(2);
		});
	});
}
