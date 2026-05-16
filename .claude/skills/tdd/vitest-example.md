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

Use built-in modifiers instead of commenting out or deleting tests:

- `it.todo("description")` — Placeholder for a test you plan to write. Use this to sketch out behaviours before implementing.
- `it.skip("description", ...)` — Temporarily disable a test (e.g. blocked by an external dependency). Always leave a comment explaining why.
- `it.fails("description", ...)` — Assert that a test **is expected to fail**. Useful during the Red phase to document a known bug while keeping the suite green.
- `it.only("description", ...)` — Run only this test in the suite. Useful for focusing during the Red-Green cycle. **Remove before committing.**
- `it.concurrent("description", ...)` — Run concurrently with other concurrent tests. Use when tests are independent.
- `it.sequential("description", ...)` — Force sequential execution inside a concurrent suite. Use when a test depends on shared state.
- `it.extend({...})` — Create a custom test function with fixtures for sharing setup logic.

Modifiers can be chained (e.g. `it.skip.concurrent(...)`, `it.fails.only(...)`).

See https://vitest.dev/api/test for the full API.

## TDD Example

```typescript
import { describe, expect, it } from 'vitest';
import { calculateTotal } from './cart';

describe('calculateTotal', () => {
	// Step 1: Sketch behaviours with todo
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
