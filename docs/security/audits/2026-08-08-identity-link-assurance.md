# Audit tick 36 — self-asserted identity links promoted principals to `verified`

Date: 2026-08-08
Scope: `apps/control-plane/src/routes/principals.ts`

## Scanners

| Check | Result |
|-------|--------|
| semgrep (ERROR+) | CLEAN |
| ast-grep | CLEAN |
| cargo-audit (379 crates) | CLEAN |
| cve-lite | CLEAN |
| Residual review | `link-identities` trusted the caller's identity assertion and leaked the bound principal id |

## Findings fixed

### 1. Assurance escalation via `POST /v1/principals/link-identities` (high)

The route took `kind`, `issuer`, `subject` and `assurance` straight from the
request body. Nothing in the request proves the caller controls that upstream
identity — and on success a provisional principal was promoted:

```ts
state: "active",
assurance: parsed.data.assurance === "provisional" ? "verified" : parsed.data.assurance,
verifiedAt: now,
```

So any anonymous caller could mint a provisional principal, POST
`{issuer: "https://accounts.example", subject: "anything", assurance: "verified"}`,
and become `verified` — which is exactly the gate that gutted-by-design checks
rely on for creating organizations, projects and OAuth client registrations (and,
after tick 35, for mutating clients). Unlike the stub TOTP factor and the stub
passkey path, this seam had no dev gate at all.

Fix: the route now requires `ctx.config.allowDevDefaults`, mirroring
`/v1/mfa/totp/enroll`. Outside dev it answers `403
identity_link_requires_upstream`, so a real deployment must complete an upstream
authentication ceremony before an identity can be bound.

### 2. Collision response disclosed the bound principal id (low)

The `409 identity_collision` body echoed `boundPrincipalId`, letting any caller
probe an upstream identity tuple and learn which principal owns it. The field is
removed (it had no consumers anywhere in the repo).

## Verification

- `pnpm --filter @opensesame/control-plane test` — new case asserts the 403 in
  non-dev config, that the principal stays `provisional`, and that a dev-mode
  collision response does not contain the other principal's id.
- `pnpm run test:all` and `pnpm run build` green.
