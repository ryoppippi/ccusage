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
}
