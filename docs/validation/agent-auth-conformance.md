# AgentAuth conformance matrix

Runtime metadata is authoritative. This table maps auth.md / RFC behavior to
OpenSesame implementation and tests.

| Requirement | Implementation | Test | Status |
| --- | --- | --- | --- |
| anonymous registration | `registerAnonymous` | `apps/control-plane/src/__tests__/agent-auth.test.ts` | enabled |
| service_auth | `registerServiceAuth` | same | enabled |
| identity_assertion / ID-JAG | `registerProviderAssertion` + `verifyProviderIdJag` | `AgentAuth provider ID-JAG` | enabled only with trusted providers |
| identity_assertion unadvertised by default | `providerAssertionIsAdvertised` | `advertises only enabled AgentAuth capabilities` | default off |
| JWT-bearer exchange (RFC 7523) | `exchangeJwtBearer` | agent-auth.test.ts | enabled |
| claim grant | `pollClaimGrant` | agent-auth.behavior.test.ts | enabled |
| RFC 7009 revoke | `POST /oauth2/revoke` | agent-auth.test.ts | enabled |
| RFC 9728 PRM | `/.well-known/oauth-protected-resource` | agent-auth.test.ts | enabled |
| RFC 8414 AS metadata + agent_auth | `/.well-known/oauth-authorization-server` | agent-auth.test.ts | enabled |
| /auth.md from capabilities | `renderAuthMd` | characterization snapshots | enabled |
| SET / provider events | none | discovery omits `events_endpoint` | not advertised |
| first-link no email join | `interaction_required` + claim block | `does not auto-bind by verified email` | enabled |
| auth_time freshness | `login_required` | `rejects a stale auth_time` | enabled |
| untrusted issuer | `issuer_not_enabled` | `rejects an untrusted issuer` | enabled |
| ID-JAG ≠ service assertion | typ checks | assertion.test.ts + token confusion | enabled |
| replay (issuer, jti) | `consumeProviderAssertionReplay` | repo + ID-JAG tests | enabled |
| pairwise act.sub | `encodeActSubject` | characterization | enabled |
| no refresh_token | token responses | agent-auth.test.ts | enabled |
