# ADR 0189 — Settings splits into Features and Integrations

- Status: Accepted
- Date: 2026-10-11
- Builds on: [ADR 0130](0130-operator-controlled-capability-composition.md)
  (capabilities are consented, reviewed switches),
  [ADR 0134](0134-item-type-marketplaces-and-settings-files.md) (Settings is
  files, and a page is how a file is seen),
  [ADR 0142](0142-capabilities-page-one-list-honest-defaults.md) (always-on
  functions carry no switch, and the page is one list),
  [ADR 0158](0158-settings-rows-act-or-are-absent.md) (a row acts, or it is not
  drawn), [ADR 0139](0139-one-definition-every-target.md) (one definition),
  [ADR 0163](0163-tutorial-mode.md) (every feature has a replayable tutorial)
- Amends: ADR 0130, 0134, 0142 and 0158 where they say "Settings ›
  Capabilities": that page no longer exists. The documents themselves keep
  their history.

## Context

Settings › Capabilities was one list of 24 sections. A section was a topic, the
optional capabilities its one switch adds and removes, and the connector
families configured under it. Counting what the list actually held:

| Kind of section | Count | Examples |
|---|---|---|
| Switches only | 14 | Access, Sharing, Telemetry, Item types |
| Connectors only | 5 | Backups, Encryption, Password managers, Cloud secret storage, Local storage |
| Both | 5 | Identity, Payments, AI, Networking, Certificate authority |

The two halves are not one thing drawn twice. They differ in mechanism:

- **A feature is a feature flag.** Switching one proposes a plan, goes through
  review and a `ConsentReceipt`, and loads or unloads a module (ADR 0130). It
  can be withdrawn by an operator, depends on other flags, and may need a
  reload.
- **An integration is a connection to a third party** that extends a feature or
  replaces what it does on its own: an identity provider beside browser-local
  IAM, a key service beside WebCrypto, a forge to back up to, an agent harness
  in place of the on-device model. It is configured by reference: the
  connector's page, its credential sealed in the vault, nothing sent until it
  is connected. There is no plan, no receipt and no feature flag (a tile may
carry its own enable switch, as a Backups history road does), and the old page
  already said so — "Nothing collapses: a section's providers are drawn whether
  or not its switch is on".

