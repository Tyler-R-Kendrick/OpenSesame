# ADR 0138 — Settings › Capabilities: one list, honest defaults

- Status: Accepted
- Date: 2026-09-24
- Amends: [ADR 0135](0135-always-on-capabilities-and-feature-rollups.md)
  (§2 features, §3 the page)
- Supplements: [ADR 0130](0130-operator-controlled-capability-composition.md),
  [ADR 0090](0090-static-frontend-complete-without-backend.md)

## Context

ADR 0135 drew Settings › Capabilities as three different things stacked on
one page:

1. **Feature rows** (Guests, AI, Backups, Payments, Servers, Sharing,
   Networking, Notifications, Telemetry): bordered cards on a surface
   background, bold titles, a switch at the row's edge, and each feature's
   providers revealed only while it was on.
2. **Provider groups** (Identity providers, Encryption, Password managers,
   Cloud secret storage, Local storage): a small subheader over a grid of
   connector tiles.
3. **Advanced**, a collapsible holding the fifteen optional capabilities as
   rows again, and the operator's instance policy, which listed the same
   fifteen a third time (as `NOT_SELECTED` reason codes) under a second
   Visual / Source / Effective toggle.

Measured on a freshly sealed personal vault: 39 card rows, 10 switches, 15
headings in three styles.

The feature list had been taken verbatim from a list of words, and it
overlapped the provider groups. **Servers** was mostly identity: browser-local
IAM, SIOP and the site broker are this device as an identity host.
**Backups** and **Local storage** both drew a git backup road
(`password-store` is one, with its own backup switch). The `certificates`
family had no provider to draw.

The page also misreported what the default install runs. Browser-local IAM,
SIOP, the site broker and git backup need no Host and no Identity API. The
git history selection defaults to GitHub (`normalizeHistorySelections`). Git
remotes are bound through the always-on Connections, and the Local storage
tile's backup switch worked with the capability off. Yet Advanced listed all
four as "deselected".

## Decision

### 1. The browser-local functions are always on

`identity.local-iam`, `identity.siop`, `identity.site-broker` and
`backup.git-remote` move to `catalog-always-on-local.ts` as `alwaysOn`
descriptors: core tier, in every plan, loaded as modules after boot, never a
switch, never named by a preset or a profile fixture. Each runs entirely in
this browser on the static front end (ADR 0090), and none makes an automatic
call until a person binds something.

Always on still keeps the operator's network envelope (ADR 0135 §1). Git
backup's automatic calls are held while the plan does not allow external
services:
- the observer's start;
- its webhook poll;
- the push after a vault mutation.

The hold is in one place, `backup-egress-gate.ts`, inside the observer.
Every surface that can start the observer goes through it: the
capability's background job, a Settings tile reading the backup status,
and a target being enabled. Under the Family preset the Backups tiles are
drawn, and nothing is pushed on its own. A sync a person asks for by hand
still runs. A non-empty `allowedServiceOrigins` is an allowlist for every
backup call, automatic or not (`backupOriginAllowed`).

**An operator may withdraw an always-on capability.** Always on is the
default, not a mandate. The resolver (`withdrawnCore` in
`resolve-axes.ts`) withdraws an always-on capability that a verified
instance policy names in `prohibited`:
- It is not approved, its module is not loaded, and its state reads
  `PROHIBITED_BY_INSTANCE`.
- Every always-on capability that depends on it is withdrawn with it. For
  example, withdrawing browser-local IAM takes SIOP with it.
- An optional capability that depends on it has a prohibited dependency.

Only core that owns a module can be withdrawn. Statically linked core has
nothing to leave unloaded, and `CORE_IN_POLICY` still diagnoses it. An
unverified policy withdraws nothing.

No descriptor field changes, so no exposure digest and no consent receipt
moves. The page says "withdrawn by operator":
- in a notice;
- on the section the capability backs (`Feature.backedBy`);
- in its status (`capabilityStatus`).

A withdrawn git backup makes no call at all, not even a manual one.

The Identity section is therefore on the rail of a fresh device. Presets
lose the four ids: the local functions are `sharing.drops` and
`support.local-ai`, and Homelab pre-selects nothing. Profile fixtures that
used them to model a refusal now use an enterprise capability or remote AI.

