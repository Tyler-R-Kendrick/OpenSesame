# ADR 0118 — Device-native Identity host

- Status: Accepted
- Date: 2026-09-15

## Context

ADR 0090 requires the static Pages app to be complete without a backend.
Browser-local IAM already covers people, agents, applications and SIOP on the
device. Vault secret types (password, note, card, file, drop, …) live in the
tomb. What still failed closed when Settings had no Identity URL was every
caller of `identityBase()` / `identityFetch` / `ensureIdentitySession` —
drops, provisional sessions, Access Sites probes — with a "No Identity API"
refusal even though the tab could have answered itself.

A one-off local branch inside drop transport fixed only drops and taught every
other identity surface to keep special-casing emptiness.

## Decision

When Settings `identityApi` is empty, Pages **is** the Identity plane:

1. `identityBase()` resolves to this Pages origin (device-native issuer URL).
2. `identityFetch` / provisional mint / revoke / `/me` / health route through
   an in-tab `deviceIdentityFetch` router — never the network.
3. A configured remote Identity API remains an **override**: Settings wins,
   device mode is off, and every call hits that URL as today.
4. Surfaces that truly need a networked broker (email/SMS MFA codes, magic
   link, federated session adopt, org tenant discovery by domain/slug, hosted
   OAuth Sites *registration*/rotate/revoke, Host/approval WebAuthn ceremony
   popups, BYO federated callback URIs, Identity › People/Agents against the
   control-plane directory) ask `isRemoteIdentityConfigured()` /
   `useIdentityConfigured()` (same meaning) and keep showing browser-local
   panels — they do not pretend the device host is a remote OIDC control-plane.
5. Drop claims use the same `/v1/claims*` paths as the control-plane; the
   device host backs them with the origin claim store
   (`local-drop-claims.ts`). Callers do not branch on "local vs remote".
6. Further `/v1/*` list/ensure routes are answered from browser-local IAM
   (`device-identity-local.ts`): vault projects, local directory orgs/agents,
   and local application registrations projected as OAuth clients. Active
   project uses that projects ensure/list path. Hosted Sites *registration*
   stays remote-gated in the Access UI; Identity → Applications remains the
   local registration surface. `useIdentityPlane()` means "device or remote".

## Consequences

- Empty Identity settings is a complete identity host, not an error.
- Connectivity treats device Identity as reachable ("This device"); it never
  counts as "configured and silent".
- Sign-in identifier / email-text second steps stay remote-only so the UI does
  not offer roads the device host cannot finish.
- Extending the device host is adding `/v1/*` routes to
  `device-identity-host.ts` (or wiring existing local IAM modules behind them),
  not adding more empty-base forks in feature code.

## Related

- [ADR 0090](0090-static-frontend-complete-without-backend.md)
- [ADR 0062](0062-e2ee-claim-transfer.md) (drops)
- [ADR 0116](0116-browser-native-siop-v2.md) / local IAM docs
