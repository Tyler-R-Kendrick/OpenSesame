# example-static-agent

A backendless static origin that advertises OpenSesame as its authorization
server (ADR 0092). No client secret, no token-exchange route, no application
server.

```bash
pnpm --filter @opensesame/example-static-agent dev
```

Agents fetch `/auth.md` and `/.well-known/oauth-protected-resource`, then call
the Identity API at `:8788`.
