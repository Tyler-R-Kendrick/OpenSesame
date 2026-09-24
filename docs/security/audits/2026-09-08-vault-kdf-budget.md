# Password-wrapper resource admission

The native Argon2id read policy previously admitted 1 GiB and 16 passes from
untrusted wrapper metadata. The normal native policy now admits at most 256 MiB,
eight passes, and four lanes. Wasm admits the portable writer profile only:
64 MiB, three passes, one lane. Neither profile lowers the 64 MiB / three-pass
security floor. Writers remain Argon2id version 0x13 with that portable profile.

`KdfPolicy::inspect` is metadata-only and returns checked memory/work estimates.
Wrapper salt, nonce, and wrapped-key encoded sizes and decoded shapes are checked
before Argon2 is constructed. A hostile record cannot choose a more permissive
policy through serialization.

Native offline migration tooling can display `inspect_legacy_kdf` diagnostics,
obtain explicit confirmation for a bounded resource budget, construct
`OfflineMigrationBudget`, and call `migrate_password_wrapper_offline`. That API
rewraps under the portable writer profile without returning the root key. It is
not exported on Wasm. Normal network-facing unwrap never uses the migration
budget. Incompatible legacy records remain unchanged on refusal; operators must
back up ciphertext and verify the migrated wrapper before replacing a record.

Validation: `cargo +1.88.0 test --offline -p opensesame-human-vault --all-targets`
and scoped all-target Clippy with warnings denied passed. Regression coverage
includes profile boundaries, integer-overflow diagnostics, absent migration
confirmation, malformed pre-hash fields, and migration key preservation.
This is focused validation, not a claim of whole-repository scanner completion.
