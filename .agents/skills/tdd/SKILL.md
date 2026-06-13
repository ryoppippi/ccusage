---
name: tdd
description: Guides t-wada Red-Green-Refactor TDD. Use when implementing features, fixing bugs, or refactoring logic with strict test-first development.
---

<!--
Example prompts:
  /tdd
  /tdd implement user authentication
  /tdd fix the cart total calculation bug
-->

You are following strict t-wada style Test-Driven Development. All code changes that involve logic (bug fixes, new features, refactors) **must** follow Red-Green-Refactor. No exceptions.

**Project test environment:** ccusage uses Node's built-in test runner for TypeScript/package
tooling tests and `cargo test` for Rust CLI tests. Use the `testing` skill for
ccusage-specific fixture, adapter, pricing, model, schema, and CLI-output test
rules.

## The Cycle

1. **Red** — Write a failing test first. Run it and confirm it fails for the expected reason. Do **not** write any production code yet.
2. **Green** — Write the **minimum** production code to make the failing test pass. Nothing more.
3. **Refactor** — Clean up both test and production code while keeping all tests green. Remove duplication, improve naming, simplify structure.

Repeat until the feature or fix is complete.

## Rules

- **Never write production code without a failing test that demands it.** If there is no red test, there is no reason to write code.
- **One behavior per test.** Each test should verify exactly one thing. Name it after the behavior, not the implementation (e.g. `it("returns 0 for an empty cart")` not `it("test calculateTotal")`).
- **Keep the green step as small as possible.** Fake it, then make it real. Triangulate with additional tests when needed.
- **Run the affected test suite after every green and every refactor step.** Prefer running only changed/affected tests during the cycle for speed. Never skip this.
- **Refactor only on green.** If a test is red, fix the production code first — do not restructure anything while tests are failing.
- **Tests are first-class code.** Apply the same quality standards (naming, readability, no duplication) to test code as to production code.
- **Do not satisfy TDD with content-existence tests.** A test like `expect(skillMd).toContain("some guidance")` is an anti-pattern unless it proves an executable contract rather than freezing wording.
- **Do not delete or weaken a test to make the build pass.** If a test is wrong, fix the test with a clear reason — do not silently remove it.
- **Bug fixes start with a regression test.** Before touching the bug, write a test that reproduces it and fails. Then fix the bug and confirm the test goes green.

## Workflow

1. **Sketch behaviors** — Before writing any code, list the behaviors to implement as placeholder tests, such as `it.todo(...)` in Node test or `#[ignore]` in Rust.
2. **Pick one behavior** — Start with the simplest or most fundamental one.
3. **Red** — Write the test. Run it. Confirm it fails for the right reason.
4. **Green** — Write the minimum code to pass. Run the test. Confirm it passes.
5. **Refactor** — Clean up. Run all affected tests. Confirm everything is green.
6. **Repeat** from step 2 until all behaviors are covered.

## Test Execution

Prefer running only the tests affected by your changes during the Red-Green-Refactor cycle. Full suite runs are for CI or final verification.

**Runner-specific guidance** — Read the relevant example file alongside this skill for detailed test modifiers, idioms, and runner-specific tips:

- **Node test**: See `references/node-test.md` for focused commands, modifiers, a
  compact Red-Green-Refactor example, and assertion/readability examples.
- **Rust (cargo test)**: See `references/rust.md` for focused cargo commands,
  attributes, Result tests, doc tests, and a compact Red-Green-Refactor example.

## Key Principles

- When in doubt, write a smaller test
- Each test should read like a specification of behavior
- The test name is documentation — make it descriptive
- If you cannot name a test clearly, the behavior is not well understood yet
- Prefer testing public interfaces over internal implementation details
- DO NOT DRY tests - duplication in tests are ok if it improves readability and clarity of intent. Refactor only when there is a clear benefit.
