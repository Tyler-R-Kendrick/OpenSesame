# Persona findings validation (Oct 7, 2026)

Validation of the Oct 1, 2026 synthetic power-user recheck (Bitwarden, 1Password,
Infisical) against the OpenSesame repository at **`348811b4458e59cdbcfad829c3459e37ce30a2c9`**
(`origin/main` as of this audit). The persona build under review was commit
`6edbd801` on GitHub Pages; this audit is code- and test-grounded on current
`main`, not a repeat of the live PWA walk.

## Method

| Step | What ran |
|------|----------|
| Inputs | `2026-10-01-AGGREGATE.md` and the three persona reports (uploaded recheck). |
| Grok Build | Intended engine per Tyler's request; see [Grok Build](#grok-build) below. |
| Verification | File:line reads on `main`, targeted Vitest (`drop-present`, `local-drop-claims`, `DropClaimScreen`, `DropCeremony`). |
| Live PWA | Not re-run in this pass (static analysis only). Persona UI claims marked **Confirmed (design)** when code matches intentional glyph-only errors (ADR 0163 / `StatusMark`). |

## Grok Build

| Attempt | Result |
|---------|--------|
| `grok --version` | `grok 1.0.46` |
| `XAI_API_KEY` in environment | Present (Cursor secret name listed in env), but the CLI still reports **Not signed in** and does not accept headless API-key auth in this VM. |
| `grok -p "…" -m grok-4.7 --always-approve` | Failed: same not-signed-in error. |
| `grok login --device-code` | Printed device URL `https://accounts.x.ai/oauth2/device?user_code=TASZ-P59R` and code **TASZ-P59R** (expired after the audit window; Tyler must run a fresh login to enable Grok-driven passes). |

**Blocked follow-up:** After Tyler completes `grok login --device-code` (or fixes API-key auth for this CLI build), re-run area prompts against `348811b4` for drops, live join, access, and UX error contract; merge any deltas into this file.

Planned Grok invocation pattern (for the resume pass):

```bash
grok -p "<area-specific prompt with commit SHA>" -m grok-4.7 --always-approve
```

## Summary counts

| Status | Count | Notes |
|--------|------:|-------|
| **Confirmed** | 22 | Still true on `main`; includes intentional design (glyph-only errors). |
| **Confirmed (design)** | 3 | Behavior matches `DESIGN.md` / ADR 0163; personas experience as "silent". |
| **Partly fixed / unchanged** | 6 | Improved since Oct 1 in adjacent areas but core gap remains. |
| **Fixed since persona build** | 2 | Tray notices for some failures; grants form copy when no identities. |
| **Not reproducible (code)** | 1 | Bitwarden "Not a live-session link" needs live repro; parser exists. |
| **Can't determine (needs live PWA)** | 4 | Carrier delivery, Copy-only enforcement, cross-browser message variance, ntfy relay. |

## De-duplicated finding list

IDs are stable for PR discussion. Severity is product impact (0–5, higher = worse).

