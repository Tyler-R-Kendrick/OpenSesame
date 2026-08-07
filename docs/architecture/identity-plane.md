# Identity plane — architecture

OpenSesame is a **dual-plane** product (ADR 0007):

| Plane | Stack | Role |
|-------|--------|------|
| **Identity** | Node.js / TypeScript / pnpm | Principals, claims, OIDC issuer, console, SDKs |
| **Authority** | Rust / Cargo | ConnectionRef, broker, OpenBao/OpenFGA, WASM host |

```text
Relying Party / CLI / Agent
        |
        | OIDC / device / claim
        v
  control-plane (:8788)
        |
        +-- Better Auth (upstream) + mock IdP (:9090)
        +-- oidc-provider (downstream issuer)
        +-- ClaimEngine / provisional principals
        |
        v  (future)
  authority gateway (:8787) — ConnectionRef invoke
```

Canonical **Principal.id** is owned by OpenSesame identity plane — never Better Auth user id, never email, never provider subject.

Downstream **sub** is pairwise per sector (ADR pairwise). Claim protocol ≠ device authorization.
