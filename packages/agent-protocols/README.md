# @opensesame/agent-protocols

Agent-facing protocol adapters for the Identity plane. It renders the
`auth.md` document and agent card an agent reads to register, issues and
verifies OpenSesame's service-signed agent identity assertion (`os-sia+jwt`),
verifies a provider's ID-JAG (`oauth-id-jag+jwt`), and ships a small client for
the agent registration, claim, token and revoke routes.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane) (serves the
  documents and verifies assertions) and [`examples/agent`](../../examples/agent)
  (the client side).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) for JSON guards and
  `jose` for JWT signing and verification.
- The service assertion and the provider ID-JAG are distinct token types with
  distinct `typ` headers; the ID-JAG verifier accepts only ES256, RS256 and
  PS256.

## Surface

| Area | Exports |
|---|---|
| Documents (`render.ts`) | `renderAuthMd`, `renderAgentCard`, `advertisedIdentityTypes` |
| Service assertion (`assertion.ts`) | `issueServiceAgentIdentityAssertion`, `verifyServiceAgentIdentityAssertion`, `peekAssertionTyp`, `publicKeyFromJwk` |
| Provider ID-JAG (`id-jag.ts`) | `verifyProviderIdJag`, `isIdJagAssertionType` |
| Client (`client.ts`) | `createAgentAuthClient({ authorizationServer, fetch? })` |
| Constants (`constants.ts`) | Grant types (`JWT_BEARER_GRANT`, `AGENT_CLAIM_GRANT`), `typ` values, `AUTH_MD_PROFILE` (`workos-auth.md/v0.6.0`), `ID_JAG_DRAFT`, and the route paths `/agent/identity`, `/agent/identity/claim`, `/agent/identity/claim/complete`, `/oauth2/token`, `/oauth2/revoke`, `/claim`, `/login` |
| Errors and hints | `AgentAuthError`, `agentAuthError`, `normalizeLoginHint`, `isEmailLoginHint` |

## Develop

```bash
pnpm --filter @opensesame/agent-protocols test
pnpm --filter @opensesame/agent-protocols typecheck
```

`src/render.test.ts` snapshots the rendered documents
(`src/__snapshots__/`); update the snapshot only when the change to `auth.md`
is intended.

## Related

- [ADR 0092](../../docs/adr/0092-auth-md-agent-registration.md) — `auth.md`
  agent registration
- [ADR 0124](../../docs/adr/0124-agent-auth-provider-id-jag.md) — provider
  ID-JAG