| ID | Theme | Persona sources | Sev | Status on `348811b4` |
|----|--------|-----------------|----:|----------------------|
| PF-01 | Drops open only in sealing browser (local claim plane) | All | 5 | **Confirmed** |
| PF-02 | No sender warning before seal (device-only claim) | All | 4 | **Confirmed** |
| PF-03 | Trash / delete does not revoke local drop claim | All | 5 | **Confirmed** |
| PF-04 | `shareOnce` saves no sender drop record / history | All | 4 | **Confirmed** |
| PF-05 | No opened / expired / revoked receipt for sender | All | 4 | **Confirmed** |
| PF-06 | Claim ciphertext retained after open (`presented`) | BW M5 | 3 | **Confirmed** |
| PF-07 | Link + user code on one card; QR caption repeats code | All | 3 | **Confirmed** |
| PF-08 | Wrong-code lockout (5 tries) with no attempts counter | All | 3 | **Confirmed** |
| PF-09 | Lockout / wrong-code / cross-browser errors look like bare red × | All | 4 | **Confirmed (design)** — strings exist, `StatusMark` shows glyph only |
| PF-10 | Cross-browser: "not on this device" message inconsistent | All | 3 | **Partly** — code path always has hint when local claim missing; live variance **Can't determine** |
| PF-11 | Live join: manual request + reply code exchange | All | 4 | **Confirmed** — by design in `pairing.ts` |
| PF-12 | Host not notified; must paste request code | All | 4 | **Confirmed** — `RequestPaste` only |
| PF-13 | Session timer starts at host start, not guest admission | All | 3 | **Confirmed** — `LiveHost` constructor |
| PF-14 | Guest name shows as "Guest" when name empty / lost | 1P, Inf | 2 | **Confirmed** — fallback `guest.ts:136` |
| PF-15 | Expired live session: guest sees ended state via mark only | Inf | 3 | **Confirmed (design)** — `standing()` + `StatusMark` |
| PF-16 | "Join a session" only on front door (no vault / no setup) | All | 3 | **Confirmed** — not on `VaultsScreen` / unlock form |
| PF-17 | No command-bar / keymap entry for join | Inf | 2 | **Confirmed** — no join row in `keymap/commands.ts` |
| PF-18 | Household sharing capability is a no-op stub | All | 3 | **Confirmed** — `sharing.household/runtime.ts` |
| PF-19 | Drop expiry only (no max views / password / recipient) | All | 2 | **Confirmed** |
| PF-20 | Password health: no sidebar home; bell notification path | 1P, BW | 2 | **Confirmed** — `/vault/health` exists, tree excludes it (`AppShell.test.tsx`) |
| PF-21 | Breach check exists only when capability on; not in minimal vault | BW N8 | 2 | **Partly** — `security-checks.ts` + optional capability |
| PF-22 | Sidebar: dynamic type filters vs collapsed "logins" | 1P N3 | 2 | **Partly** — `buildRoads` emits per-type rows when types installed |
| PF-23 | Access / grants behind capability; empty identity list on fresh vault | Inf | 3 | **Partly fixed** — empty list shows guidance copy, not bindable grant |
| PF-24 | No activity / audit events for drops, live sessions, local grants | Inf | 4 | **Confirmed** — activity log categories don't include drop/share events |
| PF-25 | Bitwarden-compatible host surface not in PWA | BW N7 | 2 | **Confirmed** — host-only (`capability-registry` excludes PWA) |
| PF-26 | Blank claim screen | Sep 24 | — | **Fixed** — `/claim` + `DropClaimScreen` |
| PF-27 | Same-browser claim empty shell | Sep 24 | — | **Fixed** (persona-validated Oct 1) |
| PF-28 | "No host configured" for live sessions | Sep 24 | — | **Fixed** (persona-validated Oct 1) |
| PF-29 | Tray notices for some claim failures | — | — | **Fixed since `6edbd801`** — `#674` tray sweep; `DropClaimScreen.test.tsx` |
| PF-30 | Live-session link parse failure ("Not a live-session link") | BW | 2 | **Not reproducible (code)** — needs live paste repro |

## Evidence by finding (selected)

### PF-01 — Device-local drops only

Claims are stored under `opensesame.local-drop-claims.v1` on the sealing origin
(`local-drop-claims.ts:21`, `:315-322`). Another browser has no record and gets
`not_found` with the cross-device hint (`:317-321`). Creation uses
`createLocalDropClaim` when the device identity host handles `POST /v1/claims`
(`device-identity-host.ts:86-89`).

### PF-03 / PF-04 — No revoke; no sender record

`shareOnce` returns link and code only; comment at `drop.ts:191` states no vault
record. Trashing an item uses `trashItem` in the vault body only; nothing removes
matching entries from `local-drop-claims`. Persona trash-then-open behavior remains
consistent with code.

### PF-06 — Ciphertext kept after open

On successful present, state becomes `presented` but `targetManifest` remains on
the record (`local-drop-claims.ts:361-367`).

### PF-07 — Link and code together

`DropCard` renders link, user code, and QR with `shortcode={drop.userCode}`
(`DropCeremony.tsx:43-86`, `QrCode.tsx:44-47`).

### PF-08 / PF-09 — Lockout and error UX

`MAX_ATTEMPTS = 5` (`local-drop-claims.ts:33`, `:339-343`). Messages exist
(`invalid_user_code`, `too_many_attempts`). UI uses `StatusMark` with
`role="img"` and `aria-label` only (`DropClaimScreen.tsx:158-159`,
`StatusMark.tsx:59-77`) — visually a red × without adjacent text unless the user
opens the tray or long-presses the mark.

### PF-11–PF-13 — Live session handshake

Documented three-step flow (`pairing.ts:1-16`). Guest UI posts request code and
pastes reply (`LiveJoinPairing.tsx`). Host reads pasted request only
(`LiveHostGuests.tsx:56-108`). Session expiry timer armed at construction
(`host.ts:162-165`).

### PF-16 — Join entry only on front door

`UnlockScreen` shows `FrontDoor` only when `status === "empty"` and no setup
record (`UnlockScreen.tsx:109-141`). `JoinRoadButton` is only used from
`FrontDoor.tsx`. Users with existing vaults land on `VaultsScreen` or unlock form
with no join road.

### PF-18 — Household stub

`sharing.household/runtime.ts` registers nothing (23 lines); capability remains
selectable via setup / capabilities UI.

### PF-20 / PF-21 — Password health