### 2. One list of sections, no overlaps

`FEATURES` in `features.ts` is the page, in order:

| Section | Optional capabilities (its switch) | Connector family |
|---|---|---|
| Identity providers | — | identity |
| Directory | `enterprise.directory-provisioning` | — |
| Encryption | — | encryption |
| Certificate authority | `enterprise.ca-administration` | certificates |
| Backups | — | backup/recovery (the forges and `password-store`) |
| Password managers | — | password managers |
| Cloud secret storage | — | cloud secret storage |
| Local storage | — | local storage |
| Sharing | `sharing.drops`, `sharing.household` | — |
| Payments | `wallet.spending` | wallet |
| AI | `support.local-ai`, `support.remote-ai`, `agents.webmcp` | agent harnesses (+ model picks) |
| Networking | `networking.tailnet` | networking |
| Notifications | `notifications.web-push` | — |
| Telemetry | `telemetry.external` | — |

Guests comes first and the operator's Instance policy last. `PROVIDER_GROUPS`
is gone. Servers is dissolved: its identity-hosting members are always on,
and its two server-backed members are Directory and Certificate authority.
`password-store` moves to the backup/recovery family.

A test pins the invariants: every optional capability belongs to exactly one
section, every connector family has exactly one home, no two sections share
a title, and no always-on function has a switch.

### 3. Every section is drawn the same way

Each section is the Connections catalogue's `conn-group`: a subheader in the
group-label type, then its tiles. A section with optional capabilities puts
its switch on the subheader. There is no card row, no surface background, no
change of font, and nothing collapses. A section's providers are drawn whether
or not its switch is on, because a connector is configured by reference and
binding one needs nothing the switch adds.

A switch shows only on or off. When a capability's state needs more
(starting, consent required, restart required, a conflict, or a draft not
yet applied), a status mark sits beside its switch. A capability that
cannot be switched here shows its reason in place of a switch. A capability
another kept root still needs shows "needed by …" in place of a switch: for
example, Shared drops is Household sharing's transport. Switching it off
alone would review a change that changes nothing.

AI's model picks configure AI, and they probe the browser and the
harnesses when they mount, so they are drawn only while AI is on. Its
harness tiles are connectors configured by reference, so they are always
drawn.

A section with more than one optional capability (Sharing, AI) also draws
each one as a tile with its own switch, beside the provider tiles.
`switchCapability` narrows the section's proposal to that id, so an
alternative slot is still answered. The subheader switch reads "on" while
anything runs and turns the whole section off. There is no separate
"complete" key.

Advanced is removed:

- The per-capability list is the tiles and switches already on the page.
- The instance policy is one more section, holding only the purpose presets.
  Its capability list and its second view toggle are gone.
- The page's one Source view shows the installation selection and, to the
  operator, the instance policy. Effective is shown once.
- The emergency **Disable now** key is gone from this page. The reviewed
  switch is how a capability is turned off here.
  `compositionStore.emergencyDisable` and its tests (LIFE-01, LIFE-09) are
  unchanged.

Every switch that adds or removes exactly one capability carries
`data-capability-title`: a tile's switch, or the subheader switch of a
single-capability section. Browser walks find a capability's switch by its
catalog title (`capabilitySwitch` in `scripts/lib/always-on.mjs`) wherever
it is drawn.

## Consequences

- The page is one list: 16 sections, all in one style, and 21 switches on a
  fresh operator device (Guests, 8 section switches, 5 capability tiles and
  7 backup roads). The Advanced disclosure, the 39 rows and the triple
  listing are gone.
- The `minimal-local` profile still resolves zero *optional* capabilities.
  Core now includes the four browser-local functions, so every build carries
  their modules.
- The catalog has 21 core capabilities (7 static, 14 always-on) and 11
  optional ones.
- A selection or policy that still names one of the four ids is tolerated,
  as ADR 0135 already provides for core ids.
- An operator keeps the last word: a policy may withdraw any always-on
  capability that owns a module, git backup and browser-local IAM included,
  and the withdrawal cascades to what needs it.
