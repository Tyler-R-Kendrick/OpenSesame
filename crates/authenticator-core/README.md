# opensesame-authenticator-core

The shared security boundary for native authenticator providers, plus a
portable OTP implementation. Platform adapters (Android, iOS) own OS
registration and biometric prompts; this crate owns request classification,
verified-link validation, fresh user verification and secret-free credential
metadata, so every platform applies the same policy. It builds as an `rlib`, a
`cdylib` and a `staticlib`, and exposes a UniFFI surface behind the `ffi`
feature.

## Where it fits

- **Used by:** [`opensesame-sealed-store`](../sealed-store) (re-exports the OTP
  functions for `pass`-style `otpauth://` trailers) and
  [`apps/android`](../../apps/android), whose
  `scripts/build-core.sh` builds this crate with `--features ffi` and generates
  Kotlin and Swift bindings from it.
- **Builds on:** no workspace crates — `hmac`, `sha1`, `sha2`, `url`, `serde`,
  `thiserror`, and optionally `uniffi`.
- Native adapters translate a `PlatformInvocation` into the OS request type;
  they do not re-parse links.
- `CredentialMetadata` carries no secret: the payload stays in the encrypted
  vault item named by `encrypted_payload_ref`.
- Every provider or wallet operation needs a platform user verification from
  the same device, no older than 30 seconds.

## Surface

| Item | What it is |
|---|---|
| `validate_platform_invocation(origin, raw)` | UniFFI-exported. Validates a verified link against the authenticator origin and returns a `PlatformInvocation` (`MfaApproval`, `Oid4vp`, `Oid4vci`) with the protocol URI to hand on |
| `InvocationPolicy` | `new(origin)` accepts only a bare HTTPS origin; `validate_link(raw)`; `allow_private_request_uris` is a development-only switch |
| `require_fresh_user_verification` | Rejects missing, stale, future-dated or wrong-device verification |
| `CredentialMetadata`, `CredentialKind` (`SdJwtVc`, `Mdoc`) | What a native selection surface may show |
| `AuthenticatorError` | The closed set of refusals |
| OTP | `parse_otpauth`, `validate_otpauth`, `totp_code`, `hotp_code`, `find_otpauth_in_trailer`, `sync_trailer_otp`, `OtpUri` — Key URI Format, RFC 4226, RFC 6238 |

| Cargo feature | Effect |
|---|---|
| `ffi` | Enables `uniffi` scaffolding and derives |
| `bindgen` | `ffi` plus the `uniffi-bindgen` binary (`src/bin/uniffi-bindgen.rs`) |

## Develop

```bash
cargo +1.88.0 test -p opensesame-authenticator-core
cargo +1.88.0 build -p opensesame-authenticator-core --features ffi
apps/android/scripts/build-core.sh bindings   # regenerate Kotlin/Swift bindings
```

## Related

- [ADR 0058](../../docs/adr/0058-native-authenticator-and-openid4vc-wallet.md) —
  native authenticator and OpenID4VC wallet
- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — the
  wallet-native interaction layer