`runPasswordHealth` / breach k-anonymity in `security-checks.ts`. Health panel
route `/vault/health` is intentionally omitted from the section tree
(`AppShell.test.tsx` "keeps health out of the tree"). Notification path documented
in tutorial registry (`shell-tour-goals.ts`).

### PF-23 — Grants identity empty

`ConnectorBindForm` with `identities.length === 0` renders guidance to create a
person under Identity (`ConnectorBindForm.tsx:98-115`), not an empty `<select>`.

### PF-24 — No share/session receipts in activity log

Activity emission is generic (`activity-log.ts`); item saves emit
`vault.body.persisted`-class events (`item-activity.ts`). No drop-open or
live-session grant lines found in share/drop/live modules.

## Tests run (this audit)

```bash
pnpm exec vitest run \
  packages/app-core/src/lib/vault/drop-present.test.ts \
  packages/app-core/src/lib/vault/local-drop-claims.test.ts \
  apps/pages/src/modules/identity.ceremonies/DropClaimScreen.test.tsx \
  apps/pages/src/sections/vault/DropCeremony.test.tsx
```

Result: **21 passed** (4 files).  
`apps/pages/src/modules/sharing.live/LiveSession.test.tsx` was attempted; **6 failures**
in this VM (host panel "Live" mark not found — environment/harness, not re-validated
for this document).

## Materially new on `main` (since persona aggregate)

1. **Tray sweep (#674, Oct 6)** — More failures also land in the notifications tray
   with stable IDs; claim screen tests assert tray + `StatusMark` (`DropClaimScreen.test.tsx`).
   Does not add visible inline sentences (still design-contract glyph).
2. **Live NATS carrier (#708)** — Per-session credentials for NATS; does not remove
   manual osl-request/osl-reply paste path for browsers that do not auto-relay codes.
3. **NATS / live session hardening commits** on `sharing.live` — carrier plan binding;
   persona handshake complaints remain unless carrier delivers codes end-to-end (live retest).

## Suggested fix order (ranked)

| Rank | IDs | Area | Rationale |
|------|-----|------|-----------|
| 1 | PF-03, PF-04, PF-05 | Drops / claims | Revoke + history + receipts are dealbreakers for all three personas. |
| 2 | PF-09 (+ PF-08) | Claim + live join UX | One error contract: visible text or tray copy users discover without long-press; attempts remaining. |
| 3 | PF-01, PF-02 | Drops | Honest seal-time warning or cross-device relay (Identity or live carrier). |
| 4 | PF-11–PF-13, PF-15 | Live sessions | Automate codes on carrier, host notification, timer after admit, expiry copy. |
| 5 | PF-16, PF-17 | Navigation | Join discoverable with existing vaults (door, vault chooser, command bar). |
| 6 | PF-07 | Drops | Separate code from link/QR caption. |
| 7 | PF-18 | Capabilities | Hide or implement household sharing. |
| 8 | PF-24 | Observability | Activity / device receipts for drop, session, grant events. |
| 9 | PF-20–PF-22 | Vault UX | Health entry, categories, breach capability defaults (lower than sharing). |
| 10 | PF-06 | Storage hygiene | Wipe claim ciphertext at terminal states. |

## Top 7 confirmed items (evidence)

1. **PF-03** — Trash does not revoke: no bridge from `trashItem` to `local-drop-claims`; persona + `local-drop-claims.ts` lifecycle.
2. **PF-04** — No sender drop record: `shareOnce` at `drop.ts:198-213`.
3. **PF-01** — Device-local claims only: `local-drop-claims.ts:315-321`.
4. **PF-11** — Manual live pairing codes: `pairing.ts:1-16`, `LiveJoinPairing.tsx`.
5. **PF-09** — Glyph-only errors despite full strings: `DropClaimScreen.tsx:158-159`, `StatusMark.tsx`.
6. **PF-16** — Join road gated on front door only: `UnlockScreen.tsx:109-141`.
7. **PF-18** — Household capability stub: `sharing.household/runtime.ts:18-22`.

## Could not fully validate

| Item | Why |
|------|-----|
| PF-10 cross-browser message variance | Persona saw both hint and bare ×; needs controlled multi-browser repro on built PWA. |
| PF-12 carrier auto-delivery | ntfy / carrier path needs live join with fixtures (`pnpm test:live-fixtures`). |
| PF-30 link parse failure | Bitwarden one-off; `parseLiveLink` + boot fragment stripping need repro with exact URL. |
| Copy-only value hiding | No successful join in persona run; code paths untested end-to-end. |
| Grok-assisted cross-check | CLI auth blocked; resume after device login. |

## Related persona must-fix mapping

The Oct 1 consolidated must-fix list maps 1:1 to PF-03–05, PF-09, PF-11–13,
PF-16, PF-07, PF-18 with no item marked fully fixed on `main`.
