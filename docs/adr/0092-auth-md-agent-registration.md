# ADR 0092 — auth.md AgentAuth registration as a profile over OpenSesame identity

## Status
Accepted

## Context

WorkOS publishes [auth.md](https://github.com/workos/auth.md) (v0.6.0 as of 2026-06-10), an ecosystem protocol — not an IETF RFC — for agents to discover how to register at a service, optionally involve a human claim ceremony, and obtain OAuth access tokens. Complementary input evidence is the IETF ID-JAG draft (`draft-ietf-oauth-identity-assertion-authz-grant-04`).

OpenSesame already has canonical principals, provisional identity, a claim engine, pairwise subjects, oidc-provider, policy, audit, and a static RP. AgentAuth must be an adapter over those systems. Better Auth remains upstream human authentication (ADR 0008). A WorkOS/Auth0 user id must never become the canonical principal.

## Decision

1. **Canonical identity stays an OpenSesame Principal.** `AgentRegistration` is a separate delegated actor (`areg_…`). `ExternalIdentity` remains a mapping. A service-signed identity assertion (`typ: os-sia+jwt`) is distinct from a provider ID-JAG (`typ: oauth-id-jag+jwt`), from product claim tokens (`osc_clm_…`), from provisional bearers (`pst_…`), and from access tokens (`aat_…`).

2. **Ownership model.** Anonymous registration mints a provisional principal P and a registration owned by P. Claiming binds the registration to the authenticated principal Q:
   - If Q is P after an in-place promotion, principal id is unchanged (existing OpenSesame property).
   - If Q is already a durable principal, the registration retargets to Q. Resources created under P are not copied and principals are not merged. Email is never a join key.

3. **Enabled registration types:** `anonymous` and `service_auth`. Provider `identity_assertion` (ID-JAG) is enabled only behind explicit agent-provider trust ([ADR 0093](0093-agent-auth-provider-id-jag.md)). SET events remain disabled and unadvertised.

4. **Tokens.** Access tokens are opaque (ADR 0014) with RFC 7009 revocation. Service assertions are short-lived JWTs re-exchanged at `/oauth2/token` (RFC 7523). There is no OAuth refresh token in this flow. Claim completion revokes pre-claim access tokens and supersedes assertion version v1. Policy, not `act`, authorizes.

5. **Static topology.** A static site hosts `/auth.md` and PRM; the browser or agent calls the hosted Identity API. No client secret is embedded. Public-client OIDC (PKCE, exact-origin CORS) is unchanged.

6. **Discovery.** Runtime metadata is authoritative. `/auth.md` is generated from typed capabilities. AS metadata at `/.well-known/oauth-authorization-server` carries an `agent_auth` block listing only enabled types.

### Rejected alternatives

- WorkOS/Auth0 as the canonical identity store
- Embedding secrets in a static bundle
- Treating `pst_…` as a service identity assertion
- Email auto-link / principal auto-merge
- Widening an already-issued pre-claim bearer in place
- Advertising unimplemented provider assertions
- Replacing ADR 0008

## Consequences

Control plane mounts `/agent/identity`, `/agent/identity/claim`, `/oauth2/token`, `/oauth2/revoke`, and a service-owned `/claim` page. Existing `/v1/principals/provisional` and OIDC `/token` remain. Draft protocol names are isolated in `@opensesame/agent-protocols`.
