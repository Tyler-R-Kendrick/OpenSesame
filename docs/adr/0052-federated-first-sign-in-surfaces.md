# ADR 0052: Federated sign-in on the first-run and hosted-login surfaces

## Status
Accepted

> Numbering note: this ADR was drafted as "0051"; `0051-user-controlled-trust-broker-core.md`
> already held that number, so it lands as 0052. There is no ADR 0040.

## Context
ADR 0033 decided that a durable principal originates from a trusted upstream broker, and its
§4 stated the ordering plainly: "the PWA's first run asks who you are before it asks for a
master password." Neither surface a human actually meets implemented that.

The Pages PWA's first-run screen (`apps/pages/src/screens/UnlockScreen.tsx`) offered
passkey, PIN, master password and "Continue as guest" — four ways to make a *vault*, and no
way to say *who you are*. The control-plane's hosted login page, the interaction surface
oidc-provider hands a browser mid-authorization, had no upstream leg at all: it could
authenticate a principal that already existed locally, but nothing brought one into
existence from a broker assertion.

The machinery for the second gap was nominally present. `packages/auth-upstream` carries a
Better Auth factory (`createUpstreamAuth`), an upstream OIDC provider registry and a
principal mapping store, installed since ADR 0008. It has never been mounted anywhere in the
application, and on inspection it cannot carry this flow.

Meanwhile the browser-side leg (ADR 0034, `docs/architecture/federated-signin.md`) works and
is unaffected. What is missing is a *server-side* relying-party leg, on a surface that has a
server.

## Decision
1. **First run offers federated sign-in, and it creates the same ephemeral guest vault that
   "Continue as guest" does.** The Pages first-run screen gains a federated call to action
   alongside the sealing options, implementing ADR 0033 §4. Signing in federates identity; it
   does not decrypt anything. The vault is device encryption, so a broker assertion cannot
   unseal it and must not appear to: the federated path calls `vaultStore.createGuest()`, the
   human seals the device afterwards on their own schedule. Identity plane and vault plane
   stay separate — one says who showed up, the other says what this device can read — and the
   UI orders them rather than merging them.
2. **The control-plane hosted login page gains a server-side OIDC relying-party leg built on
   `openid-client`.** Two routes: `POST /interaction/:uid/federated/start` begins an
   authorization-code flow with PKCE S256 against a configured trusted issuer, and
   `GET /interaction/:uid/federated/callback` completes it and resolves a principal. The
   callback lives under `/interaction/:uid` because oidc-provider's interaction cookie is
   path-scoped there; a callback at any other path arrives without the interaction it is
   supposed to complete.
3. **Pending flow state rides in a per-interaction httpOnly cookie, and state binding makes
   tampering self-defeating.** `os.fed.<uid>` carries issuer, `state`, `nonce` and PKCE
   verifier — httpOnly, `SameSite=Lax`, `Path=/interaction/<uid>`, 600s, `Secure` when the
   public URL is https. Path scoping means one interaction's pending state is not sent to
   another. The `state` in the cookie must equal the `state` in the callback, so an attacker
   who substitutes either half breaks the pair and the exchange is refused.
4. **The relying party is a public origin-profile client and sends an explicit `Origin`
   header on the token request.** `client_id` is `origin:<origin>`, derived not registered,
   per ADR 0034 and ADR 0012's origin profile. The broker contract enforces origin equality
   on `POST /token` — see `apps/mock-upstream-idp/src/server.ts`, which answers
   `unauthorized_client` / `origin_cors_denied` when the header disagrees with the client id.
   A browser sets that header for itself; a server-side exchange must set it deliberately, so
   the RP does. When `OPENSESAME_UPSTREAM_ISSUER`, `OPENSESAME_UPSTREAM_CLIENT_ID` and
   `OPENSESAME_UPSTREAM_CLIENT_SECRET` are all three configured, the leg authenticates to
   that one issuer as a confidential client instead, and does *not* send the `Origin`
   header — a confidential client is bound by its secret, and claiming a browser origin it
   does not have would be a false assertion. The issuer is matched exactly, so a secret is
   never offered to an issuer it was not configured for, and `assertSecureConfig` refuses to
   boot when the credentialed issuer is absent from the trusted allowlist (or, in
   production, is not HTTPS). A deployment that has a secret should use it; a broker with no
   notion of one should not be made to invent one.
