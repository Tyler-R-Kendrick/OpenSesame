# example-static-agent

A backendless static origin that advertises OpenSesame as its authorization
server (ADR 0092). No client secret, no token-exchange route, no application
server.

```bash
pnpm --filter @opensesame/example-static-agent dev
```

Agents fetch `/auth.md` and `/.well-known/oauth-protected-resource`, then call
the hosted Identity API (`:8788`). This origin is a public client: Authorization
Code + PKCE for humans, AgentAuth registration for agents. No client secret is
shipped in this bundle.

Provider ID-JAG (`identity_assertion`) is accepted only when the Identity API
has trusted agent providers configured (ADR 0093). SET events are not advertised.
