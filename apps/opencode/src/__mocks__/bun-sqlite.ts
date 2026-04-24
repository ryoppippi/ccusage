// Stub for bun:sqlite used during Vitest (Node.js) test runs.
// The real implementation is Bun's built-in Database; this stub lets
// tests import data-loader.ts without crashing on an unavailable built-in.
export class Database {
	constructor(_path: string, _options?: { readonly?: boolean }) {}
	query(_sql: string) {
		return { all: () => [] as never[] };
	}
	close() {}
}
