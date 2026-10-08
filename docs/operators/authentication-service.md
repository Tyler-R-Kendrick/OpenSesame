# Self-host the authentication service

The service is part of the Identity API (`/v1/authentication/*`), with a browser
client in `@opensesame/sdk-browser`; there is no paid service or separate native
daemon.

```bash
pnpm install
export DATABASE_URL=postgres://user:password@postgres/opensesame
pnpm db:migrate    # exits 1 without DATABASE_URL
OPENSESAME_PUBLIC_URL=https://identity.example.com \
OPENSESAME_ISSUER=https://identity.example.com \
OPENSESAME_SMTP_URL=smtps://user:password@smtp.example.com \
pnpm --filter @opensesame/control-plane start
```

With an Identity session whose principal is verified, create an application for
each relying party with `POST /v1/authentication/applications`: a display name,
its exact RP ID, its origins (HTTPS, or loopback HTTP, matching the RP ID) and,
optionally, an organization you administer. The response carries the
application's `osa_` API secret once; copy it into that application's backend
secret store. Pages does not draw an Authentication service screen in this
checkout.

The relying-party frontend imports `createAuthenticationClient` from
`@opensesame/sdk-browser`; its backend presents the `osa_` secret as a bearer to
create `ort_` registration tokens and to exchange `ost_` sign-in results through
`/v1/authentication/backend/*`. Never put an `osa_` secret in browser code, PWA
storage, URLs, or logs.

A WebAuthn ceremony runs on the origin named by the application's RP ID, so a
custom application runs the same shared SDK on its own origin.
