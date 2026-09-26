# @opensesame/ceremony-kit

UI-independent ceremony logic shared by every surface that runs one: Pages
(through `@opensesame/app-core`), the Identity API's link builder and the QR
encoder. It
builds and parses the canonical cross-device interaction link, drives an
interaction (resolve, read, approve, deny), renders a display-safe summary,
approves a device-authorization request, and holds a claim bearer between
ceremony steps. Pure logic: no React, no storage of its own, no ambient
`fetch`.

## Where it fits

- **Used by:** [`packages/app-core`](../app-core) (Pages' device approval, claims,
  interaction approval and authorization-request review),
  [`packages/control-plane`](../control-plane) (ceremony links, ADR 0140) and
  [`packages/qr`](../qr).
- **Builds on:** [`@opensesame/os-domain`](../os-domain) (interaction types and
  `FORBIDDEN_URL_PARAMS`).
- An interaction link carries exactly one thing, an opaque interaction
  reference, and the reference authorizes nothing. The builder refuses to emit
  anything else and the parser refuses anything but the canonical shape.
- The interaction client echoes the request digest it was shown and never
  hands over a proof. The approval model freezes the first digest shown,
  refuses a changed or missing one before any call, begins an activation
  naming that digest and the verb, and approves naming only the activation it
  began (ADR 0084).
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
| Interaction client (`interaction-client.ts`, errors in `interaction-error.ts`) | `createInteractionClient` (an optional `resolveFetch` keeps the link's resolve free of a session), `InteractionError` (`.declared` keeps the body's code as a key, never as text) |
| Interaction approval (`interaction-approval.ts`) — the one ceremony model, from mobile MFA (ADR 0140 plan step 5): load → review → activate → decide → outcome, over an injected client and `InteractionAuthenticator` port | `createInteractionApproval`, `InteractionStepUpError`, `STEP_UP_WORDS` |
| Authorization-request review (`approval-review.ts`) — from the ceremonies app (ADR 0140 plan step 6): load → review → decide or report → outcome over an injected client and the same `InteractionAuthenticator` port; freezes the digest and the policy digest shown, refuses a challenge minted under another policy before any passkey, settles naming only the activation it began | `createApprovalReview` |
| Authorization-request client (`authorization-request-client.ts`) — list, read, requirement, activation begin/complete, approve/deny, report; views keep only the fields they name | `createAuthorizationRequestClient`, `readAuthorizationRequest` |
| Approval words and copy (`approval-words.ts`, `approval-copy.ts`) — refusals worded by the body's error code, then the status; reason codes, risk classes and channels as sentences | `approvalRefusal`, `approvalWords`, `ApprovalError`, `requirementSentences`, `riskSentence`, `channelLabel`, `channelName`, `assuranceSummary`, `needsCeremony`, `describeDetail`, `APPROVAL_WORDS` |
| Interaction outcomes (`interaction-outcome.ts`) — endings, the approval view, and refusals worded by the body's error code, then the status | `OUTCOME_TEXT`, `OUTCOME_MARK`, `OUTCOME_IS_REFUSAL`, `outcomeOfStatus`, `chooseMechanism`, `viewOf`, `interactionRefusal`, `INTERACTION_WORDS` |
| Interaction arrival (`interaction-arrival.ts`) — what an address opened on, and the address to put in its place | `readInteractionArrival` |
| Summary (`interaction-summary.ts`) | `renderInteractionSummary` |
| Device approval (`device.ts`) — the one implementation (ADR 0140 D3), worded by the body's error code, then the status | `approveDevice`, `deviceApprovalWords`, `CeremonyRequestError` |
| Claim bearer (`claim-stash.ts`) | `createClaimStash` over an injected `StashStorage`; optional stricter reading (`maxAgeMs`, `acceptToken`) |
| Claim link (`claim-link.ts`) — claim or drop, dispatched once | `readClaimLink`, `isClaimToken`, `fragmentCarriesBearer` |
| Claim and drop refusals (`claim-words.ts`) — worded by the body's error code, then the status | `claimRefusal`, `dropRefusal` |
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
