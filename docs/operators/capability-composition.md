# Capability composition

Operator guide for [ADR 0130](../adr/0130-operator-controlled-capability-composition.md).
How to decide what an OpenSesame deployment contains, what it permits, and
what a device may run — and how to see which of those three you are looking at.

## The one rule

Three questions are separate and stay separate:

```
what the release contains  ∩  what the operator permits  ∩  what this device selected and consented to
```

Each narrows the one before it. Nothing widens. A policy that permits a
capability the build does not carry approves nothing; a device that selects a
capability the policy prohibits runs nothing. If you take one thing from this
page: **turning a capability on in Settings changes what this browser loads, it
does not change what your deployment serves.**

## 1. A capability is not an operation

| | Capability | Operation |
|---|---|---|
| Example | `connectors.external` | `connections.create` |
| Shape | `family.name[-name]` | the existing `@opensesame/capability-registry` id |
| Who picks it | a person or an operator, once | nobody — it is dispatched |
| Where it lives | `packages/app-core/src/lib/capabilities/catalog.ts` | `packages/capability-registry` |
| What it gates | whether the implementation is loaded at all | whether this principal may do this now |

A capability **owns** operations; it is not one. Nothing in the registry was
renamed. The mapping is one file,
`packages/capability-registry/src/capability-map.ts` (132 operations at the time
of writing), and the catalog test asserts that a descriptor's `operationIds`
are exactly that map grouped by value.

Two more identifiers you will see in emitted files and never have to author:

- **module id** — `connectors.external/runtime`, an executable unit the loader
  may fetch. Only compile-time-known modules exist.
- **asset id** — a path in `dist/`. The build writes the mapping.

Seven capabilities are statically linked:
`shell.navigation`, `vault.passwords`, `vault.local-unlock`,
`backup.local-encrypted`, `identity.brokered-signin`, `settings.core`,
`install.pwa`. Eight more are **always-on** (ADR 0135, ADR 0142): core in
every plan, code still a module after boot — `vault.interop-formats`,
`backup.cloud-secrets`, `identity.ceremonies`, `activity.log`,
`support.guided-help`, `identity.site-broker`, `backup.git-remote` and
`sharing.drops`. None of those is a switch. An older selection that still
names one is read as though it did not.

Connections, Access and Identity are optional (ADR 0153). The minimal plan
approves `vault.passwords`, `activity.log` and `settings.core` and no
optional capability. `~/connections`, `~/access` and `~/identity` load only
after their Settings › Capabilities switch is on (`capability.<id>` is the
OpenFeature flag). The minimal vault's only creatable kinds are `secret` and
`file`. Account, note, card, passkey, certificate and the other built-in types
project onto that secret and stay out until Item types is on. Password reset
(`ai.password-reset`) is its own section, off until chosen, and it depends on
the account item type (`vault.derived-records`).

**Withdrawing an always-on capability.** A verified instance policy may list
an always-on capability in `prohibited`. The capability is then withdrawn: it
is not approved and its module is not loaded. Every always-on capability that
depends on it goes with it. An optional capability that depends on it sees a
prohibited dependency. Statically linked core cannot be withdrawn, because it
has no module to leave out. Settings › Capabilities says "withdrawn by
operator" in a notice and on the section the capability backs.

A policy a version-1 preset wrote (`presetProvenance.version: 1`) listed
every optional id the preset did not offer, so it may name the site broker,
git backup or secret drops in `prohibited` without anyone having chosen that.
The store drops those three from such a policy when it reads it. Identity is
optional again (ADR 0153), so a version-1 prohibition of browser-local IAM or
SIOP stands. To withdraw the site broker, git backup or secret drops, write
it into a policy you author yourself, or apply a preset again (presets are
version 2 now) and add it.

Git backup's automatic calls are held while the plan does not allow external
services, whichever surface starts them (`backup-egress-gate.ts`). They are
the observer's start, its webhook poll and the push after a vault mutation. A
sync a person asks for by hand still runs. A withdrawn git backup makes no
call at all. A non-empty `allowedServiceOrigins` is an allowlist for every
backup call.

