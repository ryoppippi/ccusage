/**
 * Allocate result storage for code paths that fill every slot by numeric index later.
 *
 * `Array.from({ length })` eagerly materializes an array full of `undefined` values, which is
 * wasted work for worker result ordering and bounded-concurrency mapping because each slot is
 * overwritten before the array is read. Setting `.length` keeps the allocation sparse until those
 * indexed writes happen. A Bun microbench over the current local JSONL file count showed this form
 * faster than both `Array.from({ length })` and `Array(length)`, so it also avoids needing a lint
 * suppression for `new Array(length)`.
 */
export function createResultSlots<T>(length: number): T[] {
	const results: T[] = [];
	results.length = length;
	return results;
}

export function groupByToMap<T, K extends string>(
	items: Iterable<T>,
	getKey: (item: T) => K,
): Map<K, T[]> {
	const grouped = new Map<K, T[]>();
	for (const item of items) {
		const key = getKey(item);
		const group = grouped.get(key);
		if (group == null) {
			grouped.set(key, [item]);
		} else {
			group.push(item);
		}
	}
	return grouped;
}

if (import.meta.vitest != null) {
	describe('createResultSlots', () => {
		it('allocates sparse result slots for indexed fills', () => {
			const slots = createResultSlots<number>(3);

			expect(slots).toHaveLength(3);
			expect(0 in slots).toBe(false);
			slots[1] = 42;
			expect(slots).toEqual([undefined, 42, undefined]);
			expect(1 in slots).toBe(true);
		});

		it('returns an empty array for zero slots', () => {
			expect(createResultSlots<unknown>(0)).toEqual([]);
		});
	});

	describe('groupByToMap', () => {
		it('groups items by selected key in insertion order', () => {
			const grouped = groupByToMap(
				[
					{ kind: 'a', value: 1 },
					{ kind: 'b', value: 2 },
					{ kind: 'a', value: 3 },
				],
				(item) => item.kind,
			);

			expect(Array.from(grouped.entries())).toEqual([
				[
					'a',
					[
						{ kind: 'a', value: 1 },
						{ kind: 'a', value: 3 },
					],
				],
				['b', [{ kind: 'b', value: 2 }]],
			]);
		});
	});
}
