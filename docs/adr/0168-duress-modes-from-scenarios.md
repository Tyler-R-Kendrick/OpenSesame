# ADR 0168 — Duress modes, derived from the scenarios people meet

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

### The gap the first five modes left

The first five modes answer "something must be shown" with a *fiction* (an empty
vault, or a handful of items the owner typed) and "nothing may be shown" with a
refusal. None of them lets a person who is compelled to unlock open **their own
vault, with the items they chose to hide left out**. That is what a person under
pressure is often asked for: the vault itself, opened. Refusal, freeze and wipe
leave them with nothing to show, which can read as refusing to comply and can put
them in more danger, not less; a typed decoy is a story they must have prepared
and that the person asking may not believe. A sixth mode closes the gap, and the
three that refuse now say so on the sheet before they are armed.

## Decision

**A code has a mode, chosen from a registry, and a mode may be added only if
unlock really does what its sentence says.** The set, with all four effects landed (#716, #717, #718 and the one below), is:

1. **Decoy vault** (exists) — an empty vault that reads as a normal unlock.
2. **Show my vault without the items I hide** — the same decoy, holding
   sanitized *copies* of the items the owner chose to leave shown, taken from the
   vault while the owner had it open. It is offered only when the open vault has
   at least one item it can show (below).
3. **Decoy with everyday items** — the same decoy, holding a short list of
   ordinary items the owner picks. An empty vault is itself a tell; a few
   plausible rows are the point of a decoy. Items are authored by the owner or
   taken from a fixed starter set, never copied from the real vault, so nothing
   real can leak into the decoy by construction.
4. **Wrong password** (exists) — refused exactly as a wrong secret is.
5. **Freeze for a while** — refused like a wrong password, and this device
   refuses the vault's real credentials for 1, 24 or 72 hours. The hold cannot
   be shortened from the device, only extended.
6. **Wipe this device's copy** — refused like a wrong password, and this
   device's copy of the vault is removed from this browser's storage.

The sheet draws the modes that open something a person can show (1 to 3) before
the three that refuse (4 to 6), in the order listed, and the consent sentence of each refusal says in
one plain sentence that a refused unlock may be read as refusing to comply and can
escalate the situation. Nothing in the sheet promises that any mode makes a
situation safer.

### Show my vault without the items I hide

The decoy session is opened exactly as the other decoys are (`createGuest({ decoy:
true })`): the real vault stays sealed, its key is never derived from the duress
code, and the protected root is never admitted. The runner adds copies to the decoy's
ephemeral store in the `after_session` phase, as `decoy_items` does for typed
items.

- **The copies are taken at arming**, while the owner has the real vault open,
  and sealed in the slot payload under the duress code. `enableDuressCode` is
  handed the open vault's current items by the Settings hook, and a mode's plan
  is `plan(extras, context)` with `context.items`: still a pure function of its
  inputs, and no mode imports the vault store. Nothing reads the real vault at
  unlock, so nothing about it can leak in the unlock path.
- **Hiding fails safe.** Everything starts hidden. The sheet lists the open
  vault's items (name and kind, never a secret) as switches whose on position is
  *Hidden*; at least one must be left shown to arm (an empty vault already exists
  as Decoy vault). The sheet's value is the ids of the items shown, and an id that
  matches nothing is skipped, so a stale pick can only hide. An item added to the
  vault after arming is not in the snapshot, so it is hidden by construction. An
  item *edited* after arming still shows its old content until the owner arms
  again; the consent sentence says so in one sentence.
- **What is copied is a closed list.** A copy is built by naming what it keeps,
  never by deleting from the item. Kinds: login, secure note, secret, card, and
  typed items of a built-in type that is loaded here and declares no field
  holding a seed, a key or a file. Kept: name, the kind's own plain fields
  (username, password, addresses, notes, number, and so on), plain custom
  fields, favourite, creation and update dates. **Never copied**: passkeys, certificates,
  drops and files (key material and attachments); one-time-code seeds (`totp`);
  concealed custom fields (where a PIN, a security answer or a seed is kept);
  password history; the links that tie an item to a reset or a replacement; the
  item's folder (flattened to none); a secret's grants and grantees; anything in
  the trash; a typed item of a type this device does not know. Every copy gets a
  new random id when it is added to the decoy; strings are cut to fixed lengths
  (names 120, notes 4000, any other value 512, 50 items at most).
- **The reader is closed**, as `decoy_items`' is: an unknown key, a kind not on the
  list, a count or length out of range or a non-string where one belongs makes
  the whole body no plan, and the runner adds nothing. Arming reads the body back
  through the same reader before sealing, so a plan that would not run is never
  sealed. A pick too large for the slot refuses with `too_large` rather than
  arming a code that would open an empty decoy.
- **The slot's payload cap rises from 8 KiB to 64 KiB** for this plan; the freeze,
  wipe and typed-items plans stay under 1 KiB. A slot with no payload is
  byte-for-byte what it was (the NUL after the presentation is only written when a
  payload follows), and tests hold the layout, the cap and the larger payload's
  round trip. The slot rides in the enrollment journal, written whole to the
  origin's files; 64 KiB of ciphertext is about 87 KiB of base64.
- **The mode is absent when it cannot act** (ADR 0158): it is not drawn unless
  the open session is the owner's real vault with at least one item it can show.
  A decoy draws no Duress row. A keyless guest is drawn the "After a key"
  placeholder instead (ADR 0155), which names no mode.

Not offered, and why: **alert a contact** needs a delivery path and an
independent receiver, neither of which a static app has (INV-14, INV-16);
**peer, canary, custodian and split-scope** variants are not a typed code on one
device and belong to the profile model of ADR 0130, not this sheet.

### The seam

- A mode may seal a **plan** with the code: an effect name and its parameters,
  as a small versioned JSON envelope after the presentation inside the slot's
  ciphertext (`crypto/slot-profile.ts`, 64 KiB cap; 8 KiB until the sixth mode). Nothing stored says which
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
  `items`, `pick`, `confirm`) and the sheet draws it generically, so adding a
  mode adds a file, not a screen. A `pick` is a list of rows the open vault
  supplies, drawn as switches; a mode that picks is offered only when it has rows. Arming refuses before sealing when the input is not
  enough (`inputReady`, one reading for the sheet and for arming).
