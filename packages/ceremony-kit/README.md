# @opensesame/ceremony-kit

UI-independent ceremony logic shared by every surface that runs one: the
standalone ceremonies app, the console, mobile MFA and the QR encoder. It
builds and parses the canonical cross-device interaction link, drives an
interaction (resolve, read, approve, deny), renders a display-safe summary,
approves a device-authorization request, and holds a claim bearer between
ceremony steps. Pure logic: no React, no storage of its own, no ambient
`fetch`.

## Where it fits

- **Used by:** [`apps/ceremonies`](../../apps/ceremonies),
  [`apps/console`](../../apps/console), [`apps/mobile-mfa`](../../apps/mobile-mfa)
  and [`packages/qr`](../qr).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (interaction types and
  `FORBIDDEN_URL_PARAMS`).
- An interaction link carries exactly one thing, an opaque interaction
  reference, and the reference authorizes nothing. The builder refuses to emit
  anything else and the parser refuses anything but the canonical shape.
- The interaction client echoes the request digest it was shown and never
  hands over a proof.
- Approving a device grants a short-lived client session; it does not transfer
  ownership. That is the claim ceremony, kept apart by ADR 0009.
- Origin, fetch and bearer storage are parameters; each app keeps its own JSX.
- Every ceremony path comes from `spec/config/ceremony-routes.json`
  (ADR 0139, ADR 0140 §3): `pnpm --filter @opensesame/ceremony-kit
  generate:routes` rewrites `src/ceremony-routes.generated.ts`, and
  `ceremony-routes.test.ts` fails when the two disagree.

## Surface

| Area | Exports |
|---|---|
| Ceremony routes (`ceremony-routes.ts`, generated from `spec/config/ceremony-routes.json`) | `CEREMONY_ROUTES`, `ceremonyPath`, `matchCeremonyPath`, `ceremonyRoutePrefix`, `LEGACY_LINKS`, `invokeKind`, `isAuthenticatorInvocationKind` |
| Authenticator hand-off (`authenticator-invocation.ts`) | `parseAuthenticatorInvocation`, `AuthenticatorInvocationError` |
| Interaction links (`interaction-url.ts`) | `buildInteractionUrl`, `parseInteractionUrl`, `parseLegacyInteractionLink`, `isInteractionRef`, `assertNoForbiddenParams`, `InteractionLinkError` |
| Interaction client (`interaction-client.ts`) | `createInteractionClient`, `InteractionError` |
| Summary (`interaction-summary.ts`) | `renderInteractionSummary` |
| Device approval (`device.ts`) | `approveDevice`, `CeremonyRequestError` |
| Claim bearer (`claim-stash.ts`) | `createClaimStash` over an injected `StashStorage` |
| Deep links (`deep-link.ts`) | `readFragmentToken`, `scrubFragment`, `parseUserCode` |

## Develop

```bash
pnpm --filter @opensesame/ceremony-kit test
pnpm --filter @opensesame/ceremony-kit typecheck
```

## Related

- [ADR 0086](../../docs/adr/0086-wallet-native-interaction-layer.md) — the
  wallet-native interaction layer
- [ADR 0045](../../docs/adr/0045-hosted-ceremony-pages.md) — hosted ceremony
  pages
- [ADR 0009](../../docs/adr/0009-claims-vs-device-auth.md) — claims versus
  device authorization
