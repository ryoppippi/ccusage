import process from 'node:process';
import { inspect } from 'node:util';
import * as colors from './colors.ts';

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
	color?: (value: string, stream: NodeJS.WriteStream) => string,
): void {
	const tag = colors.gray(`[${name}]`, stream);
	const formattedLabel = color == null ? label : color(label, stream);
	writeLine(stream, `${tag} ${formattedLabel} ${formatArgs(args)}`);
}

function writeBox(stream: NodeJS.WriteStream, message: string): void {
	const lines = message.split('\n');
	const contentWidth = Math.max(...lines.map((line) => line.length));
	const width = contentWidth + 4;
	const horizontal = '─'.repeat(width);
	const empty = ' '.repeat(width);
	writeLine(stream);
	writeLine(stream, ` ╭${horizontal}╮`);
	writeLine(stream, ` │${empty}│`);
	for (const line of lines) {
		writeLine(stream, ` │  ${line.padEnd(contentWidth)}  │`);
	}
	writeLine(stream, ` │${empty}│`);
	writeLine(stream, ` ╰${horizontal}╯`);
	writeLine(stream);
}

export function createLogger(name: string): Logger {
	const logger: Logger = {
		level: getInitialLogLevel(),
		warn: (...args) => {
			if (logger.level >= 1) {
				writeTaggedLine(process.stderr, name, ' WARN ', args, colors.yellow);
			}
		},
		info: (...args) => {
			if (logger.level >= 3) {
				writeTaggedLine(process.stdout, name, 'ℹ', args, colors.cyan);
			}
		},
		error: (...args) => {
			if (logger.level >= 1) {
				writeTaggedLine(process.stderr, name, ' ERROR ', args, colors.red);
			}
		},
		debug: (...args) => {
			if (logger.level >= 4) {
				writeTaggedLine(process.stderr, name, '⚙', args, colors.gray);
			}
		},
		trace: (...args) => {
			if (logger.level >= 5) {
				writeTaggedLine(process.stderr, name, '→', args, colors.gray);
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
	describe('createLogger', () => {
		it('renders tagged lines without leading blank lines', () => {
			vi.stubEnv('FORCE_COLOR', undefined);
			vi.stubEnv('NO_COLOR', '1');
			let output = '';
			const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
				output += String(chunk);
				return true;
			});

			try {
				const logger = createLogger('test');
				logger.info('first');
				logger.info('second');
			} finally {
				writeSpy.mockRestore();
				vi.unstubAllEnvs();
			}

			expect(output).toBe('[test] ℹ first\n[test] ℹ second\n');
		});

		it('colors info labels cyan when color is forced', () => {
			vi.stubEnv('FORCE_COLOR', '1');
			vi.stubEnv('NO_COLOR', undefined);
			let output = '';
			const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
				output += String(chunk);
				return true;
			});

			try {
				const logger = createLogger('test');
				logger.info('message');
			} finally {
				writeSpy.mockRestore();
				vi.unstubAllEnvs();
			}

			expect(output).toContain('\u001B[36mℹ\u001B[39m');
		});

		it('renders multi-line boxes with a shared width', () => {
			let output = '';
			const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
				output += String(chunk);
				return true;
			});

			try {
				const logger = createLogger('test');
				logger.box('Title\nDetected: Claude, Codex');
			} finally {
				writeSpy.mockRestore();
			}

			expect(output).toContain('│  Title                    │');
			expect(output).toContain('│  Detected: Claude, Codex  │');
		});
	});

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
