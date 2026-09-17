# Host authority evaluation route inventory (GA-H-01)

Standing inventory of Host HTTP that participates in hierarchical authority
evaluation / mutation. Storage writers and OpenFGA projection stay as named in
[`storage.md`](storage.md) and [`api-surface.md`](api-surface.md).

## Evaluation path (already landed)

| Surface | Evidence |
|---|---|
| `ValidatedGrantChain` + authz decide | `cargo +1.88.0 test -p opensesame-authz --lib` |
| Broker invoke + receipt binding | `cargo +1.88.0 test -p opensesame-broker --lib` |
| Intent budget / projection helpers | `apps/gateway/src/routes/intents_*.rs` |

## Access-domain & offer HTTP

See [`api-surface.md`](api-surface.md). Contract pin:

```bash
cargo +1.88.0 test -p opensesame-gateway --bin opensesame-gateway -- routes::access_domains::tests
cargo +1.88.0 test -p opensesame-gateway --bin opensesame-gateway -- routes::grant_offers::tests
```

Router merge: `apps/gateway/src/routes/mod.rs` merges `access_domains` and
`grant_offers`; `contract.rs` includes both sources so undocumented routes fail CI.

## Grant issue HTTP

| Surface | Evidence |
|---|---|
| `POST .../grants/{grant_id}/authority` | `cargo +1.88.0 test -p opensesame-gateway --bin opensesame-gateway -- routes::local_authority_routes::authority_grants::tests` |

Records sidecar authority on an existing `grants` row (`issue_authority`). Does not insert the legacy envelope.

## Deliberately not on this inventory

- Live OpenFGA write from these routes — projectors only (GA-F-04 dry-run).
- Identity `/v1/authority/*` — Identity plane (GA-I-01).
- Offer create/list/get HTTP — storage-ready (`create_grant_offer`); activate/revoke only today.

## Status

Evaluation + AccessDomain/offer + grant-issue HTTP are inventory-complete for GA-H-01.
