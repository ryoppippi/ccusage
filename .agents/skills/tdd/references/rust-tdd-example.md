# Rust TDD Example

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
