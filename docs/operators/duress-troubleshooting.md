# Operator guide — duress troubleshooting

**Audience:** owners and support diagnosing enrollment or activation failures.
Fail closed: unsupported paths are labeled unsupported — never “fixed” by
stubbing success.

Companion: [duress-profiles.md](./duress-profiles.md).

## Missing WebAuthn PRF

**Symptoms:** `prf_and_code` will not reach `verified_ready`; UV succeeds but
enrollment/activation refuses; AT-023-class failure.

**Checks:**

1. Authenticator and browser must expose PRF for this RP ID / origin.
2. UV-only success is **not** PRF and must not silently fall back to code-only
   while claiming two-input crypto (INV-07, INV-08).
3. Domain / RP ID changes do not migrate PRF credentials — enroll a
   replacement method before losing the last path (see vault key protection).

**Workaround:** use `application_code` or `verified_uv_then_code` only with
honest weaker claims, or enroll a different verified protector.

## Missing durable storage

**Symptoms:** readiness `durableStorage` ≠ `verified_ready`; arming blocked
(INV-30); undurable_storage compiler diagnostic.

**Checks:**

1. Private browsing / ephemeral profiles often lack durable origin storage.
2. Storage eviction or quota pressure can drop sealed activation data.
3. Multi-profile browser containers are different origins — do not assume
   shared enrollment.

**Action:** move to a durable install (installed PWA / normal profile),
re-verify offline assets, re-rehearse, then arm.

## Expired or unapproved alert route

**Symptoms:** `unapproved_route`; alert assurance `configured` but not
`verified_ready`; first activation would have prompted for permission
(forbidden — INV-27 / ALERT-D).

**Checks:**

1. Route must be enrolled, recipient-consented, and tested **before** arming.
2. Expiry / revocation of route or receiver yields bounded failure — never
   unconfigured deletion (INV-17).
3. Queued ≠ delivered ≠ recipient-received ≠ human-acknowledged (INV-16).

## Closed or unauthorized peer

**Symptoms:** quarantine / lost-device peer effect failed or rejected; AT-060
reachability without delegation.

**Checks:**

1. Peer needs a bound OpenSesame operation delegation, not merely network
   presence.
2. Substituted URL, audience, recipient key, expired delegation, or scope ⇒
   strict rejection (no arbitrary webhooks — INV-26).
3. After device quarantine, old agent grants must not newly lease (INV-10).

## Unavailable provider revocation

**Symptoms:** provider effect `unsupported` / `failed` / `completion_unknown`.

**Checks:**

1. Only real adapters may claim revoke success (INV-12). Missing adapter ⇒
   explicit unsupported, not a green stub.
2. Local removal without invoking a provider must **not** claim third-party
   sessions were revoked.
3. Even a successful scoped revoke does not prove all derivative sessions
   everywhere are dead — disclose residual.

## Incompatible app / older client

**Symptoms:** `unsupported_profile_version`; feature-off build ignores or
refuses duress documents; AT-086-class.

**Checks:**

1. Unsupported critical format ⇒ fail closed; no legacy unrestricted unlock
   fallback (INV-29).
2. Shared-origin demo vs dedicated-origin deployments advertise different
   capability labels — read the deployment honesty labels (AT-100 class).
3. Service worker / asset mismatch ⇒ not falsely marked ready (INV-30).

## Partial removal failure

**Symptoms:** removal interrupted; some resources gone; outbox retained;
receipt shows `failed` or `completion_unknown`.

**Checks:**

1. Removal is **exact-scope** and crash-resumable toward the enumerated set
   (INV-22, INV-31). Unrelated origin data must remain.
2. Alert delivery / outbox failure during removal does **not** escalate to
   unconfigured wipe (INV-17, AT-053).
3. Shared root with non-selected projects ⇒ refuse until independent migration
   or expanded owner consent (AT-077 / INV-05).
4. Inspect attachments, indexes, caches, and export staging for in-scope
   leftovers; record failed/retained/outside-control items honestly — do not
   claim forensic erasure.

## Activation was conspicuous / permission prompt appeared

**Unexpected permission prompt, toast, sound, or analytics spike at trigger
time** is a defect relative to INV-27. Disarm if safe, capture redacted
evidence under `docs/evidence/2026-09-21-duress/browser/`, and file via the
owning swarm (SETTINGS / ALERT / BUILD) — do not “fix” by disabling
accessibility.


## Peer receiver (optional daemon)

**Default:** off. Enable only on a trusted host with an operator token.

**Required env when `OPENSESAME_DURESS_PEER_RECEIVER=1`:**

1. `OPENSESAME_DURESS_PEER_PUBLIC_KEY_SPKI_B64` — enrolled peer ECDSA P-256
   public key (SPKI DER, standard base64). Missing key ⇒ daemon refuses to start.
2. Operator auth on `/v1/duress/peer/health` and `/v1/duress/peer/envelope`
   (`X-OpenSesame-Operator` / Bearer) — same fence as other operator routes.
3. Optional: `OPENSESAME_DURESS_PEER_AUDIENCE` (default `local-daemon`).
4. Optional: `OPENSESAME_DURESS_PEER_TAILSCALE_EVIDENCE` — **evidence only**,
   never vault authority.

**Checks:**

1. Unsigned or wrong-key envelopes ⇒ `unavailable_authority` (never structural accept).
2. Replay of a used nonce ⇒ `ambiguous_trigger`.
3. Tailscale whois must not appear as authorize/decrypt authority in health JSON
   (`vaultAuthorityFromTailscale: false`).

## Still stuck

1. Export **policy preview** (no trigger secrets) and compiler diagnostics.
2. Confirm feature flag / enrollment manifest `armed` vs import `enabled`.
3. Run local `pnpm --filter @opensesame/pages` duress verify scripts when
   BUILD has published them; attach `verification.json` outcomes (COORD fills
   results — do not invent pass marks).
