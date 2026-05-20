# Rust Test Attributes

- `#[test]` marks a function as a test.
- `#[ignore]` skips a test by default and can sketch behavior before
  implementation.
- `#[should_panic]` expects a panic. Prefer `Result` tests for recoverable
  errors.
- `#[cfg(test)]` compiles a module only when testing.
