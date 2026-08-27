# Self-host the authentication service

The service is part of the Identity API and Pages PWA; there is no paid service
or separate native daemon.

```bash
pnpm install
pnpm db:migrate
OPENSESAME_PUBLIC_URL=https://identity.example.com \
OPENSESAME_ISSUER=https://identity.example.com \
DATABASE_URL=postgres://user:password@postgres/opensesame \
OPENSESAME_SMTP_URL=smtps://user:password@smtp.example.com \
pnpm --filter @opensesame/control-plane start
```

Publish `apps/pages` through the existing Pages deployment with
`PAGES_IDENTITY_API=https://identity.example.com`, connect Identity, and open
**Authentication service**. Create an application for each relying party with
its exact RP ID and HTTPS origins. Copy each shown-once `osa_` API secret into
that application's backend secret store.

The relying-party frontend imports `createAuthenticationClient` from
`@opensesame/sdk-browser`; its backend creates `ort_` registration tokens and
exchanges `ost_` results through `/v1/authentication/backend/*`. Never put an
`osa_` secret in browser code, PWA storage, URLs, or logs.

The PWA can run the playground ceremony only for an application whose RP ID and
origin match the PWA host. This is a WebAuthn origin guarantee, not a platform
limitation: custom applications run the same shared SDK on their own origin.
