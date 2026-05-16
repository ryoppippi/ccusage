---
name: tdd
description: t-wada style TDD workflow — Red-Green-Refactor cycle for all logic changes. Use when implementing features, fixing bugs, or refactoring code with strict test-driven development (e.g., "implement with TDD", "fix this bug TDD style", "/tdd").
---

<!--
Example prompts:
  /tdd
  /tdd implement user authentication
  /tdd fix the cart total calculation bug
-->

You are following strict t-wada style Test-Driven Development. All code changes that involve logic (bug fixes, new features, refactors) **must** follow Red-Green-Refactor. No exceptions.

**Project test environment:**

```
!`cat package.json 2>/dev/null | jq -r '.scripts | to_entries[] | select(.key | test("test")) | "\(.key): \(.value)"' 2>/dev/null || echo "No package.json test scripts found"`
```

```
!`if [ -f vitest.config.ts ] || [ -f vitest.config.js ] || [ -f vitest.config.mts ]; then echo "Test runner: Vitest"; elif [ -f jest.config.ts ] || [ -f jest.config.js ] || [ -f jest.config.cjs ]; then echo "Test runner: Jest"; elif [ -f pytest.ini ] || [ -f pyproject.toml ] && grep -q pytest pyproject.toml 2>/dev/null; then echo "Test runner: pytest"; elif [ -f Cargo.toml ]; then echo "Test runner: cargo test"; elif [ -f go.mod ]; then echo "Test runner: go test"; else echo "Test runner: unknown — ask the user"; fi`
```

## The Cycle

1. **Red** — Write a failing test first. Run it and confirm it fails for the expected reason. Do **not** write any production code yet.
2. **Green** — Write the **minimum** production code to make the failing test pass. Nothing more.
3. **Refactor** — Clean up both test and production code while keeping all tests green. Remove duplication, improve naming, simplify structure.

Repeat until the feature or fix is complete.

## Rules

- **Never write production code without a failing test that demands it.** If there is no red test, there is no reason to write code.
- **One behaviour per test.** Each test should verify exactly one thing. Name it after the behaviour, not the implementation (e.g. `it("returns 0 for an empty cart")` not `it("test calculateTotal")`).
- **Keep the green step as small as possible.** Fake it, then make it real. Triangulate with additional tests when needed.
- **Run the affected test suite after every green and every refactor step.** Prefer running only changed/affected tests during the cycle for speed. Never skip this.
- **Refactor only on green.** If a test is red, fix the production code first — do not restructure anything while tests are failing.
- **Tests are first-class code.** Apply the same quality standards (naming, readability, no duplication) to test code as to production code.
- **Do not delete or weaken a test to make the build pass.** If a test is wrong, fix the test with a clear reason — do not silently remove it.
- **Bug fixes start with a regression test.** Before touching the bug, write a test that reproduces it and fails. Then fix the bug and confirm the test goes green.

## Workflow

1. **Sketch behaviours** — Before writing any code, list the behaviours to implement as placeholder tests (e.g. `it.todo(...)` in JS, `@pytest.mark.skip` in Python, `#[ignore]` in Rust).
2. **Pick one behaviour** — Start with the simplest or most fundamental one.
3. **Red** — Write the test. Run it. Confirm it fails for the right reason.
4. **Green** — Write the minimum code to pass. Run the test. Confirm it passes.
5. **Refactor** — Clean up. Run all affected tests. Confirm everything is green.
6. **Repeat** from step 2 until all behaviours are covered.

## Test Execution

Prefer running only the tests affected by your changes during the Red-Green-Refactor cycle. Full suite runs are for CI or final verification.

**Runner-specific guidance** — Read the relevant example file alongside this skill for detailed test modifiers, idioms, and runner-specific tips:

- **Vitest**: See `vitest-example.md` — test modifiers (`it.todo`, `it.skip`, `it.fails`, etc.), `--changed` flag
- **Rust (cargo test)**: See `rust-example.md` — `#[ignore]`, `#[should_panic]`, filtering, doc tests
- **Zig (zig test)**: See `zig-example.md` — `std.testing`, `test` blocks, `--test-filter`

For other runners, adapt the general patterns:

- **Jest**: `pnpm jest --changedSince=HEAD` or `pnpm jest <test-file>`
- **pytest**: `pytest <test-file>` or `pytest -x --lf`
- **go**: `go test ./path/to/package`

## Key Principles

- When in doubt, write a smaller test
- Each test should read like a specification of behaviour
- The test name is documentation — make it descriptive
- If you cannot name a test clearly, the behaviour is not well understood yet
- Prefer testing public interfaces over internal implementation details
- DO NOT DRY tests - duplication in tests are ok if it improves readability and clarity of intent. Refactor only when there is a clear benefit.
