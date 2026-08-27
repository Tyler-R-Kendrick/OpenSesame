# Authentication service parity

Validated against the current official
[Passwordless.dev concepts](https://docs.passwordless.dev/guide/concepts),
[backend API](https://docs.passwordless.dev/guide/api), and
[admin application](https://docs.passwordless.dev/guide/admin-console/applications)
documentation on 2026-08-26.

| Capability | OpenSesame implementation | Proof |
|---|---|---|
| WebAuthn registration and backend token issuance | Identity public/private APIs; shown-once registration tokens | control-plane API and browser tests |
| Autofill, discoverable, alias, and user-ID sign-in | shared browser SDK and authentication core | auth-upstream mode test; PWA selector |
| Real FIDO2 verification | SimpleWebAuthn with exact RP ID, origin, challenge, UV, and counter binding | `test:authentication-browser` uses Chromium virtual authenticator without verifier mocks |
| Manual authentication tokens and magic links | one-time result store plus existing SMTP/dev-outbox mailer | control-plane API lifecycle test |
| Alias replacement and privacy | normalized aliases, SHA-256 at rest by default, optional visible aliases | core and API tests |
| Credential list, rename, and revoke | backend API plus PWA administration | control-plane API/PWA tests |
| Sign-in, step-up, and custom policies | per-purpose TTL, user-verification rule, and credential hints | core options and API/PWA policy controls |
| Multiple backend API keys | unlimited create, lock, unlock, and locked-delete; hashes only | API lifecycle test |
| Applications, users, administrators | personal or organization applications; existing owner/admin membership | tenant-fenced API test |
| Application and organization event logs | existing tamper-evident audit chain, filtered by app or organization | API lifecycle test |
| Unlimited/self-hosted use | no billing or quota checks; standard Identity API/Pages/Postgres deployment | source inspection and operator guide |
| PWA access | full admin console and same-origin WebAuthn playground in Pages | Pages component test and browser proof |

Security differences are intentional: authentication results and magic links are
single-use; API secrets are never retained for seven days or returned again; and
hashed aliases are not disclosed in the admin user response.

Focused proof:

```bash
pnpm --filter @opensesame/auth-upstream test -- authentication-service.test.ts
pnpm --filter @opensesame/database test -- authentication-service-store.test.ts
pnpm --filter @opensesame/control-plane test -- authentication-service.test.ts
pnpm --filter @opensesame/pages test -- AuthenticationSection.test.tsx
pnpm --filter @opensesame/control-plane test:authentication-browser
```

The browser proof may set `OPENSESAME_TEST_CHROMIUM_PATH` to a locally installed
Chromium executable. It binds a loopback server, so restricted sandboxes must
grant loopback/browser execution.
