# Vitest Modifiers

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

## TDD Example

```typescript
import { calculateTotal } from './cart';

describe('calculateTotal', () => {
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
