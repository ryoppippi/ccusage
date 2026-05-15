import process from 'node:process';
import { inspect } from 'node:util';

type LogMethod = (...args: unknown[]) => void;

type DrainableWriteStream = {
	write: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
};

export type Logger = {
	level: number;
	warn: LogMethod;
	info: LogMethod;
	error: LogMethod;
	debug: LogMethod;
	trace: LogMethod;
	log: LogMethod;
	box: (message: string) => void;
};

function getInitialLogLevel(): number {
	if (process.env.LOG_LEVEL != null) {
		const level = Number.parseInt(process.env.LOG_LEVEL, 10);
		if (!Number.isNaN(level)) {
			return level;
		}
	}
	return 3;
}

function formatValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	if (value instanceof Error) {
		return value.stack ?? value.message;
	}
	return inspect(value, { colors: false, depth: 4 });
}

function formatArgs(args: unknown[]): string {
	return args.map(formatValue).join(' ');
}

function writeLine(stream: NodeJS.WriteStream, line = ''): void {
	stream.write(`${line}\n`);
}

/**
 * Write one line and wait for stdout backpressure before command shutdown.
 *
 * Bun can terminate a short-lived CLI before a large piped stdout write has drained. JSON and table
 * reports can exceed the pipe buffer, so command code should await this helper for final user output
 * instead of using fire-and-forget `console.log`.
 */
export async function writeLineAsync(stream: DrainableWriteStream, line = ''): Promise<void> {
	await new Promise<void>((resolve) => {
		stream.write(`${line}\n`, () => {
			resolve();
		});
	});
}

export async function writeStdoutLine(line = ''): Promise<void> {
	await writeLineAsync(process.stdout, line);
}

function writeTaggedLine(
	stream: NodeJS.WriteStream,
	name: string,
	label: string,
	args: unknown[],
): void {
	writeLine(stream);
	writeLine(stream, `[${name}] ${label} ${formatArgs(args)}`);
}

function writeBox(stream: NodeJS.WriteStream, message: string): void {
	const width = message.length + 4;
	const horizontal = '─'.repeat(width);
	const empty = ' '.repeat(width);
	writeLine(stream);
	writeLine(stream, ` ╭${horizontal}╮`);
	writeLine(stream, ` │${empty}│`);
	writeLine(stream, ` │  ${message}  │`);
	writeLine(stream, ` │${empty}│`);
	writeLine(stream, ` ╰${horizontal}╯`);
	writeLine(stream);
}

export function createLogger(name: string): Logger {
	const logger: Logger = {
		level: getInitialLogLevel(),
		warn: (...args) => {
			if (logger.level >= 1) {
				writeTaggedLine(process.stderr, name, ' WARN ', args);
			}
		},
		info: (...args) => {
			if (logger.level >= 3) {
				writeTaggedLine(process.stdout, name, 'ℹ', args);
			}
		},
		error: (...args) => {
			if (logger.level >= 1) {
				writeTaggedLine(process.stderr, name, ' ERROR ', args);
			}
		},
		debug: (...args) => {
			if (logger.level >= 4) {
				writeTaggedLine(process.stderr, name, '⚙', args);
			}
		},
		trace: (...args) => {
			if (logger.level >= 5) {
				writeTaggedLine(process.stderr, name, '→', args);
			}
		},
		log: (...args) => {
			if (logger.level >= 2) {
				writeTaggedLine(process.stdout, name, '', args);
			}
		},
		box: (message) => {
			if (logger.level >= 3) {
				writeBox(process.stdout, message);
			}
		},
	};

	return logger;
}

// eslint-disable-next-line no-console
export const log = console.log;

if (import.meta.vitest != null) {
	describe('writeLineAsync', () => {
		it('waits for the write callback before resolving', async () => {
			let flush: (() => void) | undefined;
			let settled = false;
			const chunks: string[] = [];
			const stream: DrainableWriteStream = {
				write: (chunk, callback) => {
					chunks.push(chunk);
					flush = callback ?? undefined;
					return false;
				},
			};

			const promise = writeLineAsync(stream, 'large output').then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);

			flush?.();
			await promise;

			expect(chunks).toEqual(['large output\n']);
			expect(settled).toBe(true);
		});
	});
}
