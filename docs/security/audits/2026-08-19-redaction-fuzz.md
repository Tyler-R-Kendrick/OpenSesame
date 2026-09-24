# Audit: authorization text redaction fuzz boundary

Date: 2026-08-19

## Finding

The Rust redaction fuzzer found that its authorization oracle treated a bare
`Basic ` prefix as if it contained a credential. Investigation also showed the
production Bearer/Basic patterns used narrow character allowlists, so an
unusual non-whitespace credential could be only partly redacted.

## Resolution

- Bearer and Basic values now redact the complete non-whitespace token.
- A bare scheme with no value remains unchanged.
- The independent fuzz oracle now requires an actual value after the scheme.
- Unit regressions cover both boundaries, and the discovered input is replayed
  before the coverage-guided target is rerun.

## Verification

```bash
cargo +1.88.0 test -p opensesame-redaction
cargo +nightly fuzz run redaction --fuzz-dir fuzz -- -max_total_time=60
pnpm audit:fuzz
```