An `allowedServiceOrigins` entry is exactly what `URL.origin` prints (scheme,
host, a non-default port, nothing else) over `https://` or `wss://`, or over
`http://` or `ws://` to loopback only; a path, credentials, a wildcard host or
a bare scheme refuses the document, naming the entry. A `wss://` origin is its
own entry: a Content-Security-Policy `https:` source does not admit a
WebSocket, so `https://relay.example.com` never stands in for
`wss://relay.example.com`. `security-headers.mjs` puts each listed origin into
`connect-src` as itself, only while `externalServices` is `allow`. An empty
list still widens to `https:` alone, as before; it never adds a `wss:`
wildcard, so a deployment that sends headers and wants WebSocket carriers must
list them.

Live sessions (`sharing.live`) reach external services only through what the
owner names in Routes, and a hardened deployment governs those:

- Prohibit it (`prohibited: [sharing.live]`) and the join road, the tab and
  every carrier are gone; a session already running when the plan stops
  approving it ends at once, hosted or joined.
- Allow it, and list each carrier's origin: `https://ntfy.example.com` for
  ntfy, `wss://relay.example.com` for Nostr, MQTT and NATS. Under
  `externalServices: deny`, or an origin not on a non-empty list, the carrier
  is refused before anything is contacted, and the person sees **Blocked by
  this installation: relay.example.com**, not Unreachable.
- STUN and TURN servers are WebRTC, which `connect-src` does not govern. The
  policy cannot narrow them; prohibit `sharing.live` to keep them out.

