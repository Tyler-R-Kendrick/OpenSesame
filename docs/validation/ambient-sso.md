# Ambient SSO validation

## Hermetic commands

```bash
pnpm --filter @opensesame/pages test
pnpm --filter @opensesame/sdk-browser test
pnpm --filter @opensesame/pages verify:ambient-sso
```

`verify:ambient-sso` requires a Pages `dist/` build (`VITE_BASE=/OpenSesame/`
and, separately, origin root). When `PLAYWRIGHT_CHROMIUM` is unset, the
script still asserts the MSAL bridge asset and reports the browser journey as
skipped.

## Deterministic cases

| ID | Where |
| --- | --- |
| POL-DEFAULT | `ambient-auth/policy.test.ts`, `controller.test.ts`, `verify:ambient-sso` |
| POL-ENTERPRISE | `policy.test.ts`, `controller.test.ts`, `runtime.test.ts`, `verify:ambient-sso` |
| POL-OPTIN | `policy.test.ts` |
| OIDC-ERROR-STATE | `federation.test.ts`, `transactions.test.ts` |
| OIDC-NONCE | `packages/sdk-browser/src/oidc-validation.test.ts` |
| OIDC-RESTORE | same |
| ID-LOCKED / ID-GUEST / ID-HISTORY | `admission.test.ts`, `FederationReturn.test.tsx` |
| LIFE-LOGOUT / LIFE-LOCK / LIFE-RELOAD | `admission.test.ts`, `session-exit.test.ts`, `controller.test.ts`, `verify:ambient-sso` |
| PROVIDER-SHOO / PROVIDER-SCOPES | `provider.test.ts`, `entra.test.ts`, `controller.test.ts` |
| WEB-BRIDGE | `bridge-asset.test.ts`, `opener-policy.test.ts` |

## Live-device recipe

**not run: external managed-device environment unavailable**

When an authorized Windows Entra-joined device is available:

1. Record OS, Edge/Chrome versions, `@azure/msal-browser` 5.22.0, tenant and
   SPA app registration class, CloudAP/SSO extension state, consent status.
2. Use synthetic accounts. Redact identifiers and tokens.
3. Walk: first load with deployment policy; multi-account selection;
   interaction-required / MFA; private mode; sign-out then reopen; strict
   lock; wrong-tenant refusal.
4. Do not change production Conditional Access or device management to
   manufacture a pass.

Hermetic success is not “device SSO verified” (REG-EVIDENCE).
