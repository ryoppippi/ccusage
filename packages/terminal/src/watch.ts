import type { Buffer } from 'node:buffer';
import type { WriteStream } from 'node:tty';
import process from 'node:process';
import { Writable } from 'node:stream';
import * as ansiEscapes from 'ansi-escapes';
import { TerminalManager } from './utils.ts';

/**
 * Options for configuring a watch session
 */
export type WatchSessionOptions = {
	/** Show "Press q or Ctrl+C to exit" hint at the bottom */
	showHelpHint?: boolean;
	/** Output stream override (defaults to process.stdout). Useful for testing. */
	stream?: WriteStream;
};

/**
 * Creates a watch session that re-renders content on terminal resize.
 *
 * Uses alternate screen buffer to preserve scrollback history.
 * Handles cleanup on all exit paths (signals, exceptions, keypress).
 *
 * @param renderFn - Function that returns the content to display.
 *   Called on initial render and each terminal resize.
 * @param options - Watch session configuration
 * @returns Promise that resolves when the session ends
 */
export async function createWatchSession(
	renderFn: () => string,
	options?: WatchSessionOptions,
): Promise<void> {
	const stream = options?.stream ?? (process.stdout as WriteStream);
	const terminal = new TerminalManager(stream);

	// Non-TTY fallback: print once and return
	if (!terminal.isTTY) {
		terminal.write(`${renderFn()}\n`);
		return Promise.resolve();
	}

	let cleanupDone = false;
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	let exitResolve: (() => void) | null = null;

	// Use a mutable ref to break the define-before-use cycle between render ↔ cleanup ↔ onResize
	let onResizeRef: (() => void) | null = null;

	const cleanup = (): void => {
		if (cleanupDone) {
			return;
		}
		cleanupDone = true;

		// Clear debounce timer
		if (resizeTimer != null) {
			clearTimeout(resizeTimer);
			resizeTimer = null;
		}

		// Remove resize listener
		if (onResizeRef != null) {
			stream.off('resize', onResizeRef);
		}

		// Restore stdin
		if (process.stdin.isTTY) {
			try {
				process.stdin.setRawMode(false);
				process.stdin.pause();
			} catch {
				// stdin may already be destroyed
			}
		}

		// Restore terminal state
		terminal.cleanup();

		// Resolve the keep-alive promise
		if (exitResolve != null) {
			exitResolve();
		}
	};

	const render = (): void => {
		try {
			terminal.startBuffering();
			terminal.write(ansiEscapes.clearScreen);
			terminal.write(ansiEscapes.cursorTo(0, 0));
			terminal.write(renderFn());
			if (options?.showHelpHint === true) {
				terminal.write('\n\nPress q or Ctrl+C to exit');
			}
			terminal.flush();
		} catch (error) {
			cleanup();
			throw error;
		}
	};

	// Debounced resize handler (75ms trailing edge)
	const onResize = (): void => {
		if (resizeTimer != null) {
			clearTimeout(resizeTimer);
		}
		resizeTimer = setTimeout(render, 75);
	};
	onResizeRef = onResize;

	// Signal handlers for graceful cleanup
	const onSignal = (): void => {
		cleanup();
		process.exit(0);
	};

	const onError = (error: unknown): void => {
		cleanup();
		// Re-throw after cleanup so the error is still visible
		throw error;
	};

	// Register cleanup on all exit paths
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);
	process.once('SIGHUP', onSignal);
	process.on('exit', () => {
		// Synchronous cleanup only — last chance to restore terminal
		if (!cleanupDone) {
			cleanupDone = true;
			terminal.cleanup();
		}
	});
	process.once('uncaughtException', onError);
	process.once('unhandledRejection', onError);

	// Enter watch mode
	terminal.enableSyncMode();
	terminal.enterAlternateScreen();
	terminal.hideCursor();

	// Initial render
	render();

	// Listen for resize events
	stream.on('resize', onResize);

	// Set up keypress detection (only if stdin is a TTY)
	if (process.stdin.isTTY) {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on('data', (data: Buffer) => {
			const key = data.toString();
			// q or Ctrl+C
			if (key === 'q' || key === 'Q' || data[0] === 0x03) {
				cleanup();
				process.exit(0);
			}
		});
	}

	// Keep process alive until cleanup resolves
	return new Promise<void>((resolve) => {
		exitResolve = resolve;
	});
}

/**
 * Creates a mock TTY WriteStream for testing
 */
function createMockTTYStream(): WriteStream {
	const stream = new Writable({
		write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
			callback();
		},
	});
	Object.assign(stream, { isTTY: true, columns: 120, rows: 40 });
	return stream as unknown as WriteStream;
}

/**
 * Creates a mock non-TTY WriteStream for testing
 */
function createMockNonTTYStream(): { stream: WriteStream; output: string } {
	let output = '';
	const stream = new Writable({
		write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
			output += chunk.toString();
			callback();
		},
	});
	Object.assign(stream, { isTTY: false });
	return {
		stream: stream as unknown as WriteStream,
		get output() {
			return output;
		},
	};
}

if (import.meta.vitest != null) {
	describe('createWatchSession', () => {
		it('should render once and return for non-TTY output', async () => {
			const mock = createMockNonTTYStream();

			await createWatchSession(() => 'hello world', { stream: mock.stream });
			expect(mock.output).toBe('hello world\n');
		});

		it('should accept showHelpHint option without crashing for non-TTY', async () => {
			const mock = createMockNonTTYStream();

			await createWatchSession(() => 'test', { showHelpHint: true, stream: mock.stream });
			// Non-TTY should just output the render, no hint
			expect(mock.output).toBe('test\n');
		});
	});

	describe('TerminalManager used by watch', () => {
		it('should create TerminalManager with mock TTY stream', () => {
			const stream = createMockTTYStream();
			const manager = new TerminalManager(stream);
			expect(manager.isTTY).toBe(true);
			expect(manager.width).toBe(120);
			expect(manager.height).toBe(40);
		});

		it('should report non-TTY correctly', () => {
			const { stream } = createMockNonTTYStream();
			const manager = new TerminalManager(stream);
			expect(manager.isTTY).toBe(false);
		});

		it('should handle cleanup idempotently', () => {
			const stream = createMockTTYStream();
			const manager = new TerminalManager(stream);
			// Multiple cleanups should not throw
			manager.cleanup();
			manager.cleanup();
			manager.cleanup();
		});
	});
}
