# Vitest Readability

Read the focused example file for the assertion style you are checking:

- `vitest-expected-failures.md` - avoid `try`/`catch` for expected failures.
- `vitest-branching.md` - avoid branching inside test bodies and use `it.each`
  narrowly.
- `vitest-helpers-and-values.md` - avoid helpers and hoisted values that hide
  behavior.
- `vitest-assert-narrowing.md` - use `assert` instead of non-null assertions.
