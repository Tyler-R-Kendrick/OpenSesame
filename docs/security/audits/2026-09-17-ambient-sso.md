# Audit 2026-09-17 — Ambient SSO callback and admission boundaries

## Findings reproduced in this change

1. **Single-slot PKCE consumed before error-state validation.**
   `completeSignIn` took the pending record, then threw on `error=`. A
   forged `?error=login_required` could erase an in-flight login.
   **Fix:** `takeMatchingPending` correlates `state` before consume.
   **Test:** `federation.test.ts` OIDC-ERROR-STATE.

2. **FederationReturn always linked.** Ambient success called
   `adoptFederatedIdentity` / `openVaultAfterSignIn` / `joinOrgTenant`.
   **Fix:** immutable ambient intent dispatches to `admitAmbientSession`.
   **Test:** `FederationReturn.test.tsx`.

3. **Persisted session JSON treated as identity.** `loadSession` now
   reads JWT `exp` / `sub` / `iss` (or `pairwise_sub`) via
   `readStoredSessionSync` and ignores mutated JSON `expiresAt` / `name` /
   `sub`. Boot also calls `restoreAuthenticatedSession`. Suppression
   returns null even if the stored assertion is unexpired.
   **Test:** `session-load.test.ts` OIDC-CACHE / OIDC-RESTORE / OIDC-TIME.

4. **Automatic reentry after sign-out.** Sign-out now increments auth
   generation and records suppression before network work. Admission
   rechecks generation immediately before `saveIdentity`; a sign-out that
   lands during save rolls the write back with `clearSession` so lifting
   suppression cannot resurrect the identity.
   **Test:** `return-path.test.ts` LIFE-LOGOUT.

5. **`applyAmbientReturn` ignored admission.** Guest-open, mismatch, and
   stale-generation still stored `authenticated`. `vaultStateFromStore`
   dropped `pairwiseSub`, so unlocked-account mismatch was dead.
   **Fix:** honor `admitAmbientSession`; pass `loadSession()?.pairwiseSub`.
   **Test:** `return-path.test.ts` ID-COOKIE / ID-SAMEEMAIL.

6. **Silent iframe escalated to a top-level `prompt=none` redirect.**
   `runAutomaticAttempt` always called `beginAmbientOidc` + `location.assign`.
   **Fix:** `silent-iframe` calls `acquireEntraSilent` (MSAL `ssoSilent`) and
   never navigates. A second tab is fenced by the attempt budget.
   **Test:** `controller.test.ts` silent-iframe, LIFE-TWOTABS, LIFE-SWITCH.

## Residual environmental limits

- GitHub Pages cannot set COOP on the MSAL bridge.
- Hermetic tests do not prove PRT, Conditional Access, or real PWA storage
  isolation.
- Browser DNS/policy limitations: JavaScript cannot comprehensively detect
  DNS rebinding.

## Threat model notes

Login CSRF, mix-up, nonce replay, and account linking remain the primary
risks. Ambient intent is a distinct authorization boundary; an active cookie
cannot convert ordinary authentication into linking.