- Matching still **fences the device** in every mode (ADR 0155): the person who
  unlocked is held to a guest's powers until the owner clears it.

## Honest limits

These are stated on the sheet and in the operator guide, not left to be found:

- **Freeze trusts this device's clock.** A clock moved forward, or cleared site
  data, ends the hold; a clock moved back modestly lengthens it, and one moved
  back by more than 72 h and a minute makes the record read as unreliable, so
  it **fails open** rather than lock the owner out for good (INV-19). It stops
  someone using the app as it is; it does not stop someone who controls the
  browser's storage.
- **A freeze also holds the owner.** While it runs the vault's real credentials
  are refused, so the owner cannot open the vault to press **Clear** on the
  duress row until the hold ends. The guest road and a decoy are not held (the
  guest road is never removed). A session already open in another tab keeps
  working: the hold gates new unlocks and mid-session scope switches. A parked
  second step refused at activation says "That credential did not unlock the
  vault." rather than the authenticator-code text.
- **Wipe removes this browser's copy, not what the disk may still hold**
  (INV-22..24). It is restorable only from a backup the owner made, and the
  sheet says so before the owner ticks the box and types the word. It never
  touches the device's at-rest key, the guest vault, or the duress record
  itself, so the code still works afterwards.
- **A wipe's timing differs from a wrong password's.** Removal runs before the
  refusal is shown, but an ordinary wrong PIN pays a key derivation against the
  real vault that the wipe does not: in the journey the wipe refusal took about
  0.92 s and a wrong PIN about 1.4 s. The sheet's consent sentence says the
  time may differ, in either direction, and does not promise it will match.
  An earlier draft of this ADR claimed a wipe is visibly slower; the
  measurement says otherwise and the claim is withdrawn.
- **A wipe leaves some things behind.** Encrypted file parts (they cannot be
  tied to a vault, and their per-file keys lived in the removed vaults), the
  history-backup IndexedDB, settings and setup records, and the Identity
  session. It removes every non-guest vault on the device, project vaults
  included, and an interrupted wipe finishes silently at the next boot, showing
  the sign-in screen of a device with no vault.
- **The shown items' secrets rest under a short number.** The copies are sealed
  under the duress code, 8 to 12 digits, so anyone with this browser's storage and
  enough effort can recover them. Choose only items you could afford to show. The
  real vault is not weakened by this: its key is never derived from the code.
- **The copy is a snapshot from arming.** Edits made afterwards are not in it and
  need the owner to arm again. Items added afterwards are hidden.
- **A typed item can look out of place in the decoy.** Its definition must be built
  in and loaded on the device for the item to be offered, but the decoy is a scratch
  vault: if the type's pack is switched off when the code is typed, the item is drawn
  by the unknown-type fallback.
- **A decoy is only as plausible as its author makes it.** The owner chooses
  its items; we cannot know what looks ordinary to the person asking. Its
  Security page still lists unenrolled unlock methods, because it is a scratch
  vault (recorded in the evidence for ADR 0155's follow-up).
- **None of this is protection from coercion** (INV-07). It changes what a
  forced unlock reveals on this device; it cannot observe or prevent the force.

## Consequences

- The sheet offers six modes where it offered two (five where the open vault has
  nothing it can show), each with its own consent sentence ticked for that mode
  only, and the wipe additionally asks for a typed word.
- Four effects (`decoy_items`, `visible_items`, `freeze`, `wipe`) landed on this
  seam, each with a test that fails against doing nothing and a real-browser
  journey that types the code at the unlock screen after a reload (J-DURESS-ITEMS,
  J-DURESS-VISIBLE, J-DURESS-FREEZE, J-DURESS-MODE-WIPE). The visible-items one also
  has an end-to-end test with real crypto that seeds a vault, arms two of its items,
  types the code through the real unlock path and scans the decoy, the enrollment,
  the incident journals and the sealed tombs for any string of an item left hidden.
- Every locked mode now refuses with the same text as an ordinary wrong
  password on the password tab ("That password did not unlock the vault."); the
  two used to differ, which was itself a tell.
- A wiped device recovers without a bypass: the match still fences the device,
  and the owner seals a new vault on it, restores a backup they made, clears the
  fence and arms a new code. While a real vault exists the fence still refuses
  arming and removal (`incident_active`).
- The enrollment format gains an optional payload; older builds that do not know
  an effect do nothing for it, so a plan is never half-run.
