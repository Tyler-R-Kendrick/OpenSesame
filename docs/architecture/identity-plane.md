# Identity plane — architecture

OpenSesame is a **dual-plane** product (ADR 0007):

| Plane | Stack | Role |
|-------|--------|------|
| **Identity** | Node.js / TypeScript / pnpm | Principals, claims, OIDC issuer, ceremony pages, SDKs |
| **Authority** | Rust / Cargo | ConnectionRef, broker, OpenBao/OpenFGA, WASM host |

```text
Relying Party / CLI / Agent
        |
        | OIDC / device / claim
        v
  control-plane (:8788)
        |
        +-- upstream IdPs (mock IdP :9090 in dev); Better Auth for email magic-link only
        +-- oidc-provider (downstream issuer)
        +-- ClaimEngine / provisional principals
        |
        v  optional: interaction settlement drain to the Host (when configured);
        |  the Host asks back at GET /v1/principals/mapping/resolve
  authority gateway (:8787) — ConnectionRef invoke
```

Canonical **Principal.id** is owned by OpenSesame identity plane — never Better Auth user id, never email, never provider subject.

Downstream **sub** is pairwise per sector ([ADR 0011](../adr/0011-pairwise-subject-storage.md)). Claim protocol ≠ device authorization.
