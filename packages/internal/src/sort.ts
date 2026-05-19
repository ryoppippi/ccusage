export type SortOrder = 'asc' | 'desc';

export function compareStrings(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function compareStringsDesc(a: string, b: string): number {
	return a < b ? 1 : a > b ? -1 : 0;
}

export function compareStringsByOrder(a: string, b: string, order: SortOrder): number {
	return order === 'asc' ? compareStrings(a, b) : compareStringsDesc(a, b);
}

export function sortByString<T>(
	items: T[],
	getValue: (item: T) => string,
	order: SortOrder = 'asc',
): T[] {
	return items.sort((a, b) => compareStringsByOrder(getValue(a), getValue(b), order));
}

export function sortByDate<T>(
	items: T[],
	getDate: (item: T) => string | Date,
	order: SortOrder = 'desc',
): T[] {
	const itemsWithTime = items.map((item, index) => {
		const date = getDate(item);
		return {
			index,
			item,
			time: typeof date === 'string' ? Date.parse(date) : date.getTime(),
		};
	});
	const direction = order === 'asc' ? 1 : -1;
	return itemsWithTime
		.sort((a, b) => (a.time - b.time) * direction || a.index - b.index)
		.map(({ item }) => item);
}

if (import.meta.vitest != null) {
	describe('compareStrings', () => {
		it('sorts ISO-like strings in ascending codepoint order', () => {
			const values = ['2025-02-01', '2025-01-10', '2025-01-02'];

			values.sort(compareStrings);

			expect(values).toEqual(['2025-01-02', '2025-01-10', '2025-02-01']);
		});

		it('sorts ISO-like strings in descending codepoint order', () => {
			const values = ['2025-02-01', '2025-01-10', '2025-01-02'];

			values.sort(compareStringsDesc);

			expect(values).toEqual(['2025-02-01', '2025-01-10', '2025-01-02']);
		});
	});

	describe('sortByString', () => {
		it('sorts items by selected string value', () => {
			const rows = [
				{ id: 1, date: '2025-01-10' },
				{ id: 2, date: '2025-01-02' },
				{ id: 3, date: '2025-02-01' },
			];

			sortByString(rows, (row) => row.date);

			expect(rows.map((row) => row.id)).toEqual([2, 1, 3]);
		});

		it('sorts items by selected string value in descending order', () => {
			const rows = [
				{ id: 1, date: '2025-01-10' },
				{ id: 2, date: '2025-01-02' },
				{ id: 3, date: '2025-02-01' },
			];

			sortByString(rows, (row) => row.date, 'desc');

			expect(rows.map((row) => row.id)).toEqual([3, 1, 2]);
		});
	});

	describe('sortByDate', () => {
		const testData = [
			{ id: 1, date: '2024-01-01T10:00:00Z' },
			{ id: 2, date: '2024-01-03T10:00:00Z' },
			{ id: 3, date: '2024-01-02T10:00:00Z' },
		];

		it('sorts date strings descending by default', () => {
			const result = sortByDate(testData, (item) => item.date);

			expect(result.map((item) => item.id)).toEqual([2, 3, 1]);
		});

		it('sorts date strings ascending when requested', () => {
			const result = sortByDate(testData, (item) => item.date, 'asc');

			expect(result.map((item) => item.id)).toEqual([1, 3, 2]);
		});

		it('sorts Date objects', () => {
			const dateData = [
				{ id: 1, date: new Date('2024-01-01T10:00:00Z') },
				{ id: 2, date: new Date('2024-01-03T10:00:00Z') },
				{ id: 3, date: new Date('2024-01-02T10:00:00Z') },
			];

			const result = sortByDate(dateData, (item) => item.date);

			expect(result.map((item) => item.id)).toEqual([2, 3, 1]);
		});

		it('keeps original order for equal dates', () => {
			const tiedData = [
				{ id: 1, date: '2024-01-01T10:00:00Z' },
				{ id: 2, date: '2024-01-03T10:00:00Z' },
				{ id: 3, date: '2024-01-01T10:00:00Z' },
				{ id: 4, date: '2024-01-03T10:00:00Z' },
			];

			const descResult = sortByDate(tiedData, (item) => item.date, 'desc');
			const ascResult = sortByDate(tiedData, (item) => item.date, 'asc');

			expect(descResult.map((item) => item.id)).toEqual([2, 4, 1, 3]);
			expect(ascResult.map((item) => item.id)).toEqual([1, 3, 2, 4]);
		});
	});
}
