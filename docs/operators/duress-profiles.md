# Operator guide — duress profiles (presets, consent, delays, rehearsal)

**Audience:** vault owners configuring optional duress on OpenSesame Pages.
**Not a personal safety plan.** Read the limitations section before arming.

Design: [ADR 0130](../adr/0130-duress-profiles-trust-boundaries.md).
Evidence: `docs/evidence/2026-09-21-duress/`.

## Turning it on in Pages

**Settings › Security › Duress** (ADR 0155). There is no switch to find first:
the row is there for the owner of an open vault, and it is not drawn in a decoy.
A guest who has not made a key yet sees a Duress and a Travel section marked
"After a key"; **Add** there opens the key sheet, and once a key exists the real
rows appear.

1. Press **Add**. Choose what the code does (the six modes below).
2. Type a code of 8 to 12 digits twice. It may not be a PIN that opens a vault on
   this device; you are told now, not at the border.
3. Tick that you understand, then turn it on. The browser must keep files for
   the site, or arming is refused. A mode that asks for more (a duration, a list
   of items, the word `WIPE`) will not arm until you have given it.

Type the code where you unlock, as the whole code. Nothing else is asked. After
it is used, the device is held to a guest's powers (no travel, no code changes)
until you open the vault with its **real** key and press **Clear** on the row.
The code stays on until you **Change** or remove it. Nothing stored says which
mode a code is, and the sheet cannot read it back: to change the mode, arm again.

What it does **not** do: it is one code per device, and it sends no alert to
anyone. The holds, custodians and removal described further below are not
applied by this road.

### The six modes

Each is chosen from the situation, and each has its own consent sentence. None
is protection from coercion: each changes what a forced unlock reveals on this
device and nothing more (ADR 0168).

| Mode | When | What the code does | What to know |
| --- | --- | --- | --- |
| **Decoy vault** | Made to unlock, and something must be shown | Opens an empty vault that reads as a normal unlock | An empty vault is itself a tell |
| **Show my vault without the items I hide** | Made to unlock, and refusing could be read as refusing to comply | A decoy holding copies of the items you left shown, taken from your open vault when you arm. Every item starts hidden; you switch off *Hidden* on the ones to show, and at least one must be shown | Offered only while you are in your real vault and it has an item it can show. Logins, notes, secrets, cards and typed items; never passkeys, certificates, drops, files, one-time-code seeds, history, folders or deleted items. The copies are sealed under your short code, so anyone with this browser's storage and effort can read them: choose only items you could afford to show. Items added after arming stay hidden; edits show the old content until you arm again |
| **Decoy with everyday items** | Same, and an empty vault would look wrong | The same decoy, holding 3 to 12 ordinary logins you typed or took from the starter set (Netflix, Wi-Fi at home, Library card, Gym, Spotify, Electric bill) | Items are written, never copied from your real vault. Each gets a random 20-character secret made when you arm. Names are up to 40 characters. They show with no username |
| **Wrong password** | Made to unlock, and nothing may be shown | Refused exactly like a mistyped password | The refusal text is the same as an ordinary wrong password's |
| **Freeze for a while** | The device is taken and the unlock is being forced or guessed | Refused like a wrong password, and for 1, 24 or 72 hours the device refuses the vault's real credentials too | You choose the duration, there is no default. It cannot be shortened from the device, only extended. **It holds you as well**: you cannot open the real vault, or press Clear, until it ends. Guest and decoy sessions are not held. Uses the device clock |
| **Wipe this device's copy** | The device is about to be surrendered for good | Refused like a wrong password, and this browser's copy of every vault except the guest vault is removed | Restorable only from a backup you made. Asks you to type `WIPE`. Removes this browser's storage, not what the disk may still hold. Leaves file parts, the history backup, settings and the Identity session |

Pick a mode by what you can afford to lose. A freeze costs a stretch of time; a
wipe costs the on-device copy for good. The three that refuse (wrong password,
freeze, wipe) leave you with nothing to show, which may be read as refusing to
comply and can escalate the situation; the sheet says so before you tick them. If
you may be made to open the vault, a mode that shows something comes first in the
list for that reason.

## When to use this

Use duress profiles only if you understand that:

- Activation is **opt-in** and rehearsed before arming.
- Browser-local behavior is not the same as cryptographic isolation or an
  independent Host/custodian hold.
- Alerts, if configured, are **optional**, value-blind, and do not guarantee
  that a human can help you.
- Local removal and holds do **not** erase historical offline copies or prove
  forensic cleanup.

If you need physical safety, contact appropriate local resources. This product
does not provide that.

## Presets (scenario vocabulary)

Presets map to compiled scenario IDs (fixtures under
`docs/evidence/2026-09-21-duress/examples/`). Labels in UI
must match these semantics — do not invent stronger wording.

