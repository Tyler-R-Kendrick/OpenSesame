# ADR 0059: Free, PWA-managed passwordless authentication service

Status: Accepted

## Context

Bitwarden Passwordless.dev separates an open browser client, a public WebAuthn
API, a secret-authenticated backend API, and a central admin console. Paid
capabilities include unlimited applications and administrators, event logs, and
self-hosting. OpenSesame needs the same application-authentication capability
without a per-user or per-application license and without making native apps a
requirement.

## Decision

1. The Identity API owns relying-party applications, public WebAuthn keys,
   challenges, one-time results, backend API-key hashes, and tamper-evident
   events. PostgreSQL is authoritative; memory stores implement the identical
   interfaces for tests and local development.
2. `@opensesame/auth-upstream` is the only server ceremony implementation and
   `@opensesame/sdk-browser` is the only browser ceremony implementation.
   Pages, mobile MFA, and other web targets consume those packages rather than
   copying WebAuthn code.
3. Pages exposes the administration and same-origin playground as an installable
   PWA. A custom relying party runs the shared browser SDK on its own registered
   origin because WebAuthn intentionally forbids another origin from creating
   credentials for it. API secrets remain backend-only and are shown once.
4. The service has no license-enforced limits on applications, administrators,
   users, credentials, API keys, policies, or event access. Organization owners
   and administrators use the existing organization membership plane.
5. Registration, authentication, result tokens, magic links, and challenges are
   short-lived and one-use. Magic-link tokens are deliberately one-use even
   though Passwordless.dev currently permits reuse until expiry.

## Consequences

Self-hosters deploy the existing Identity API, PostgreSQL, Pages PWA, and an SMTP
transport when magic links are enabled. Native wrappers remain optional. This
decision does not replace or narrow the OID4VP/OID4VCI wallet in ADR 0058.
