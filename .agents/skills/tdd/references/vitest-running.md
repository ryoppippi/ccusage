# Vitest Running

```bash
# Run only tests affected by uncommitted changes during the TDD cycle.
pnpm vitest --changed

# Run a specific test file.
pnpm vitest src/utils/cart.test.ts

# Run tests matching a name pattern.
pnpm vitest -t "returns 0 for an empty cart"
```
