# ADR 0093 — Provider ID-JAG AgentAuth registration behind explicit trust

## Status
Accepted

Supersedes ADR 0092 §3 only for provider `identity_assertion`. SET/provider events remain disabled and unadvertised.

## Context

ADR 0092 shipped anonymous and `service_auth` registration and left provider ID-JAG (`identity_assertion`) as an unadvertised seam until issuer allowlisting, SSRF-safe JWKS, replay, and first-link step-up existed.

auth.md (WorkOS ecosystem protocol, v0.6.0) and `draft-ietf-oauth-identity-assertion-authz-grant-04` describe an agent submitting a provider-signed ID-JAG (`typ: oauth-id-jag+jwt`) to `POST /agent/identity`. OpenSesame must verify that assertion in the provider's trust domain, then mint its own service-signed identity assertion (`typ: os-sia+jwt`). The two JWTs are not interchangeable.

Human OIDC upstreams (Better Auth, Google, WorkOS login) are a different trust job than agent-platform ID-JAG issuers. Automatically trusting every login IdP as an ID-JAG issuer would accept ID tokens as grants.

## Decision

1. **Explicit agent-provider trust list.** `OPENSESAME_AGENT_AUTH_TRUSTED_PROVIDERS_JSON` names ID-JAG issuers (issuer, audiences, algorithms, static JWKS and/or `jwksUri`, max age). `OPENSESAME_AGENT_AUTH_PROVIDER_ASSERTION_ENABLED` must also be true. Discovery advertises `identity_assertion` only when both the flag is on and at least one enabled provider is configured.

2. **Do not reuse the human federated-issuer allowlist** as the ID-JAG trust list. Login IdPs and agent platforms have different assertion types and audiences.

3. **Verification.** `verifyProviderIdJag` in `@opensesame/agent-protocols` requires `typ: oauth-id-jag+jwt`, an allowlisted alg (ES256/RS256/PS256), exact iss, aud in the provider's audience list, exp, iat, max age, jti, `auth_time` within `maxAuthAgeSeconds` (default 3600), `email_verified` or `phone_number_verified`, and a user `sub` that is not an `areg_*` registration id. Service assertions (`os-sia+jwt`) and bare JWT ID tokens are rejected. A missing or stale `auth_time` is `401 login_required`. An unknown issuer is `issuer_not_enabled`.

4. **Replay.** `(issuer, jti)` is consumed once in durable storage (`agent_provider_assertion_replays`). Insert-or-conflict is the compare-and-set.

5. **Subject resolution.** Lookup `ExternalIdentity` by `(kind: auth_md, issuer, subject)`. If present, attach the registration to that principal. If absent and a *verified* email on the ID-JAG matches another principal's verified email, return `401 interaction_required` with a claim block (first-link step-up). Completing that ceremony links the tuple to the signed-in principal; email is never a join key. Otherwise JIT-provision a new canonical principal and link the tuple.

6. **Service assertion remains OpenSesame-signed.** The provider ID-JAG is never passed through as `identity_assertion`.

7. **Signing keys.** Service assertions prefer `OPENSESAME_AGENT_AUTH_SIA_JWK` / `OPENSESAME_JWKS_JSON`. Production refuses an ephemeral process-local keypair.

8. **SET / provider events** stay unimplemented and unadvertised. There is no `/agent/event/notify` route.

## Consequences

Control plane accepts `type: identity_assertion` when trust is configured. Tests cover happy path, untrusted issuer, replay, and email non-join. ADR 0092's anonymous/`service_auth` behavior is unchanged.
