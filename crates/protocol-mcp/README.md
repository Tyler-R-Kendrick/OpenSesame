# opensesame-protocol-mcp

An adapter for the MCP Authorization 2026-07-28 Bearer profile on the Host /
authority plane. It pins the profile slug, accepts bearer presentation only,
checks a token's audience and a request URI against the protected resource
(path-scoped at segment boundaries, per RFC 8707), and refuses to let an inbound
MCP token be reused as a downstream credential.

## Where it fits

- **Used by:** no workspace crate or app depends on it today. It is exercised by
  its own unit tests, by `pnpm test:task-access`
  ([`scripts/test/task-security-battle-test.sh`](../../scripts/test/task-security-battle-test.sh)),
  and by the fuzz crate [`tests/fuzz/cargo`](../../tests/fuzz/cargo)
  (`mcp_authz`, `resource_match`, which call `validate_audience` and
  `validate_resource_uri`).
- **Builds on:** [`opensesame-domain`](../domain) (`ProtocolProfile`,
  `TokenPresentation`, `ProtectedResource`,
  `PROFILE_MCP_AUTHORIZATION_2026_07_28_BEARER`).
- Inbound tokens are never forwarded downstream: OpenSesame mints task-scoped
  credentials instead (`reject_inbound_token_as_downstream_credential` always
  errors).
- A request URI with userinfo, a different origin, or a path outside a
  path-scoped audience is refused.

## Surface

| Item | Role |
|---|---|
| `mcp_bearer_profile` | The pinned `ProtocolProfile` |
| `assert_mcp_bearer_presentation` | Rejects DPoP and any presentation other than bearer |
| `validate_presentation_for_profile` | Profile minimum plus the bearer-only rule; fails closed on downgrade confusion |
| `validate_audience` | Token audience must equal the resource audience |
| `validate_resource_uri` | Request URI must fall inside the resource audience |
| `reject_inbound_token_as_downstream_credential` | Always `TokenPassthroughForbidden` |
| `McpError` | `BearerRequired`, `AudienceMismatch`, `ResourceNotAuthorized`, `TokenPassthroughForbidden`, `Domain` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-protocol-mcp
pnpm test:task-access
```

A change under `crates/protocol-mcp/` maps to the `mcp_authz` and
`resource_match` targets in `pnpm audit:fuzz`.

## Related

- [ADR 0023](../../docs/adr/0023-mcp-bearer-vs-dpop.md) — MCP Bearer profile vs DPoP
- [`docs/reference/protocol-profiles.md`](../../docs/reference/protocol-profiles.md)
- [`docs/security/audits/2026-08-08-mcp-resource-scope.md`](../../docs/security/audits/2026-08-08-mcp-resource-scope.md)
