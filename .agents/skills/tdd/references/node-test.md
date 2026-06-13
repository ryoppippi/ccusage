# Node Test TDD Reference

## Running

```bash
# Run every TypeScript package/tooling test.
just test-node

# Run a specific test file.
node --test apps/ccusage/src/cli.test.ts

# Run tests matching a name pattern.
node --test --test-name-pattern "returns 0 for an empty cart" path/to/file.test.ts
```

## Modifiers

Import runner APIs explicitly from `node:test`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
```

Use built-in modifiers instead of commenting out or deleting tests:

- `it.todo("description")` - placeholder for a test you plan to write.
- `it.skip("description", ...)` - temporarily disable a blocked test with an
  explanation.
- `it.only("description", ...)` - focus during Red-Green; remove before
  committing.

## Red-Green Example

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateTotal } from './cart.ts';

describe(calculateTotal.name, () => {
	it('returns 0 for an empty cart', () => {
		assert.equal(calculateTotal([]), 0);
	});

	it('sums item prices', () => {
		const items = [{ price: 10 }, { price: 20 }];

		assert.equal(calculateTotal(items), 30);
	});
});
```

## Expected Failures

Avoid `try`/`catch` for expected failures. Assert the rejection or thrown error
directly:

```typescript
it('rejects invalid config', async () => {
	await assert.rejects(loadConfig('bad.json'), Error);
});
```
