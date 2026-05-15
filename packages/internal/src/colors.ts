import type { WriteStream } from 'node:tty';
import process from 'node:process';
import { styleText } from 'node:util';

type Style = 'blue' | 'bold' | 'cyan' | 'dim' | 'gray' | 'green' | 'red' | 'yellow';

export type Formatter = (value: string) => string;

function shouldUseColor(stream: WriteStream): boolean {
	if (process.env.FORCE_COLOR != null) {
		return process.env.FORCE_COLOR !== '0';
	}
	if (process.env.NO_COLOR != null && process.env.NO_COLOR !== '') {
		return false;
	}
	return stream.isTTY === true;
}

function colorize(style: Style, value: string, stream: WriteStream = process.stdout): string {
	if (!shouldUseColor(stream)) {
		return value;
	}
	return styleText(style, value, { validateStream: false });
}

export function blue(value: string, stream?: WriteStream): string {
	return colorize('blue', value, stream);
}

export function bold(value: string, stream?: WriteStream): string {
	return colorize('bold', value, stream);
}

export function cyan(value: string, stream?: WriteStream): string {
	return colorize('cyan', value, stream);
}

export function dim(value: string, stream?: WriteStream): string {
	return colorize('dim', value, stream);
}

export function gray(value: string, stream?: WriteStream): string {
	return colorize('gray', value, stream);
}

export function green(value: string, stream?: WriteStream): string {
	return colorize('green', value, stream);
}

export function red(value: string, stream?: WriteStream): string {
	return colorize('red', value, stream);
}

export function yellow(value: string, stream?: WriteStream): string {
	return colorize('yellow', value, stream);
}

if (import.meta.vitest != null) {
	describe('colors', () => {
		it('lets FORCE_COLOR override NO_COLOR', () => {
			vi.stubEnv('FORCE_COLOR', '1');
			vi.stubEnv('NO_COLOR', '1');
			try {
				expect(cyan('info')).toBe('\u001B[36minfo\u001B[39m');
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('ignores an empty NO_COLOR value', () => {
			vi.stubEnv('FORCE_COLOR', undefined);
			vi.stubEnv('NO_COLOR', '');
			try {
				const stream = { isTTY: true } as WriteStream;
				expect(yellow('warn', stream)).toBe('\u001B[33mwarn\u001B[39m');
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});
}
