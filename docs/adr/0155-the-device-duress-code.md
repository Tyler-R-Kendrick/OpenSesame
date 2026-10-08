# ADR 0155 — The device's duress code, in Settings

- Status: Accepted
- Date: 2026-09-28
- Amended by: [ADR 0168](0168-duress-modes-from-scenarios.md) (one code per
  device, two outcomes → one code, a mode chosen from a short list)
- Builds on: [ADR 0130](0130-duress-profiles-trust-boundaries.md) (duress
  trust boundaries), [ADR 0089](0089-device-vault-switching.md) (one list of
  the device's vaults), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (complete without a backend), [ADR 0091](0091-account-exits-and-unlock-ceremony.md)
  (one sheet per security ceremony), [ADR 0143](0143-travel-mode.md)
  (travel mode)

## Context

The duress runtime existed and was tested: a code typed complete where a
vault unlocks is matched before any unwrap, an incident fence is written, and
the person is shown a decoy or a refusal. **No person could reach it.** The
Settings panel that arms it sat behind `resolveDuressMode`, which is off on
every deployment, and, had it been forced on, it was a developer form of
presets, recipient fields and fixture ids (`vault_ref: "vault-1"`) that
armed a profile no unlock ever read. The browser "gate" for it drove
fixtures, never the app. Travel mode had the same shape of gap in a smaller
way: the "safe for travel" marks were forgotten on every reload.

## Decision

- **One row in Settings › Security.** `Duress` sits with the unlock methods,
  drawn the way they are: a read-only row (`Duress code`, state, one key)
  and one sheet for the ceremony (ADR 0091). No environment switch, no mode.
- **One code per device, two outcomes.** The person chooses what the code
  shows: an **empty decoy vault** that reads as a normal unlock, or the
  refusal a **wrong password** gets. These are the only two the unlock path
  applies. Holds, custodians, alerts and removal need recipients or an
  independent authority a browser cannot supply, and nothing applies them at
  unlock, so the sheet offers none of them rather than a switch that promises
  what unlock does not do.
- **It is armed against reality.** The enrollment names the vault the owner
  is in (`activeProject().id`), the code must be 8–12 digits (the same floor
  the runtime enforces, worded once from `DURESS_PIN_MIN/MAX`), it is refused
  when it would open a vault on this device in the ordinary way, and arming
  refuses without durable storage — a code the browser would lose on reload
  fails silently when it is needed most. Arming seals the code and proves the
  sealed slot opens with it before it says "on".
- **Invisible where it must be.** A decoy is drawn no row at all, so a person
  made to open Settings in front of someone finds nothing to disable and
  nothing that says it is there (ADR 0130, INV-27). A guest who has not made
  a key yet is not a decoy: with no key there is nothing to guard, so Security
  draws a Duress and a Travel section marked "After a key" whose Add opens the
  key sheet (ADR 0158); once a key exists the real rows replace them
  (`GuestAfterKeyRows`, walked by J-DURESS-GUEST). A decoy never gets either.
- **The owner can recover.** Using the code fences the device: the person who
  unlocks is held to a guest's powers, travel and code changes are refused
  (`duress_active`). A session opened with the vault's own key sees the row
  as *Used* with one key, *Clear*, which resolves the incident. The code stays
  armed. Coming back is the owner's word that the danger has passed, from a
  session only the real key opens.
- **Travel remembers.** The vaults marked safe for travel are a device
  setting (`travel.safe.v1`, hydrated at boot, sealed at rest under the device
  key per ADR 0149), so the choice is made once, at home. A vault that left or
  was deleted drops out when the list is read, and a departure no longer
  clears the marks of the vaults that stayed.
- **The front door tells the truth.** Boot now hydrates every vault's
  plaintext header, not only the active tomb's. A sealed vault used to draw
  as "not sealed yet" after a reload, offering to seal a new vault over it.
- **Capability.** `vaults.duress_code`, owned by the core `vault.local-unlock`
  capability. No egress, no browser permission. MCP and WebMCP are excluded:
  a code that changes what a coerced person's device shows is that person's
  decision alone (ADR 0065).

## Consequences and honest limits

- The code is **device-wide**, not per vault. One person cannot have a
  different decoy for each vault.
- A decoy is **empty**. It is not a believable second vault; someone who
  knows this product will look for one, and only the second outcome says
  nothing at all.
- **Nothing here notifies anyone.** No alert leaves the device; that needs a
  recipient a browser cannot supply alone.
- The fence is **local**. Clearing it is available to whoever opens the vault
  with its real key — coercion into that key defeats it, as it defeats the
  vault.
- Presentation is all a browser can promise. A person who can read the
  device's storage sees an armed enrollment, though not the code or which
  outcome it shows (that is sealed with it).

## Alternatives considered

- **Force the old panel on.** Rejected: it armed fixtures no unlock read.
- **Offer every profile option now and mark the unapplied ones "coming".**
  Rejected: a duress switch that does nothing is worse than none.
- **A per-vault code.** Rejected for now: enrollment is device-wide
  (ADR 0130) and a per-vault code could not be told apart at a shared unlock.
