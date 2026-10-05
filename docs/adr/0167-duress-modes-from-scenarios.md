# ADR 0167 — Duress modes, derived from the scenarios people meet

- Status: Accepted
- Date: 2026-10-05
- Amends: [ADR 0155](0155-the-device-duress-code.md) (one code per device, two
  outcomes → one code per device, a mode chosen from a short list)
- Builds on: [ADR 0130](0130-duress-profiles-trust-boundaries.md) (duress trust
  boundaries), [ADR 0143](0143-travel-mode.md) (travel mode),
  [ADR 0149](0149-nothing-stored-in-the-clear.md) (nothing stored in the clear),
  [`docs/research/travel-mode.md`](../research/travel-mode.md) (the scenarios and
  the competitors behind them)

## Context

ADR 0155 gave a person one duress code and two things it could do: show an empty
decoy, or be refused like a wrong password. That is a switch with two positions
chosen by us, not a set of answers to the situations a person is actually in.
The research behind travel mode lists those situations, and what the products
people already trust do about each:

| Situation | What exists | What it does |
| --- | --- | --- |
| Made to unlock, and *something* must be shown | VeraCrypt hidden volume, 1Password Travel Mode, Keeper | Opens a plausible vault, never the real one |
| Made to unlock, and *nothing* may be shown | Any wrong password | Refusal, indistinguishable from a mistyped secret |
| Device is taken and the unlock is being forced or guessed | Apple Stolen Device Protection, Android Identity Check | Locks the sensitive things for a while, whatever is typed |
| Device is about to be surrendered for good | GrapheneOS duress PIN, Keeper self-destruct | Removes this device's copy |
| A contact should hear about it | Alert-on-duress in several managers | Sends a message |

Three of the five can be done honestly by a static app on one device. The other
two cannot, and offering them would be exactly what ADR 0155 refused: a switch
that promises more than unlock performs.

## Decision

**A code has a mode, chosen from a registry, and a mode may be added only if
unlock really does what its sentence says.** The set, once its three effects land, is:

1. **Decoy vault** (exists) — an empty vault that reads as a normal unlock.
2. **Decoy with everyday items** — the same decoy, holding a short list of
   ordinary items the owner picks. An empty vault is itself a tell; a few
   plausible rows are the point of a decoy. Items are authored by the owner or
   taken from a fixed starter set, never copied from the real vault, so nothing
   real can leak into the decoy by construction.
3. **Wrong password** (exists) — refused exactly as a wrong secret is.
4. **Freeze for a while** — refused like a wrong password, and this device
   refuses the vault's real credentials for 1, 24 or 72 hours. The hold cannot
   be shortened from the device, only extended.
5. **Wipe this device's copy** — refused like a wrong password, and this
   device's copy of the vault is removed from this browser's storage.

Not offered, and why: **alert a contact** needs a delivery path and an
independent receiver, neither of which a static app has (INV-14, INV-16);
**peer, canary, custodian and split-scope** variants are not a typed code on one
device and belong to the profile model of ADR 0130, not this sheet.

### The seam

- A mode may seal a **plan** with the code: an effect name and its parameters,
  as a small versioned JSON envelope after the presentation inside the slot's
  ciphertext (`crypto/slot-profile.ts`, 8 KiB cap). Nothing stored says which
  mode an armed code is, and the owner cannot read it back from the device; they
  re-arm to change it. A slot written before this ADR has no payload and opens
  as it always did.
- **One seam runs it**, in `continueAfterDuressMatch`, in two phases:
  `on_match` before anything is shown or refused, and `after_session` once a
  decoy session exists. A runner never throws out of the seam — a visible
  failure is the tell the modes exist to avoid — so it records its own failure.
- A mode **names its effect only if a runner exists for it**; `modes.test.ts`
  fails otherwise, so the sheet cannot offer a mode unlock cannot run.
- A mode declares its **input** from a closed set (`none`, `text`, `choice`,
  `items`, `confirm`) and the sheet draws it generically, so adding a mode adds
  a file, not a screen. Arming refuses before sealing when the input is not
  enough (`inputReady`, one reading for the sheet and for arming).
- Matching still **fences the device** in every mode (ADR 0155): the person who
  unlocked is held to a guest's powers until the owner clears it.

## Honest limits

These are stated on the sheet and in the operator guide, not left to be found:

- **Freeze trusts this device's clock.** A changed clock changes the hold
  (INV-19), and clearing site data ends it. It stops someone using the app as
  it is; it does not stop someone who controls the browser's storage.
- **Wipe removes this browser's copy, not what the disk may still hold**
  (INV-22..24). It is restorable only from a backup the owner made, and the
  sheet says so before the owner ticks the box and types the word. It never
  touches the device's at-rest key, the guest vault, or the duress record
  itself, so the code still works afterwards.
- **A wipe takes visible time.** Removal runs before the refusal is shown, so
  an observer who times the unlock may see it take longer than a wrong password.
- **A decoy is only as plausible as its author makes it.** The owner chooses
  its items; we cannot know what looks ordinary to the person asking. Its
  Security page still lists unenrolled unlock methods, because it is a scratch
  vault (recorded in the evidence for ADR 0155's follow-up).
- **None of this is protection from coercion** (INV-07). It changes what a
  forced unlock reveals on this device; it cannot observe or prevent the force.

## Consequences

- The sheet offers five modes where it offered two, each with its own consent
  sentence ticked for that mode only, and the wipe additionally asks for a typed
  word.
- Three effects (`decoy_items`, `freeze`, `wipe`) land as three pull requests on
  this seam, each with a test that fails against doing nothing and a real-browser
  journey that types the code at the unlock screen after a reload.
- The enrollment format gains an optional payload; older builds that do not know
  an effect do nothing for it, so a plan is never half-run.
