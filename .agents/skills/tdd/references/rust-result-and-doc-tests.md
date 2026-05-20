# Rust Result And Doc Tests

For tests that need error propagation instead of panics:

```rust
#[test]
fn parses_valid_input() -> Result<(), Box<dyn std::error::Error>> {
    let result = parse("42")?;
    assert_eq!(result, 42);
    Ok(())
}
```

Rust doc tests also run with `cargo test`. Use them for public helpers where the
example is useful documentation, not for broad CLI behavior.