The operator guide for the routes is
[`live-sessions.md`](live-sessions.md#under-a-hardened-deployment).

Settings › Capabilities is one list of **sections**
(`packages/app-core/src/lib/capabilities/features.ts`), each drawn the same
way: a subheader and the tiles configured under it. In order: Guests,
Identity, Access, Connections, Directory, Encryption, Certificate authority,
Backups, Password managers, Cloud secret storage, Local storage, Encrypted
search, Item types, Environments, Breach and two-step checks, Browser autofill,
Sharing, Payments, AI, Password reset, Surrogate credentials, Networking, Local
notifications, Notifications, Telemetry, and — for the operator — Instance
policy. A section is drawn only where it has a switch or a tile that acts (ADR
0158): External telemetry and Certificate authority are optional so an
operator can prohibit them, but have no Pages code behind them, so they have
no switch (`NO_SURFACE` in `feature-surface.ts`) and Telemetry, left with nothing to
draw, is absent, except while the plan already approves one: its switch then
stays, so it can be turned off. Connector tiles (Backups, Password managers,
Cloud secret storage, Local storage, and the providers under Identity,
Payments, AI and Networking) are the Connections capability's pages
(`/settings/connections/<id>`, ADR 0153), so they are drawn while Connections
runs and not before. A capability another running one is built on shows
*needed by …* in place of its switch. A section with optional
capabilities carries one switch on its
subheader over all of them; a section with more than one (Sharing, AI) also
lists each as a tile with its own switch. A section of an always-on function
has no switch. Every optional capability and every connector family has
exactly one section. **Guests** is on unless an operator turns it off.

**Runtime-installed plugins** (ADR 0150 §7, `spec/plugins/catalog.json`).
Browser autofill (`vault.browser-autofill`) and Surrogate credentials
(`agents.surrogate-credentials`) are optional, default off, and never
always-on. Their plugins — the `opensesame-surrogate-proxy` binary and the
companion autofill extension — are in no default build and never in the
Pages bundle; a person installs one at a terminal on the daemon's machine,
and it stays off until switched on. Switching a section on loads only the
Settings tile for its plugin: what the daemon paired over the tailnet
(`networking.tailnet`, pulled in as a dependency) reports as installed, on,
off or forced off, one key that switches it there (`PUT /v1/plugins/{id}`),
and for the proxy its recent tripwires by event, time and subject. A forced
off plugin (`OPENSESAME_PLUGIN_<ID>=off` on the daemon) cannot be turned on
from Pages. Each plugin's state is also the read-only file
`settings/capabilities/plugins/<id>.json`. With no daemon paired — a guest,
a locked vault, nothing paired — the tile sends nothing.

## 2. The five scopes, and which one wins

| Scope | Document | Can do | Cannot do |
|---|---|---|---|
| Distribution | `capability-distribution.json`, emitted per build | say what this release contains | be changed from a browser |
| Instance | `InstanceCapabilityPolicy` | name required / optional / prohibited roots and the network envelope | exceed the distribution |
| Workspace | `WorkspaceCapabilityRestriction` | narrow further, per vault | permit anything the instance did not |
| Installation | `InstallationCapabilitySelection` + `ConsentReceipt` | select from what is permitted | select what is not permitted |
| Vault session | `VaultCapabilitySelection` | disable, inside one vault | enable anything |

**The narrowest scope wins, always.** The resolver
(`packages/capability-composition/src/resolve.ts`) computes an optional
capability as permitted only when it is distributed, and in the instance
policy's `required` or `optional` sets, and not in `prohibited`, and allowed by
the workspace, and not disabled in the vault. A property test with a recorded
fast-check seed enforces that tightening never enlarges the approved set.

Two distinctions that bite if you get them wrong:

- **Absent inherits; explicitly empty does not.** `allow: null` on a workspace
  restriction inherits the instance ceiling. `allow: []` permits none of the
  optional capabilities. They are different values and the parser keeps them
  different.
- **`capabilities.default` is always `deny`.** An optional capability you do
  not list in `required` or `optional` is prohibited by omission. `prohibited`
  is for refusals you want *recorded*, so a later preset switch cannot quietly
  add them back.

A required root a person declines is a **refused join** — not an enabled
capability, and not a deleted vault. Nothing optional is approved until every
required root is accepted.

### Consent, separately

Permission is not consent. Applying a selection writes a `ConsentReceipt`
binding the exact roots and the exposure digest of every capability in the
closure. A capability whose declared exposure later grows — a new dependency,
a new egress destination, a new browser permission, a new key privilege, a new
worker requirement — drops back to `CONSENT_REQUIRED` and shows up in the
review delta until it is accepted again.

None of these is consent: a skipped setup tab in `setup.v1`, an endpoint URL in
`settings.v1`, a remembered model provider, an imported vault, a URL callback,
a cached module. `packages/app-core/src/lib/capabilities/migration.ts` reads those old
records and *suggests* capabilities for a draft. It enables nothing, and its
`enabled` field is typed as the empty tuple so it cannot.

## 3. Purpose presets, and exactly what each selects

A preset is a starting point, authored as data in
`packages/app-core/src/lib/capabilities/presets.ts`. It approves nothing by itself:
`required` must be accepted to join, `optional` is offered unselected, and
`defaultSelected` is pre-ticked in a draft that still needs Apply and a receipt.

`presetToInstancePolicy()` projects a preset onto an instance policy and records
every optional capability the preset does **not** offer in `prohibited`.

The two "local functions" — optional capabilities that run on this device
with no connector, enterprise, agent, remote-AI or telemetry surface — are
`sharing.live` and `support.local-ai`. Browser-local IAM, SIOP, the site
broker and git backup are always on (ADR 0142). Secret drops are always on
too, so no preset names `sharing.drops` as optional. Family still chooses
it as Household sharing's transport.

| Preset | Required | Offered | Pre-ticked | External services |
|---|---|---|---|---|
| **Personal** | none | the 2 local functions | nothing | allow |
| **Family** | none | the 2 local functions + `sharing.household` | `sharing.household` | **deny** |
| **Homelab** | none | every optional capability | nothing | allow |
| **Organization** | none | every optional capability | nothing | allow |
| **Custom** | none | every optional capability | nothing | allow |

Personal and Family never offer and never pre-select the
`connectors.*`, `enterprise.*`, `agents.*` or `telemetry.*` families, nor
`support.remote-ai`. Homelab and Organization *offer* those families but never
pre-select them.
`presets.test.ts` pins both rules.

## 4. Authoring, exporting and publishing an instance policy

Three actions, deliberately distinct, and the configuration UI labels them
that way:

- **Save on this device** — writes the personal-local policy to
  `capabilities.policy.local.v1`. Only a personal-local instance is editable
  here; a same-origin or signed policy is read-only
  (`capabilityResourceEditable()` in
  `packages/app-core/src/lib/configuration/capabilities-resources.ts`).
- **Export instance configuration** — hands you a file,
  `opensesame-instance-configuration.yaml`, containing the policy and the
  selection. No service is contacted; it is a Blob and a click
  (`capabilities-export.ts`, `screens/capabilities/download.ts`). Reimporting
  it must yield exactly the document it was made from (`reimportMatches`).
- **Publish deployment configuration** — produces the YAML you paste into the
  deployment's `os-runtime-config.json` under `capabilityComposition`. It is
  offered only when a publication capability is approved.

### The documents, and the exact shapes the parsers accept

Four documents are projected as YAML resources by the S04 adapter, under the
display paths `capabilities/instance-policy.yaml`,
`capabilities/installation-selection.yaml`,
`capabilities/vault-restriction.yaml` and `capabilities/effective-plan.yaml`
(read-only). `.yml` is an accepted alias for each. Settings' file viewer lists
three of them, under `settings/capabilities/`:
`installation-selection.yaml`, `instance-policy.yaml` (listed, read and written
only for the device's operator, and refused while a deployment owns the
policy) and `effective-plan.yaml` (read-only). The vault restriction is not
listed in the file viewer; it remains an adapter resource
(`commitVaultRestrictionSource`) with its own display path.

The parsers are strict on purpose. Every field must be present, typed, bounded
and known; there is no lenient mode and no default fill-in. A document is
refused — never truncated, never partially applied — for any of: an unknown
field, a `capabilities.default` other than `deny`, an `updates` block other
than the one fixed shape, a duplicate mapping key, a YAML anchor (`&`), alias
(`*`) or explicit tag, nesting deeper than 8, or more than 64 KiB.

**`capabilities/instance-policy.yaml`**

```yaml
# Household instance policy.
schemaVersion: 1
kind: InstanceCapabilityPolicy
instanceId: inst-family
revision: "2026-09-22.1"
presetProvenance:
  id: family
  version: 2
capabilities:
  default: deny
  required: []
  optional:
    - sharing.live
    - sharing.household
    - support.local-ai
  prohibited:
    - connectors.external
    - telemetry.external
network:
  externalServices: deny
  allowedServiceOrigins: []
updates:
  unknownCapabilities: deny
  expandedExposure: require-approval
```

`presetProvenance` may be `null` but must be present. `required`, `optional`
and `prohibited` must be pairwise disjoint. `revision` is an opaque string you
choose; bump it whenever the policy changes, because a selection accepted
against a superseded revision is treated as stale and re-asks for consent.

**`capabilities/installation-selection.yaml`** — written by the device, not by
you, but this is the shape you will read in an export:

```yaml
schemaVersion: 1
kind: InstallationCapabilitySelection
instanceId: inst-family
installationId: device-fam-1
basePolicyRevision: "2026-09-22.1"
revision: "3"
acceptedRequired: []
selectedOptional:
  - sharing.household
  - vault.passkey-records
chosenAlternatives:
  transport: sharing.drops
delivery:
  prefetch: selected
  offlineCache: selected-only
```

`chosenAlternatives` maps a slot name to the capability chosen for it. Nothing
falls back automatically: if the chosen alternative is unavailable, the root
conflicts rather than silently taking the other one.

**`capabilities/vault-restriction.yaml`** — per-vault, disable-only:

```yaml
schemaVersion: 1
kind: VaultCapabilitySelection
instanceId: inst-family
installationId: device-fam-1
vaultId: project-4f2a
revision: "1"
disabled:
  - sharing.household
```

**In the deployment's `os-runtime-config.json`**, the policy goes under one key:

```json
{
  "capabilityComposition": {
    "schemaVersion": 1,
    "instancePolicy": { "schemaVersion": 1, "kind": "InstanceCapabilityPolicy", "...": "..." }
  }
}
```

An absent `capabilityComposition` section means a personal-local installation:
the ceiling is every distributed optional capability, and the device authors
its own policy. That is the default, and it is not an error.

A profile file under `apps/pages/capability-profiles/` is the same two
documents in one JSON object (`{ "instancePolicy": …, "installationSelection": … }`),
which is what makes an operator configuration testable and buildable. Eleven
are checked in, from `minimal-local` (core only) to `rich-explicit` (all 29
optional) and four rejection cases (`managed-invalid-instance`,
`managed-invalid-revision`, `managed-invalid-signature` and
`managed-missing-required`).

## 5. Selective or hardened: when a change needs a new artifact

| | Selective (default) | Hardened |
|---|---|---|
| What is on the host | every first-party module | only the profile's allowed graph |
| What a device loads | its accepted closure | its accepted closure |
| Excluded HTML entries (`auth/redirect.html`) | emitted | not emitted |
| Excluded public files, worker variants | emitted | not emitted |
| Build fails on reachability of an excluded module | no (unless `OPENSESAME_GRAPH_GATE=enforce` is set) | **yes** |
| Changing the answer | a setting | **a new build** |

Choose hardened when the requirement is that an implementation *not be on the
server* — anyone can fetch a chunk from a selective build directly. Selective
delivery is a load decision, not an exclusion.

Anything that changes what the artifact contains needs a new artifact:
distributing a capability that was excluded, emitting a worker variant an
installation now needs (`requiresNewArtifact` on the change review says so
explicitly), or adding an HTML entry or public file a hardened profile omitted.
Everything else — permitting, prohibiting, selecting, deselecting, disabling in
a vault — is a document change.

```bash
export NODE_OPTIONS="--max-old-space-size=8192"

# One profile, one mode. The script runs security-profile.mjs, builds in a
# child process so OPENSESAME_* is read fresh, then verifies the emitted dist.
# Relative paths resolve against apps/pages, whatever the working directory.
node apps/pages/scripts/build-profile.mjs \
  --profile capability-profiles/family-local.json \
  --mode hardened \
  --out dist-profiles/family-local-hardened \
  --expect-absent connectors.external/runtime

# The whole matrix (eight builds), aggregated into
# apps/pages/dist-profiles/measurements.json
node apps/pages/scripts/build-profile.mjs --all

# Verify a dist someone else built, independently of the plugin's own claim
node apps/pages/scripts/verify-capability-graph.mjs --dist dist \
  --profile capability-profiles/family-local.json --mode hardened
```

The package scripts `pnpm --filter @opensesame/pages build:profile` and
`pnpm --filter @opensesame/pages verify:capability-graph` run the same two
files; invoke them through `node` when you need to pass flags.

The three environment variables the Vite config reads are
`OPENSESAME_CAPABILITY_PROFILE` (a profile JSON path; absent means
`rich-explicit`'s distribution), `OPENSESAME_BUILD_MODE`
(`selective` | `hardened`, default `selective`) and `OPENSESAME_GRAPH_GATE`
(`enforce` | `report`; a hardened build enforces by default, and a selective
build fails on reachability only when you name `enforce`).

## 6. Offline and worker consequences

A service worker cannot `import()`, so worker code is a set of **static
variants** built from one source tree, and the installation runs exactly one:

| Variant | Script | Satisfies | Emitted when |
|---|---|---|---|
| `core-only` | `sw.js` | — | always |
| `push` | `sw-push.js` | `push` | `notifications.web-push` is distributed |

The plan names the variant (`requiredWorkerVariant`, `null` meaning core-only).
Consequences an operator should expect:

- **A capability needing a variant this build lacks is not approved.** It
  resolves `WORKER_GRAPH_UNAVAILABLE`, and so does any pair of capabilities no
  single variant can serve together.
- **One scope runs one worker, and approval moves it.** When the registered
  script differs from the one the plan requires, the controller reports
  `transition-required` and then replaces the script in place — the persisted
  selection and consent receipt `variantEligible` demands are the consent, so
  approving Push notifications installs `sw-push.js`, and a page that boots with
  it already approved does the same. It never unregisters (that would leave no
  worker and drop the push subscription) and never registers a second scope.
  - **What the status says.** `variant` is the worker that is *active*;
    a replacement still installing is `pendingVariant` only. A replacement that
    turns redundant or does not activate within a minute leaves the worker in
    charge, sets the diagnostic `WORKER_INSTALL_FAILED`, and nothing that
    depended on it happens; the next plan change tries again. Chrome activates
    an installed worker once the old one is idle, and with a second tab open it
    can fail to: the old worker, being stopped, is started again by a request
    from the other tab's page, and the new one stays `installed` for good
    (about one run in eight, measured; no `skipWaiting` ordering, `update()` or
    re-registering the same script URL cures it). The controller therefore
    waits five seconds, and if the replacement is still waiting it registers the
    same script again under a new query (`sw-push.js?r=1`, then `r=2`): a new
    version, which Chrome activates through the ordinary path (0 stuck in 60
    lab runs). Every comparison of "is this the required worker" ignores the
    query. Redundant, or still not active after a minute, is `WORKER_INSTALL_FAILED`
    as before, and a request to register that never answers is bound by the same
    minute. A replacement still waiting when the controller gave up is not left
    for the life of the page: the controller looks again after 30 s, 2 min and
    10 min (three times at most), each time through the ordinary transition under
    a URL no worker holds. `verify:push-worker` runs with two tabs and no nudge.
  - **Reloads.** A page reloads on a change of controller only for a different
    *release*. It learns the release it runs from its first controller, and asks
    the worker that takes over which release it is; the same release means the
    page keeps running — in the tab that approved and in every other tab of the
    origin, whose unlocked vaults are not touched. No answer within two seconds,
    or a page that never knew its release (its first load), reloads as it
    always did.
  - **Removal.** Removing the capability returns the core worker (the core
    worker has no `push` handler). Once the core worker is active the browser's
    push subscription is dropped locally, and the Identity API's id for it moves
    from `push.subscription.id` to the pending list `push.forget.pending`. The
    Identity API is told to forget pending ids the next time the Push row is
    shown with a session, or push is turned on again — not at removal, because
    the capability is then withdrawn and its egress refuses. Until then the
    Identity API still lists the record; it also drops it when the push service
    answers 404 or 410. Turning push off with the row, or turning it on again,
    keeps an id the service could not be told about in the same list rather than
    losing it.
  - **After removal.** An enrolment request still in flight has no road out: the
    seam is closed (refused as `capability-not-approved`), never the raw
    `fetch`. Every call to the Identity API and the browser's `subscribe` is
    bounded (15 s and 30 s).

  `pnpm --filter @opensesame/pages verify:push-worker` walks approval, a second
  tab, a push delivered through CDP and removal in a real browser.
- **Caches are namespaced** `opensesame-pages:<scopePath>:<releaseId>:<variant>`,
  and cleanup touches only names matching that application and scope path.
  (The pre-composition worker deleted every cache on the origin. That is fixed;
  see `baseline.md`.)
- **Offline assets are staged from a module-id plan.** The page posts
  `{ type: "PLAN_ASSETS", releaseId, moduleIds }`; the worker resolves those ids
  to files through the same-origin `capability-graph.json`. It never accepts a
  URL from a page, and ignores any message outside that vocabulary.
- **`delivery.offlineCache: "shell-only"`** caches the shell and nothing else;
  `"selected-only"` stages the approved closure's assets. The worker saves a
  plan's files all or nothing, and the installation-wide offline status says
  which (`saved`, `partial`). Per capability, one that is approved but **not
  running in this document** — still on its way, refused, or waiting to
  reload — reads `cached-offline` (Settings: `saved offline`) once the worker
  has saved every one of its page modules, and `approved-not-loaded` until
  then. A running capability reads `active`, whatever is saved. This is a
  lifecycle, not a reason code: cache state is reported by the worker and
  projected onto the plan, never resolved, because a cache report must not
  re-resolve the plan and revoke every running lease.

Turning `notifications.web-push` off does not stop a worker mid-flight: the
plan asks for `core-only`, the controller reports the transition, and the
change lands when it is taken.

## 7. Seeing what is actually true

Five different facts, five different places. None of them implies another.

| Question | Where to look |
|---|---|
| What does this release **contain**? | `dist/capability-distribution.json` |
| Which file carries which capability? | `dist/capability-graph.json` (source module → chunk, static and dynamic edges, CSS/asset edges, workers, public files, classification with rationale) |
| What does the policy **permit**, and why not? | Settings › Capabilities: a capability the policy does not permit shows its reason as a mark in place of its switch; the full reason codes (`explainCapability`) are in the file `settings/capabilities/effective-plan.yaml`. The policy authored on this device is `settings/capabilities/instance-policy.yaml`, listed to the device's operator only |
| What did this device **select and accept**? | Settings › Capabilities, the file `settings/capabilities/installation-selection.yaml` |
| What did the resolver **decide**? | Settings › Capabilities, the file `settings/capabilities/effective-plan.yaml`, read-only |
| What is **cached** and what is the worker doing? | the offline status in Settings (`online-only`, `saving`, `saved`, `partial`, `storage-unavailable`), and `saved offline` on an approved capability not running here whose page modules the worker saved |
| What is **loaded and running** right now? | the switch says on or off; beside it a status glyph says what a switch cannot — `starting`, `consent required`, `restart required`, `reload to start`, `saved offline`, `conflict`, `acceptance required`, `selected · not yet applied`, `needed by …` |

The status vocabulary is deliberately not collapsible. `approved` means the
plan would load it; `active` means it is running; `restart required` means its
module already ran in this document and cannot be unloaded — deselecting it
revokes its registrations and aborts its lease, but the namespace stays until
the page reloads. A preview never reads as applied: a draft says
"selected · not yet applied".

Reason codes you will see on an unapproved capability: `NOT_DISTRIBUTED`,
`PROHIBITED_BY_INSTANCE`, `NOT_PERMITTED_BY_INSTANCE`, `DENIED_BY_WORKSPACE`,
`DISABLED_IN_VAULT`, `NOT_SELECTED`, `REQUIRED_NOT_ACCEPTED`,
`CONSENT_REQUIRED`, `DEPENDENCY_CONFLICT`, `ALTERNATIVE_NOT_CHOSEN`,
`UNSUPPORTED_RUNTIME`, `POLICY_UNVERIFIED`, `PROFILE_MISMATCH`,
`NETWORK_POLICY_DENIES`, `WORKER_GRAPH_UNAVAILABLE`, `RESTART_REQUIRED`.
One reason sits on an approved capability: `RELOAD_REQUIRED` — it must start
in a fresh document, this one has already run other modules, and it was
approved after load; it reads `reload to start` and the loader refuses it
until the page reloads.

## 8. Recovery

### A managed policy is invalid

The store enters `managed-invalid`: the plan is core-only, every optional
capability carries `POLICY_UNVERIFIED`, and the network envelope is denied.
Nothing optional loads. This is fail-closed and deliberate — there is no
permissive default.

It happens when `os-runtime-config.json`'s `capabilityComposition` section is
not an object, has a `schemaVersion` other than 1, is missing `instancePolicy`,
or contains a policy the parser rejects; or when the trust layer refuses the
envelope (wrong instance, wrong origin, unknown key id, an algorithm the
verifier does not accept, a rollback to an older revision, or the same revision
with a different digest).

To recover:

1. Read the diagnostics. The snapshot carries human-readable, never-secret
   diagnostics, and the parser's messages name the exact path
   (`capabilityComposition.instancePolicy: …`).
2. Fix the document at the deployment, not on the device — the same-origin
   policy is read-only in the editor by design.
3. Bump `revision`. A rollback to a revision the device has already accepted is
   detected and refused, so re-serving the old document will not clear it.
4. Reload. The policy is re-read at boot.

An **expired** policy is not the same thing: it keeps running and keeps
governing the device, and only stops accepting anything new. There is no
trusted offline clock, so this is the honest behaviour rather than a gap.

### A vault will not open, or a protector is missing

Nothing in capability composition can take away a way in. `vault.local-unlock`
(password, PIN and passkey protectors, the second step, recovery codes, the
device vault list) and `backup.local-encrypted` (encrypted export, import and
recovery) are **core tier**: always distributed, never prohibitable, never
deselectable, and approved with the single reason `CORE` even when the policy
is invalid. `identity.brokered-signin` — the front door, guest included — is
core too.

So if a device cannot be opened, the cause is in the vault's protectors
(see [ADR 0091](../adr/0091-account-exits-and-unlock-ceremony.md)), not in a
capability selection. Composition's only contribution to the problem would be a
missing *optional* capability, and the fix for that is the next section.

### A capability you need is unavailable

Match the reason code to the scope that refused it:

- `NOT_DISTRIBUTED` → the build does not carry it. New artifact (§5).
- `PROHIBITED_BY_INSTANCE` / `NOT_PERMITTED_BY_INSTANCE` → the operator policy.
  Edit and bump the revision.
- `DENIED_BY_WORKSPACE` / `DISABLED_IN_VAULT` → the per-vault restriction.
- `NOT_SELECTED` → select it in Settings › Capabilities and apply.
- `CONSENT_REQUIRED` → review and accept the delta.
- `REQUIRED_NOT_ACCEPTED` → a required root is unaccepted, so *nothing* optional
  is approved. Accept it or the join stays refused.
- `DEPENDENCY_CONFLICT` / `ALTERNATIVE_NOT_CHOSEN` → `explainCapability` gives
  the chain; fix the dependency or choose the slot's alternative explicitly.
- `WORKER_GRAPH_UNAVAILABLE` → the build has no worker variant for it, or two
  approved capabilities want variants that cannot coexist.
- `PROFILE_MISMATCH` → the stored selection names another instance or device,
  or was accepted against a superseded policy revision. Re-accept.
- `RESTART_REQUIRED` → reload the document.

### Stopping something right now

Settings › Capabilities turns a capability off with its switch: the ordinary
reviewed commit with the root removed. The store's emergency disable
(`compositionStore.emergencyDisable`) is not on that page any more (ADR 0142
§3) — a second key per capability beside its switch was the page saying the
same thing twice. It still blocks in memory first and aborts the lease before
it asks storage, so the capability stops being reachable even if the durable
write then fails (and the outcome tells you which happened).

A commit is refused rather than guessed when Web Locks are unavailable, when
another context has committed a newer generation, when the durable write fails,
or when the receipt does not cover the draft.

## 9. Adding a capability

Every new user-facing feature is a capability. Five things, in addition to
[ADR 0065](../adr/0065-agent-surface-parity.md)'s registry entry:

1. a descriptor in `packages/app-core/src/lib/capabilities/catalog-optional-*.ts`;
2. a module entry `apps/pages/src/modules/<capability-id>/runtime.ts` exporting
   `capabilityRuntime`, with no top-level side effects;
3. an ownership rule (the map in `lib/capabilities/ownership.ts` derives the
   runtime entry; a worker part is listed explicitly) and a source
   classification rule;
4. an operation mapping in `packages/capability-registry/src/capability-map.ts`;
5. a profile fixture that proves its **absence** — `minimal-local` resolves to
   zero optional capabilities and the build gate asserts the module is in no
   chunk.

## Related

- [ADR 0130](../adr/0130-operator-controlled-capability-composition.md) — the decision
- [`docs/validation/capability-composition.md`](../validation/capability-composition.md) — how each claim is verified
- [`docs/evidence/capability-composition/`](../evidence/capability-composition/) — baseline, limitations, contract matrix
- [`docs/implementation/capability-composition/ownership.md`](../implementation/capability-composition/ownership.md) — the interface contract
- [ADR 0090](../adr/0090-static-frontend-complete-without-backend.md) — the static front end is complete without a backend
