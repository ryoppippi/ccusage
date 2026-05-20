# Rust Test Commands

Use `direnv exec .` in this repo when `cargo` is not already on `PATH`.

```sh
# Run all Rust tests in the workspace.
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace

# Run tests matching a name pattern.
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace returns_zero_for_empty_cart

# Run only ignored tests.
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace -- --ignored

# Show stdout even for passing tests.
direnv exec . cargo test --manifest-path rust/Cargo.toml --workspace -- --nocapture
```