Mixing them cost real things. A section such as Backups was a subheader with no
switch next to sections with one, so the page needed a rule ("an always-on
function … simply carries no switch") to explain its own shape. `config.yaml`
mixed a read-only list of approved capabilities with three endpoints a person
types. The tutorials for five sections said "has no switch: it is built in".
And `Feature` carried fields (`providerCategories`, `models`) that only half of
the list used.

## Decision

**1. Two settings categories replace one.** `/settings/features` and
`/settings/integrations`, in the tab order General · Keybindings · Security ·
Vaults · Features · Integrations · Danger. `capabilities` is retired as a
category.

**2. Features are the switches.** The sections of `FEATURES` (19; two of them,
Certificate authority and Telemetry, draw a switch only while a plan already
approves them), plus the operator's *Guests* and *Instance policy*. The
capability documents (`installation-selection.yaml`, `instance-policy.yaml`,
`effective-plan.yaml`) live in `settings/features/` beside its `config.yaml`,
which reports `approved` read-only. Section ids are unchanged (`feature-<id>`),
so every link to a switch section survives.

**3. Integrations are the third-party connections.** The sections of
`INTEGRATIONS` (10), one per feature-binding connector family
(`FEATURE_BINDING_CATEGORIES`) — a test pins the two lists to each other.
Section ids are `integration-<id>`. `settings/integrations/config.yaml` holds
the endpoints (`hostApi`, `identityApi`, `daemonApi`). An integration names the
feature it extends when it has the same topic (`extendsFeature`); where the
function it extends is built in (Backups, Encryption, Password managers, Cloud
secret storage, Local storage) it has none, and no feature section carries its
id. The AI model picks are an integration's: they choose between the on-device
model and a hosted provider or harness. They draw only while the AI feature is
on, as before.

**4. Two types, not a filter.** `Feature` keeps `capabilities` and `backedBy`;
`Integration` has `providerCategories`, `models`, `backedBy` and
`extendsFeature`. The lists share no field that makes a section both, so the
invariant "every optional capability has one home, and so does every connector
family" is a property of the types rather than a convention the page follows.
`backedBy` stays on both: Sharing is backed by Shared drops and Backups by git
backup, and either withdrawal is named on the section it affects.

**5. Old addresses redirect, with their anchor.** `retiredSettingsAddress`
(`lib/settings-retired.ts`) is the one table. `/settings/capabilities` lands on
Features; `#feature-<id>` for a built-in function lands on
`/settings/integrations#integration-<id>`; a bare connector-family anchor
(`#backup_recovery`) lands on Integrations; `Connections`, `Backups`, `Cloud
secrets`, `connectivity` and `taskbus` land on Integrations; and
`?file=settings/capabilities/…` becomes `settings/features/…`. A connector's
own page, `/settings/connections/<provider>`, is a current route and is left
alone.

**6. Tutorials follow the split.** Targets are `feature.<id>` and
`integration.<id>`; a tour that points at an integration section is offered
only where that section draws. Tour ids for the five built-in functions move
from `feature.*` to `integration.*`; the task-shaped tours (`settings.backup`,
`settings.model-provider`) walk Integrations, and name the feature's own switch
on Features without leaving the page.

## What did not change

- Capability ids, the catalog, the persisted `capabilities.*.v1` keys, the plan
  and the consent flow. A capability is still a capability; the page that
  switches it is called Features because that is what `FEATURES` has always
  named.
- The connector catalogue at `/connections` and the connector pages at
  `/settings/connections/<provider>`. Integrations are the families bound in
  Settings; the rest of the catalogue is shared through Access.
- The setup screen's own "what this installation runs" tab.
- The `capsection` / `capspanel` CSS classes.

## Adversarial pass

Each row is a way this could be wrong, and what the code answers.

| Challenge | Answer |
|---|---|
| *"Filter the old list into two views and keep one type."* | The filter encodes the split nowhere a test can see. A future `Feature` with both fields would show up on both pages under one name. Two types make the mixed section unrepresentable. |
| *"Backups, Encryption … vanish from Features, so where do I turn them on?"* | You do not: they are always-on functions (ADR 0142), and ADR 0158 forbids a switch that cannot act. Their providers are on Integrations, and the withdrawn-by-operator mark moves with them. |
| *"Integrations should hide while the feature is off."* | No. The old page drew providers regardless because binding a connector needs nothing the switch adds; coupling them would make a flag a precondition for a credential. Only the AI model picks wait on the flag, because they probe the browser on mount and are the feature's own code. |
| *"Two pages both titled Identity will confuse people."* | They sit under different tabs in the rail and the address, and each names what it is: one has a switch, the other has providers. A different title would invent a second vocabulary for the same topic. |
| *"Show 'extends' or 'replaces' on every row."* | It would be an explainer caption, which the design rules forbid (AGENTS.md § 5), about data we do not hold: nothing in the catalog says which a connector does. `extendsFeature` is recorded; a UI for it waits on a reason. |
| *"Redirect only the category."* | An anchor to Backups would land on a page with no such section, and scrolling would silently do nothing. The fragment and `?file=` are part of the address. |
| *"Rename `/settings/connections/<provider>` to `/settings/integrations/<provider>`."* | Larger blast radius (router, ceremony roots, crumbs, tutorials, evidence) for no change in what a person sees. Left as a follow-up; the crumb already reads Settings › Integrations › provider. |
| *"Rename the persisted keys and CSS classes too."* | A persisted key is data, and renaming it is a migration with a failure mode and no benefit. |
| *"`config.yaml` text people already saved will be orphaned."* | Nothing persists that text for Capabilities: the page and the file are one set of values, rebuilt from state, and the legacy seed path now points at Integrations, which holds the endpoints it described. |
| *"Will the mixed-section tutorials still be true?"* | Each tour that named tiles under a switch now names the switch only, and `feature-goals.test.ts` still refuses a tour that promises a switch where there is none. |

## Consequences

- Settings now has two pages where a person previously had to know that a
  section could be both. Each is drawn one way: a subheader and a switch, or a
  subheader and tiles.
- `features.ts` shrinks; `integrations.ts` is new, with a test that pins its
  families to `FEATURE_BINDING_CATEGORIES`.
- Links, bookmarks and tutorials written for Capabilities keep working through
  `retiredSettingsAddress`. The table is the one place to retire the next name.
- A new optional capability is a `Feature` row. A new connector family that
  binds to a feature is a catalog row (`spec/connectors/catalog.json`), a
  `FEATURE_BINDING_CATEGORIES` entry and an `Integration` row — the test fails
  if the last two disagree; the catalog row is what the first of them rests on.
- A user-visible change: the evidence gallery for this decision is under
  [historical evidence](https://github.com/OpenSesame-Labs/OpenSesame/tree/fd554446241e32962e82763ddb772f9420096279/docs/evidence/2026-10-11-features-and-integrations/).
