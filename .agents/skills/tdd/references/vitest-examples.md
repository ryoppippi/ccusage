# Vitest TDD Reference

## Running Tests

```bash
# Run only tests affected by uncommitted changes (preferred during TDD cycle)
pnpm vitest --changed

# Run a specific test file
pnpm vitest src/utils/cart.test.ts

# Run tests matching a name pattern
pnpm vitest -t "returns 0 for an empty cart"
```

## Test Modifiers

Vitest globals are enabled in this repository. Use `describe`, `test`, `it`, `expect`, `vi`, `beforeEach`, and `assert` directly without importing them from `vitest`.

Use built-in modifiers instead of commenting out or deleting tests:

- `it.todo("description")` — Placeholder for a test you plan to write. Use this to sketch out behaviors before implementing.
- `it.skip("description", ...)` — Temporarily disable a test (e.g. blocked by an external dependency). Always leave a comment explaining why.
- `it.fails("description", ...)` — Assert that a test **is expected to fail**. Useful during the Red phase to document a known bug while keeping the suite green.
- `it.only("description", ...)` — Run only this test in the suite. Useful for focusing during the Red-Green cycle. **Remove before committing.**
- `it.concurrent("description", ...)` — Run concurrently with other concurrent tests. Use when tests are independent.
- `it.sequential("description", ...)` — Force sequential execution inside a concurrent suite. Use when a test depends on shared state.
- `test.extend({...})` — Create a custom test function with fixtures for sharing setup logic.

Modifiers can be chained (e.g. `it.skip.concurrent(...)`, `it.fails.only(...)`).

See https://vitest.dev/api/test for the full API.

## TDD Example

```typescript
import { calculateTotal } from './cart';

describe('calculateTotal', () => {
	// Step 1: Sketch behaviors with todo
	it.todo('applies percentage discount');
	it.todo('applies fixed amount discount');
	it.todo('never returns a negative total');

	// Step 2: Implement one at a time (Red → Green → Refactor)
	it('returns 0 for an empty cart', () => {
		expect(calculateTotal([])).toBe(0);
	});

	it('sums item prices', () => {
		const items = [{ price: 10 }, { price: 20 }];
		expect(calculateTotal(items)).toBe(30);
	});
});
```

## Readability Examples

Avoid `try`/`catch` for expected failures.

Bad:

```typescript
it('rejects invalid config', async () => {
	try {
		await loadConfig('bad.json');
		expect.fail('expected loadConfig to throw');
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
	}
});
```

Good:

```typescript
it('rejects invalid config', async () => {
	await expect(loadConfig('bad.json')).rejects.toThrow(Error);
});
```

Avoid `if` branches inside test bodies. Split behaviors or use `it.each`.

Bad:

```typescript
it('formats output', () => {
	const output = formatReport(mode);

	if (mode === 'json') {
		expect(JSON.parse(output)).toEqual(expected);
	} else {
		expect(output).toContain('Total');
	}
});
```

Good:

```typescript
it('formats JSON output', () => {
	const output = formatReport('json');

	expect(JSON.parse(output)).toEqual(expected);
});

it('formats table output', () => {
	const output = formatReport('table');

	expect(output).toContain('Total');
});
```

Use `it.each` only when cases share one behavior.

Good:

```typescript
it.each([
	['daily', '2026-05-16'],
	['monthly', '2026-05'],
])('groups %s rows by period', (reportType, expectedPeriod) => {
	const rows = groupUsage(reportType, usage);

	expect(rows[0]?.period).toBe(expectedPeriod);
});
```

Avoid wrapper/helper functions that hide the behavior and assertions.

Bad:

```typescript
function expectReport(input: UsageEntry[], expected: ReportRow[]) {
	expect(renderDaily(input)).toEqual(expected);
}

it('renders daily totals', () => {
	expectReport(
		[{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }],
		[{ date: '2026-05-16', inputTokens: 100 }],
	);
});
```

Good:

```typescript
it('renders daily totals', () => {
	const input = [{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }];

	expect(renderDaily(input)).toEqual([{ date: '2026-05-16', inputTokens: 100 }]);
});
```

Helpers are fine when they create noisy data or fixtures. Keep the assertion in the test unless the helper's name is more explicit than the assertion it hides.

Use `assert` to make test preconditions explicit and to narrow nullable values. Do not use non-null assertions (`!`) to silence TypeScript when the test can fail with a useful message.

Bad:

```typescript
it('returns the first row', () => {
	const rows = getRows();

	expect(rows[0]!.id).toBe('row-1');
});
```

Good:

```typescript
it('returns the first row', () => {
	const rows = getRows();
	const firstRow = rows[0];
	assert.isDefined(firstRow, 'expected at least one row');

	expect(firstRow.id).toBe('row-1');
});
```

Good for exported values that may be tree-shaken or conditionally defined:

```typescript
assert.isDefined(backendTrpcFetch, 'backendTrpcFetch should be defined');
const backendFetch = backendTrpcFetch;
```
