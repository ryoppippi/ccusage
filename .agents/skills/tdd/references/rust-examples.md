# Rust TDD Reference

## Running Tests

Use `direnv exec .` in this repo when `cargo` is not already on `PATH`.

```sh
# Run all Rust tests in the workspace
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace

# Run tests matching a name pattern
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace returns_zero_for_empty_cart

# Run only ignored tests
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace -- --ignored

# Show stdout even for passing tests
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace -- --nocapture
```

## Test Attributes

- `#[test]` marks a function as a test.
- `#[ignore]` skips a test by default and can sketch behavior before implementation.
- `#[should_panic]` expects a panic. Prefer `Result` tests for recoverable errors.
- `#[cfg(test)]` compiles a module only when testing.

## TDD Example

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn applies_percentage_discount() {
        todo!()
    }

    #[test]
    fn returns_zero_for_empty_cart() {
        assert_eq!(calculate_total(&[]), 0);
    }

    #[test]
    fn sums_item_prices() {
        let items = vec![Item { price: 10 }, Item { price: 20 }];
        assert_eq!(calculate_total(&items), 30);
    }

    #[test]
    #[should_panic(expected = "price must be non-negative")]
    fn rejects_negative_price() {
        let items = vec![Item { price: -5 }];
        calculate_total(&items);
    }
}
```

## Result-Based Tests

For tests that need error propagation instead of panics:

```rust
#[test]
fn parses_valid_input() -> Result<(), Box<dyn std::error::Error>> {
    let result = parse("42")?;
    assert_eq!(result, 42);
    Ok(())
}
```

## Doc Tests

Rust doc tests also run with `cargo test`. Use them for public helpers where the example is useful documentation, not for broad CLI behavior.
