# opensesame-provider-openbao

The OpenBao credential-authority adapter for the Host / authority plane. OpenBao
is a provider behind the `CredentialAuthority` trait, not the public domain
model: the trait creates opaque handles, uses them, issues, renews and revokes
leases, and reports health. Agents never receive `SecretRef` material through
its agent-safe paths. The crate also logs in to OpenBao with a TLS client
certificate (`auth/cert`).

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (app state, credential
  connections, health, the KV facade, transport revocation) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`openbao_response`).
- **Builds on:** [`opensesame-domain`](../domain) and
  [`opensesame-transport-security`](../transport-security), which builds the
  mTLS client profile a certificate login uses. This crate builds no TLS
  configuration of its own.
- The auth mode is explicit (`OpenBaoAuthMode`). A failed certificate login is
  an error; it never falls back to a static token.
- A certificate-login token is cached per identity — keyed by role, leaf
  thumbprint and trust generation — never globally. Revoking the certificate
  does not revoke an issued token; `OpenBaoCertAuth::revoke_token` does.

## Surface

| Item | Role |
|---|---|
| `CredentialAuthority` | `create_handle`, `use_credential`, `issue_lease`, `renew_lease`, `revoke`, `health` |
| `OpenBaoHttpAuthority` | HTTP implementation; `from_env` reads `OPENSESAME_OPENBAO_URL` and `OPENSESAME_OPENBAO_TOKEN`; `kv_put` / `kv_get` |
| `MemoryAuthority` | Local stand-in when OpenBao is not reachable (dev and tests) |
| `CredentialHandle`, `CredentialOperation`, `Lease`, `AuthorityHealth`, `AuthorityError` | The trait's value types |
| `assert_authority_base_url`, `parse_sys_health`, `handle_from_health` | URL guard and response parsing |
| `cert_auth`: `OpenBaoCertAuth`, `OpenBaoAuthMode`, `CertToken`, `CertTokenScope`, `DEFAULT_CERT_MOUNT` | Certificate login, token cache, explicit token revocation |

## Develop

```bash
cargo +1.88.0 test -p opensesame-provider-openbao
# The live certificate-auth run against the pinned `bao` binary is #[ignore]d
pnpm test:mtls:fixtures
OPENSESAME_MTLS_FIXTURES=1 cargo +1.88.0 test -p opensesame-provider-openbao -- --ignored
```

A plaintext `bao server -dev` cannot authenticate a certificate, so it is not a
proof of the `auth/cert` path; the live test starts a TLS listener that requires
client certificates.

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS and workload identity (CONN-OPENBAO)
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — authority handle and ConnectionRef
- [`docs/operators/mtls.md`](../../docs/operators/mtls.md)