5. **A brand-new user's principal is minted provisional and promoted in place.** The callback
   looks the external-identity tuple up first: a hit reuses its principal, unchanged. A miss
   mints a provisional principal and immediately promotes it to `state: "active"` /
   `assurance: "verified"` with `principalId` unchanged, on the strength of the assertion just
   verified — the same promotion `POST /v1/principals/link-identities` performs. Nothing
   self-promotes: the promotion is driven by the verified assertion, never by the caller
   (ADR 0033 §3), and preserving `principalId` keeps ADR 0033 §5's rule that canonical
   identity is OpenSesame's and does not change when an identity is attached.
6. **Better Auth is not mounted for this.** `createUpstreamAuth` stays unmounted and this leg
   does not adopt it, for three independent reasons, any one of which is sufficient:
   - `toBetterAuthSocialConfig` skips every provider without a `clientSecret`
     (`packages/auth-upstream/src/oidc-registry.ts`: `if (!p.clientSecret) continue;`).
     Trusted brokers in the origin profile are public, secret-less clients by construction,
     so the exact providers this feature exists to reach are the ones it silently drops. A
     configuration that fails by producing an empty map is worse than one that fails loudly.
   - It would introduce a parallel user model. Better Auth owns its own users and sessions;
     canonical principals live in `packages/os-domain` (ADR 0007, ADR 0033 §5). Two
     competing notions of "who this is" is precisely the shape AGENTS.md forbids.
   - Nothing depends on it today. It is installed and never mounted, so declining to mount it
     removes an option rather than a behaviour.
   ADR 0008's "mature libraries over NIH protocol code" is satisfied by panva
   `openid-client`, which is the same author as the `oidc-provider` already serving the
   downstream side. The rule asks for a maintained library, not for one specific library.
7. **Direct Google without a broker remains out of scope, and is recorded as future work.**
   An OpenSesame-held Google client id cannot serve the browser-side flow at all: Google's
   token endpoint serves no CORS, so a static page cannot exchange the code, and Google emits
   `sub`, not the per-origin `pairwise_sub` the RP contract consumes. That pair of facts is
   why `shoo.dev` exists as an intermediary rather than being a convenience. The server-side
   leg decided here removes the CORS obstacle for the *hosted* surface, which makes direct
   Google feasible in future — it would still need a subject-derivation decision of its own.
   It is not part of this slice.

## Consequences
- A human meeting OpenSesame for the first time is asked who they are before being asked to
  invent a master password, which is what ADR 0033 §4 said and what neither surface did.
- Federated first run produces an unsealed device. This is deliberate and must be visible in
  the UI: a signed-in human with an unsealed vault is a normal state, not an error state, and
  sealing is a later step they choose.
- The control-plane now makes outbound HTTP to configured upstreams during an interaction. A
  deployment with no reachable broker cannot complete a hosted sign-in; per ADR 0033 that is
  the intended failure rather than a fallback to self-service. `assertSecureConfig` refuses to
  boot in production when the allowlist is empty or contains a non-https issuer, so the
  failure surfaces at start-up rather than one sign-in at a time.
- `OPENSESAME_TRUSTED_UPSTREAMS` is now load-bearing on two surfaces and is documented in
  `.env.schema`, where it had been missing entirely.
- `packages/auth-upstream`'s Better Auth factory is now explicitly dead weight rather than
  ambiguously pending. `OPENSESAME_AUTH_SECRET` and `OPENSESAME_AUTH_BASE_URL` are marked in
  `.env.schema` as holdovers read by no runtime code. Removing them is a separate decision.
- Two federated legs now exist with different trust properties — the browser passthrough of
  ADR 0034 and the server-side exchange decided here. `docs/architecture/federated-signin.md`
  carries both, and the difference is stated there rather than left to be inferred.

## Related
- ADR 0007 — dual-plane identity/authority
- ADR 0008 — Better Auth + oidc-provider (mature libraries over NIH protocol code)
- ADR 0012 — client admission modes (origin profile)
- ADR 0016 — generic OIDC upstream contract
- ADR 0033 — federated identity admission (governing ADR; §4 is what this implements)
- ADR 0034 — origin-brokered sign-in for static sites
- ADR 0050 — origin-profile issuer for zero-backend static sites
- `docs/architecture/federated-signin.md` — the wire contract, §7 for this leg
