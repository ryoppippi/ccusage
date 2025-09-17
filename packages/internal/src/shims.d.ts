declare module 'cli-table3' {
	interface TableConstructor {
		new (options?: any): TableInstance;
		(options?: any): TableInstance;
	}

	interface TableInstance {
		push(...rows: any[]): void;
		toString(): string;
	}

	const Table: TableConstructor;
	export default Table;
}

declare module 'es-toolkit' {
	export function uniq<T>(values: Iterable<T>): T[];
	export function groupBy<T, K extends PropertyKey>(
		values: Iterable<T>,
		mapper: (value: T) => K,
	): Record<K, T[]>;
}

declare module 'picocolors' {
	const pc: Record<string, (...args: any[]) => string> & {
		yellow: (text: string) => string;
		gray: (text: string) => string;
		cyan: (text: string) => string;
	};
	export default pc;
}

declare module 'string-width' {
	export default function stringWidth(input: string): number;
}

declare module 'ansi-escapes' {
	export const cursorHide: string;
	export const cursorShow: string;
	export const clearScreen: string;
	export function cursorTo(x: number, y?: number): string;
	export function cursorForward(columns: number): string;
	export const enterAlternativeScreen: string;
	export const exitAlternativeScreen: string;
}
