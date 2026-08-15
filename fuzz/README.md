# cargo-fuzz targets

This crate is **not** a workspace member. See
[`docs/validation/fuzzing.md`](../docs/validation/fuzzing.md) and
[ADR 0036](../docs/adr/0036-coverage-guided-fuzz-and-bounded-proofs.md).

```bash
cargo install cargo-fuzz
rustup toolchain install nightly
pnpm audit:fuzz
```
