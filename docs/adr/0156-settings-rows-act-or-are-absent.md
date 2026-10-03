# ADR 0156 — A Settings row acts, or it is not drawn

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0091](0091-account-exits-and-unlock-ceremony.md) (Settings ›
  Security is a read-only list, one action per row),
  [ADR 0090](0090-static-frontend-complete-without-backend.md) (nothing may be
  placed in front of the static core), [ADR 0130](0130-operator-controlled-capability-composition.md)

## Context

Settings › Security, opened as a guest on a fresh device, showed eight panels
and far more controls than a person could use. Walking every control in a real
browser sorted them:

- **Disabled with a reason that was not true.** Vault key protection's add and
  rotate keys were disabled with "Protection lifecycle is not ready on this
  build", though the lifecycle was complete and wired: the keys were withheld
  from a guest or a locked vault, and the tooltip blamed the build.
- **Pointing away.** Email and text codes drew a lock and a gear that led to
  Capabilities › Better Auth — a form that creates a Host connection, needs a
  Host, and never writes the setting that turns the rows on.
- **Status with nothing to change.** Three policy sentences, "No enrolled
  method", a setup-intent row, a locked "Recovery codes" row with no key,
  five "Not checked" transport rows and a refresh key with no endpoint to ask,
  an "Automatic sign-in" panel of one sentence and a ×, and a Read/Write/Runtime
  table that described what is supported (GPG write: locked) and offered
  nothing to configure.

None of these were unimplemented features. They were representations of a
state a person could not act on, which reads as a product that does not work.

## Decision

A row on a Settings screen is one of two things: something the person can
change **now**, or absent. There is no third state of a disabled key, a lock
glyph standing for "not yet", or a link to a page that does not configure it.

1. **Gate by presence, not by `disabled`.** A control whose precondition is not
   met is not drawn. Vault key protection, Age keys, Recovery, Automatic
   sign-in, the manifest and vault-SOPS rows of Formats, and Transport's status
   rows and probes each render only when what they act on exists.
2. **The row that needs a setting sets it.** Email and text codes open the
   sign-in service sheet (`ServiceCeremony`, writing `identityApi` through
   `packages/app-core/src/lib/identity-service.ts`, the one validator). They do
   not navigate. The service has its own row so it can be changed or forgotten.
3. **A setting is never removed from under something that depends on it.** The
   service row offers no Remove while an email or text code is enrolled, since
   unlock would then ask for a code nothing can send.
4. **A fact that nothing can change is not a row.** Static policy lists and
   capability matrices are removed; a fact that matters is said where the action
   that it governs is (a card's facts, a sheet's foot).
5. **Preconditions a person cannot see are made reachable, not explained.** A
   code can only guard a key, so email, text and the service row appear once a
   key exists; the authenticator, which walks a key first in the same sheet,
   is offered before that.

6. **A key is drawn only where the authority behind it accepts it.** Test is
   drawn for a recovery key, not for Password, PIN or passkey — the service
   proves those only at unlock. Vault key protection is absent in the guest's
   own tomb even after a key is enrolled there, because the service refuses
   protector changes on it (`isGuestOrEphemeral`); the panel follows the
   service's predicate, it does not widen it.
7. **A view reads the state the service acts on.** The panel's rows come from
   the header's sealed manifest, not a per-render projection of the legacy
   wraps: that projection mints new ids each call, so the first version of
   these keys named protectors no manifest held ("… is not enrolled"), and an
   enrolled recovery key never appeared. The manifest is written as soon as the
   panel can act on it.

The typed "not wired" stubs for the protection lifecycle are deleted: a shell
that cannot supply every action supplies none, and the panel is absent.

## Consequences

- A guest sees the keys that will do something (passkey, PIN, password,
  authenticator, SOPS document, age armor) and nothing that will not. Enrolling
  a key is what brings in Vault key protection, Age keys, the manifest export,
  email and text.
- Cloud KMS, YubiKey and age-recipient *enrollment* are not offered on Security
  at all: the adapters exist, but the browser enrollment service does not enroll
  them (`browser-enroll.ts`), and a "setup intent" row with no action was the
  representation this decision removes. It returns with its enrollment.
- The Better Auth / WorkOS / Auth0 tiles under Capabilities still create Host
  connections and give no feedback on a device with no Host. That is a
  separate defect; nothing on Security depends on it any more.
- **Transport follows the rule, and ADR 0132's acceptance scenario changed with
  it.** With no endpoint and no status read, Transport draws only its form —
  no five idle rows, no Refresh key, no verify key. `AT-STATIC-EMPTY` /
  `AT-BROWSER-UX` (`verify-transport.mjs`, `docs/validation/mtls-implementation.md`)
  were restated to assert exactly that, and ADR 0132 carries a dated amendment.
  The configured-endpoint journeys still assert the five rows and both keys.
- Tests assert absence for the guest and locked states, and that every key that
  is drawn is enabled. A live sweep of every key on Security, as a guest and
  with a sealed personal vault, found none that does nothing except "Seal
  identity", a form submit that stays disabled until its own field has text.
