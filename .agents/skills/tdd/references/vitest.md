# Vitest TDD Reference

## Running

```bash
# Run only tests affected by uncommitted changes during the TDD cycle.
pnpm vitest --changed

# Run a specific test file.
pnpm vitest src/utils/cart.test.ts

# Run tests matching a name pattern.
pnpm vitest -t "returns 0 for an empty cart"
```

## Modifiers

Vitest globals are enabled in this repository. Use `describe`, `test`, `it`,
`expect`, `vi`, `beforeEach`, and `assert` directly without importing them from
`vitest`.

Use built-in modifiers instead of commenting out or deleting tests:

- `it.todo("description")` - placeholder for a test you plan to write.
- `it.skip("description", ...)` - temporarily disable a blocked test with an
  explanation.
- `it.fails("description", ...)` - document an expected failure during Red while
  keeping the suite green.
- `it.only("description", ...)` - focus during Red-Green; remove before
  committing.
- `it.concurrent("description", ...)` - run independent tests concurrently.
- `it.sequential("description", ...)` - force order inside a concurrent suite.
- `test.extend({...})` - create a custom test function with fixtures.

Modifiers can be chained, such as `it.skip.concurrent(...)` or
`it.fails.only(...)`.

See https://vitest.dev/api/test for the full API.

## Red-Green Example

```typescript
import { calculateTotal } from './cart';

describe(calculateTotal, () => {
	// use the actual function instead of a string: not 'calculateTotal' but calculateTotal
	it.todo('applies percentage discount');
	it.todo('applies fixed amount discount');
	it.todo('never returns a negative total');

	it('returns 0 for an empty cart', () => {
		expect(calculateTotal([])).toBe(0);
	});

	it('sums item prices', () => {
		const items = [{ price: 10 }, { price: 20 }];
		expect(calculateTotal(items)).toBe(30);
	});
});
```

## Expected Failures

Avoid `try`/`catch` for expected failures. Assert the rejection or thrown error
directly:

```typescript
it('rejects invalid config', async () => {
	await expect(loadConfig('bad.json')).rejects.toThrow(Error);
});
```

Read [`vitest-examples.md`](./vitest-examples.md) for expanded bad/good
examples when reviewing or teaching test style.

## Branching

Avoid `if` branches inside test bodies. Split behaviors when the assertions are
meaningfully different:

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

```typescript
it.each([
	['daily', '2026-05-16'],
	['monthly', '2026-05'],
])('groups %s rows by period', (reportType, expectedPeriod) => {
	const rows = groupUsage(reportType, usage);

	expect(rows[0]?.period).toBe(expectedPeriod);
});
```

## Helpers And Values

Avoid wrapper/helper functions that hide behavior and assertions.

```typescript
it('renders daily totals', () => {
	const input = [{ timestamp: '2026-05-16T10:00:00Z', inputTokens: 100 }];

	expect(renderDaily(input)).toEqual([{ date: '2026-05-16', inputTokens: 100 }]);
});
```

Tests do not need to be DRY. Prefer repeated, explicit setup over shared values
when duplication makes each behavior easier to read.

Avoid hoisting one-off values out of tests. Keep literals close to the behavior
they exercise.

## Assert Narrowing

Use `assert` to make test preconditions explicit and to narrow nullable values.
Do not use non-null assertions when the test can fail with a useful message.

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
