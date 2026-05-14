import process from 'node:process';
import { inspect } from 'node:util';

type LogMethod = (...args: unknown[]) => void;

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