| Preset / scenario | Typical trigger | What changes | Honest limit |
|---|---|---|---|
| Alert only (`SC-ALERT-ONLY`) | Application code (or stronger) | Queues/sends a sealed alert; unlock path may stay real-access if configured | Alert queued ≠ delivered ≠ acknowledged; no emergency response |
| Restricted (`SC-RESTRICTED`) | Code | Presentation and access ceiling limited to admitted compartments | Shared-root projects are **not** isolated |
| Decoy (`SC-DECOY`) | Code | Shows an independently keyed decoy compartment | Decoy never forges production success or mutates real providers |
| Local hold (`SC-LOCAL-HOLD`) | Alternate code | Ordinary-looking locked/unavailable; sensitive handles invalidated | **No countdown UI**; local clock is not a tamper clock; expiry ≠ auto-unlock |
| Custodian hold (`SC-CUSTODIAN-HOLD`) | Code | Selected compartments need recovery contributions / optional independent authority | Approval quorum ≠ key custody; disclose historical keys |
| Quarantine (`SC-QUARANTINE`) | Code | Keep a small local compartment; quarantine peer refs | Network reachability alone is not authority |
| Local remove (`SC-LOCAL-REMOVE`) | Code | Enumerated local resources removed; optional sealed outbox retained | Not global wipe; not forensic erasure |
| Limited carry (`SC-LIMITED-CARRY`) | Pre-incident owner action + code | Retain selected everyday items under a ceiling | Explicit pre-incident consent required |
| Approval duress (`SC-APPROVAL-DURESS`) | Code in app-owned approval ceremony | Deny before sign/mint/invoke | No fake success; agents cannot approve |
| Lost device (`SC-LOST-DEVICE`) | Delegated peer request | Local retirement / quarantine path | Peer must present bound delegation, not “on the tailnet” |
| Split scope (`SC-SPLIT-SCOPE`) | Per-owner profiles | Personal vs org compartments differ | Scope expansion requires each affected owner |
| Canary (`SC-CANARY`) | Canary activation | Detection-only | Never escalates to destruction from hits alone |
| Rehearsal (`SC-REHEARSAL`) | Isolated exercise | Proves readiness without arming production effects | Required before arming (INV-02) |

Advanced multi-profile setups use the same compiler; presets are curated
catalogs, not a second security engine.

## Consent and scope review

Before arming:

1. Confirm **affected owner** identity for every compartment in scope.
2. Review the compiler **exposure summary**: admitted/denied compartments,
   unlock-path labels, alternate-wrapper warnings, historical-copy disclosure.
3. Acknowledge destructive effects explicitly (`acceptUnrecoverability` where
   removal is configured; `disclosureAck: true` on holds).
4. Confirm alert routes are **pre-approved**, recipients consented and tested,
   and templates are value-blind (no codes, PRF, shares, or unexpected
   location/media — INV-18).

Importing a policy with `enabled: true` is **preview only**. It does not arm.

## Delays and holds

| Hold kind | Meaning | Operator must know |
|---|---|---|
| `none` | No hold effect | — |
| `local_application` | This origin enforces duration / indefinite refusal | Not tamper-resistant; clock skew possible; expiry only allows a **fresh recovery attempt** |
| `independent_authority` | Host or other enrolled authority must clear | Offline authority ⇒ no fabricated clear |
| `custodial_reenrollment` | Recovery policy / quorum required | Shares must not live only inside the removed compartment |

Do not display a conspicuous countdown during an active local hold. Owners see
duration policy at enrollment time.

## Recipient and custodian planning

Separate roles (do not conflate):

- **Alert recipient** — may learn that an activation package was delivered;
  cannot unlock, approve recovery, or delete by virtue of the alert.
- **Lock / hold custodian** — contributes to clearing an independent hold.
- **Recovery approver** — signs request-digest-bound approvals.
- **Key custodian** — holds recovery shares (Shamir / wrapping secret).
- **Affected owner** — arms, disarms, and authorizes scope.

Plan: how recipients should respond (call a known person, start recovery, do
nothing until a second channel confirms). Document that **notification
acknowledgement never unlocks** (INV-14).

Warn at enrollment that notification traffic may be observable on-network.

## Rehearsal

Isolated rehearsal (`SC-REHEARSAL`) must succeed before arming:

- Uses disposable fixtures / isolated environment — never production recipient
  tokens or real vaults in CI.
- Proves trigger selection, presentation class, and readiness
  (`durableStorage`, `offlineAssets`, `rehearsalPassed`, `ownerConsent`).
- Must not leave a half-armed destructive code on failure.

Replace codes through the supported ceremony; never display stored codes in
settings.

## Related guides

- Inventory, migration, custodial recovery, retirement:
  [duress-inventory-recovery.md](./duress-inventory-recovery.md)
- Troubleshooting:
  [duress-troubleshooting.md](./duress-troubleshooting.md)
- Vault key protection (any-of wrappers):
  [vault-key-protection.md](./vault-key-protection.md)
