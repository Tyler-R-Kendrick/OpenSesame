# opensesame-connection-broker

Acquires third-party authorizations and holds them in the Host / authority
plane. The vault is sealed against the server; a connection credential is
deliberately the opposite, because refresh happens while the person is absent.
Two rules bound what that costs: the credential is sealed under a deployment key
bound to its tenant, and nothing on the API boundary carries token material —
callers get a `ConnectionRef` and a status. The crate also owns the provider
catalogue, credential rotation, GitHub App provisioning, project-config secrets
and sync targets, and the connector transport.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (connection, provider,
  integration, sync, backup and certificate routes) and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`broker_seal`,
  `github_webhook_hmac`, and `connector_manifest` for `Catalog::parse`).
- **Builds on:** [`opensesame-domain`](../domain),
  [`opensesame-claims`](../claims) (delegation claim tokens),
  [`opensesame-connection-detect`](../connection-detect) (credentials already on
  a machine), [`opensesame-rotation`](../rotation),
  [`opensesame-relay`](../relay), [`opensesame-invoke-through`](../invoke-through),
  [`opensesame-task-bus`](../task-bus) and
  [`opensesame-transport-security`](../transport-security) — the broker never
  builds a TLS stack of its own.
- Egress injects sealed credentials and never returns them; credential-carrying
  uploads refuse redirects, so a token never reaches an unapproved origin.
- Sealing is XChaCha20-Poly1305 with the connection and organization ids as
  associated data: a ciphertext moved into another tenant's row does not open.
  Authorization-code flows always use PKCE S256, confidential clients included.
- A provider the deployment cannot use is reported as unconfigured, naming the
  variables it wants — not hidden, and not offered as a button that fails.

## Surface

`ConnectionBroker` is the entry point; its modules group as follows.

| Area | Modules |
|---|---|
| Catalogue and config | `catalog` (loads [`spec/connectors/catalog.json`](../../spec/connectors/catalog.json), the one integration catalog; `tests/catalog_view.rs` writes its Host API view),  `config`, `custom_provider`, `configuration`, `integration`, `scope_ceiling` |
| Acquire and hold | `flow` (PKCE), `token`, `crypto` (`seal` / `open`, `SealedBlob`), `store`, `store_backup` |
| Use | `egress`, `transport*` (connector transport and client pools, ADR 0132) |
| Rotate | `rotation`, `rotation_verify`, `rotation_egress` |
| Delegate | `delegation`, `delegation_helpers`, `delegation_lineage` |
| GitHub | `github_app` (App Manifest flow), `installation` (installation tokens), `github_webhook_hmac`, `forge_token_probe` |
| Project config | `secret_config`, `config_access`, `sync_target`, `changelog_hook` |
| Wire | `model`, `error` (`BrokerError::code()` is part of the HTTP contract) |

Environment read by `BrokerConfig`: `OPENSESAME_CONNECTION_KEY` (the sealing
key; without it credential storage is disabled), `OPENSESAME_PUBLIC_URL`
(default `http://127.0.0.1:8787`), `OPENSESAME_CONNECTION_REDIRECT_ALLOWLIST`,
and per-provider `OPENSESAME_PROVIDER_<ID>_CLIENT_ID` and related variables.

## Develop

```bash
cargo +1.88.0 test -p opensesame-connection-broker
```

Unit suites live in `src/tests/`; `tests/connector_transport_mtls.rs` runs a
real mTLS listener from `opensesame-transport-security`'s `testkit`. Every id in
[`crates/ceremony/catalog.json`](../ceremony/catalog.json) must exist in
`spec/connectors/catalog.json` (`opensesame-ceremony`'s `catalog_pact` test).

## Related

- [ADR 0032](../../docs/adr/0032-connection-broker-service-integrations.md) — the broker
- [ADR 0044](../../docs/adr/0044-claimable-connection-delegation.md) — delegation
- [ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) — web-login rotation
- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — connector mTLS
