# ADR 0014 — Opaque access tokens by default

## Status
Accepted

## Decision
Downstream access tokens are opaque by default (oidc-provider). JWT access tokens only when a documented resource-server case requires them. Upstream IdP tokens are never accepted as OpenSesame access tokens and are not persisted after identity mapping unless a future Connection is explicitly consented.

## Consequences
Introspection/userinfo for trusted clients; RPs validate via introspection or userinfo as configured; JWKS still used for ID tokens.
