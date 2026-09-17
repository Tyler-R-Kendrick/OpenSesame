# ADR 0125 — Ambient SSO and safe default-account sessions

## Status
Accepted

## Context

Opening OpenSesame on a configured deployment should be able to establish an
account session from an existing trusted identity-provider or device SSO
session without credential entry, and when policy permits, without a sign-in
click. Credential-free authentication, interaction-free authentication,
restoring a session, selecting an account, linking identities, organization
enrollment, and decrypting a vault are different operations.

Pages is a static public client (ADR 0090). The existing federation stack
(`federation.ts`) used a single-slot PKCE record consumed before error-state
validation, and `FederationReturn` always adopted/linked. Ambient completion
must not enter those mutation paths.

## Decision

1. **Immutable intent.** Every transaction stores `ambient` | `sign-in` |
   `switch-account` | `reauthenticate` | `attach-account` | `join-organization`
   before leaving the app. Intent is recovered by state correlation, never
   inferred from the callback URL.

2. **Policy.** Automatic acquisition is disabled by default. It is eligible
   only for a deployment-selected concrete provider/tenant or a returning-user
   opt-in bound to a provider connection key. Last-method memory is not consent.
   Resolution is pure and performs no network I/O.

3. **Transactions.** Versioned records keyed by unguessable state carry nonce,
   PKCE verifier, issuer, client, redirect, policy revision, and generation.
   Success and error callbacks must match before consume. Uncorrelated
   `error=login_required` cannot erase another login. Legacy pending records
   without timestamps/intent cannot be used as ambient.

4. **Verification.** Fresh ambient OIDC reuses `verifyBrowserIdToken` /
   `verifyBrowserIdTokenClaims` (signature, exact issuer/audience, nonce,
   required claims, 10-minute age, `azp`, bounded JWKS). Restoration uses
   `verifyRestoredBrowserIdToken` without nonce or the 10-minute new-token
   rule. Mutable JSON cannot independently authenticate.

5. **Entra.** Lazy-loaded `@azure/msal-browser` 5.22.0. Same-origin redirect
   bridge at `auth/redirect.html` calls only `broadcastResponseToMainFrame`.
   The bridge is not served with COOP. `getAllAccounts()[0]` is never an
   authentication decision. Scopes are `openid` only.

6. **Admission.** Ambient completion may resume `(issuer, subject)` or create
   an isolated empty workspace where JIT is permitted. It must not call
   `adoptFederatedIdentity`, `link-identities`,
   `claimProvisionalHistoryAccounts`, `joinOrgTenant`, or
   `openVaultAfterSignIn`. A locked vault stays locked.

7. **Exit.** Sign-out increments auth generation and records suppression
   before network/SDK work, then cancels transactions. Suppression survives
   reload and new same-origin tabs.

8. **Shoo.** Dialect unchanged. Automatic acquisition is unsupported.

Hermetic case IDs (POL-DEFAULT, POL-ENTERPRISE, OIDC-*, ID-*, LIFE-*, PROVIDER-*, WEB-BRIDGE, REG-EVIDENCE) are mapped in `docs/validation/ambient-sso.md` and `docs/evidence/2026-09-17-ambient-sso/evidence.json`.

## Consequences

Pages startup classifies callbacks before auto eligibility. Default personal
static origin makes no IdP request. GitHub Pages cannot emit COOP/CSP;
operators on header-capable hosts should exclude the bridge from COOP.
Live PRT/Windows device SSO is an environmental prerequisite, not proven by
hermetic tests.

## Rejected alternatives

- Inferring a principal from a Chrome profile name or `getAllAccounts()[0]`
- Treating Shoo as Google / FedCM
- Using the TLS-only direct-token path as a general ambient fallback
- Moving all pending records to sessionStorage (breaks installed PWA handoff)
- Global upstream logout as local sign-out
