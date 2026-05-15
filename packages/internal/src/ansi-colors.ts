import type { WriteStream } from 'node:tty';
import process from 'node:process';

type ColorCode = 31 | 33 | 36 | 90;

function shouldUseColor(stream: WriteStream): boolean {
	if (process.env.NO_COLOR != null || process.env.FORCE_COLOR === '0') {
		return false;
	}
	if (process.env.FORCE_COLOR != null) {
		return true;
	}
	return stream.isTTY === true;
}

function colorize(stream: WriteStream, code: ColorCode, value: string): string {
	if (!shouldUseColor(stream)) {
		return value;
	}
	return `\u001B[${code}m${value}\u001B[39m`;
}

export function cyan(stream: WriteStream, value: string): string {
	return colorize(stream, 36, value);
}

export function gray(stream: WriteStream, value: string): string {
	return colorize(stream, 90, value);
}

export function red(stream: WriteStream, value: string): string {
	return colorize(stream, 31, value);
}

export function yellow(stream: WriteStream, value: string): string {
	return colorize(stream, 33, value);
}
