# ADR 0158 — A Settings row acts, or it is not drawn

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0091](0091-account-exits-and-unlock-ceremony.md) (Settings ›
  Security is a read-only list, one action per row),
  [ADR 0090](0090-static-frontend-complete-without-backend.md) (nothing may be
  placed in front of the static core), [ADR 0130](0130-operator-controlled-capability-composition.md)

- Amended 2026-10-03: three Consequences below have since moved. Cloud KMS and
  age-recipient enrollment are offered ([ADR 0152](0152-browser-key-protector-enrollment.md)
  — YubiKey PIV, Azure Key Vault Keys and device-local are not, for reasons
  that ADR gives); the connector-tile defect is closed
  ([ADR 0151](0151-connector-pages-act-on-the-roads-a-device-has.md)); and the
  Transport panel, with the Formats, Age keys and sealed-store panels, was
  removed from Pages (#618) — [ADR 0132](0132-optional-mtls-and-workload-identity.md)
  records that, and `verify:transport` asserts the panel's absence.

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
- The Better Auth / WorkOS / Auth0 tiles under Capabilities created Host
  connections and gave no feedback on a device with no Host. That road is
  deleted ([ADR 0151](0151-connector-pages-act-on-the-roads-a-device-has.md),
  second amendment); nothing on Security depended on it.
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

## Amendment (2026-10-03): a second walk of every Settings tab

A second walk — as a guest and as a password-sealed vault with a PIN, an
authenticator and a recovery key, at 1280 and 390 wide, with every optional
capability switched on — found the rule still broken in places the first sweep
did not reach, and one claim above ("found none that does nothing") untrue. Each
was fixed at its root:

- **A switch that cannot take.** Turning Browser-local IAM off while Self-issued
  OpenID runs changed nothing: the plan pulls a dependency back in. A tile whose
  capability another running one is built on, and a section's switch when a
  running capability outside it needs one of its own, now say *needed by …*
  (`dependentsOf`, `heldOutside` in `features.ts`) instead of drawing a switch.
- **A link to a blank page** is fixed by the connectors work, not here: with
  Connections off (the default, ADR 0153) a provider tile whose page only
  Connections routes is not drawn, and a section left with nothing to act on is
  absent ([ADR 0151](0151-connector-pages-act-on-the-roads-a-device-has.md),
  third amendment). This walk reproduced it (43 tiles, each opening a blank
  page) and kept that mechanism rather than a second one.
- **A switch that looks off while it is on.** Switches carried `aria-pressed`
  beside `aria-checked`; dropping the redundant one left `.toggle` styled only
  for `aria-pressed`, so every switch drew off. The toggle's on state now answers
  to either (`components/toggle-style.test.ts`).
- **A switch for nothing.** External telemetry and Certificate authority have no
  Pages code (their modules say so); Push notifications had a library and no row.
  The first two draw no section (`NO_SURFACE`) — unless a plan already approves
  one (a persisted selection or a policy can carry it, and Access and Certificate
  records run on Certificate authority), when its one switch stays so it can be
  turned off and nothing is left "needed by" a capability with no control
  (`shown(feature, plan)`); Push gets *Push on this device*
  under General, drawn to turn push on where the browser, an Identity API and a
  session allow it, and kept (On, with its one key) wherever the browser is still
  subscribed, so it can always be ended; turning it off says when the service
  could not be told.
- **A key drawn disabled.** Reset every key and macro with nothing changed, a
  macro step's move up on the first and down on the last, Add and Record at the
  step limit, New macro and Edit while an editor is open, the open vault's travel
  switch, Leave for a trip with one vault, Relay only with no TURN server, the
  Environments value rows with no environment, and the preferred unlock's own
  star. Each is absent until it can act, and focus follows.
- **A row with nothing to change.** Notifications on a device with no Identity
  API (one inbox row), the plugin tiles with nothing paired and no way to pair,
  and the *Sign out of Identity too* switch on a device with no Identity to sign
  out of: it is drawn while an Identity API is named or an Identity session is
  held (a guest on a device with a service named still sees it), and absent
  otherwise. A stored `signOutOnLock: true` is not lost with the row: it is the
  vault's own preference, still read and written as `signOutOnLock` in the
  General settings file, and the switch returns, on, with the Identity API or
  session. With nothing to sign out of, it does nothing at lock.
- **A preset that did nothing.** Choosing a purpose card wrote the policy but the
  composition store read it only at boot, so the card never marked itself.
- **A message that outlived its subject.** Security's page-level success box
  still said "PIN unlock enrolled" after a rotation had removed the PIN, and
  failures drew behind the sheet that caused them. Success is the row's own mark
  (announced), a failure is a notice in the tray.
- **A rotation that said less than it did.** Rotating the vault key kept only
  the password and silently removed the recovery key, the authenticator and the
  recovery codes; the sheet named only "passkey/PIN". It now lists exactly the
  enrolled ones before and after.
- **Dev only, and fatal there.** `main.tsx` renders under StrictMode; the
  authenticator sheet's cleanup cancelled an enrollment its re-mount never began,
  so the first code was refused with "Start authenticator enrollment first."
- **Household sharing has no Pages surface** (2026-10-07).
  `sharing.household` registers nothing
  (`modules/sharing.household/runtime.ts`). Its switch is not drawn
  (`NO_SURFACE`) unless a plan already approves it, so a persisted selection
  can still be turned off. Live sessions keep the Sharing section.
