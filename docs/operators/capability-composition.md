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
`packages/capability-registry/src/capability-map.ts` (98 operations at the time
of writing), and the catalog test asserts that a descriptor's `operationIds`
are exactly that map grouped by value.

Two more identifiers you will see in emitted files and never have to author:

- **module id** — `connectors.external/runtime`, an executable unit the loader
  may fetch. Only compile-time-known modules exist.
- **asset id** — a path in `dist/`. The build writes the mapping.

The catalog has **17 core** capabilities and **15 optional** ones. Core is
always present and cannot be prohibited. Seven are statically linked:
`shell.navigation`, `vault.passwords`, `vault.local-unlock`,
`backup.local-encrypted`, `identity.brokered-signin`, `settings.core`,
`install.pwa`. Ten are **always-on** (ADR 0135): core in every plan, but their
code still arrives as a module after boot — `vault.passkey-records`,
`vault.certificate-records`, `vault.interop-formats`, `backup.cloud-secrets`,
`connectors.external`, `access.authority`, `identity.federation`,
`identity.ambient-sso`, `activity.log`, `support.guided-help`. None of them is
ever a switch, and none may be named in a policy or a selection; an older
document that still names one is read as if it did not.

The fifteen optional capabilities are grouped into **features**
(`packages/app-core/src/lib/capabilities/features.ts`): AI, Backups, Payments,
Servers, Sharing, Networking, Notifications and Telemetry. Settings ›
Capabilities shows one switch per feature, with that feature's providers
configured under it while it is on, the providers of always-on functions
below them, and the individual capabilities only under **Advanced**. The same
page carries **Allow guests**, which is on unless an operator turns it off.

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

The five "local functions" — optional capabilities that run on this device
with no connector, enterprise, agent, remote-AI or telemetry surface — are
`sharing.drops`, `identity.local-iam`, `identity.siop`,
`identity.site-broker` and `support.local-ai`.

| Preset | Required | Offered | Pre-ticked | External services |
|---|---|---|---|---|
| **Personal** | none | the 5 local functions | nothing | allow |
| **Family** | none | the 5 local functions + `sharing.household` | `sharing.household`, `sharing.drops` | **deny** |
| **Homelab** | none | all 15 optional | `identity.local-iam` | allow |
| **Organization** | none (sign-in providers and access are always on) | all 15 optional | nothing | allow |
| **Custom** | none | all 15 optional | nothing | allow |

Personal and Family never offer and never pre-select the
`enterprise.*`, `agents.*` or `telemetry.*` families, nor `support.remote-ai`.
Homelab and Organization *offer* those families but never pre-select them.
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

Four documents are projected as editable YAML resources, under the display
paths `capabilities/instance-policy.yaml`,
`capabilities/installation-selection.yaml`,
`capabilities/vault-restriction.yaml` and `capabilities/effective-plan.yaml`
(read-only). `.yml` is an accepted alias for each.

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
  version: 1
capabilities:
  default: deny
  required: []
  optional:
    - sharing.drops
    - sharing.household
    - vault.passkey-records
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
are checked in, from `minimal-local` (core only) to `rich-explicit` (all 15
optional) and the four `managed-invalid-*` rejection cases.

## 5. Selective or hardened: when a change needs a new artifact

| | Selective (default) | Hardened |
|---|---|---|
| What is on the host | every first-party module | only the profile's allowed graph |
| What a device loads | its accepted closure | its accepted closure |
| Excluded HTML entries (`auth/redirect.html`) | emitted | not emitted |
| Excluded public files, worker variants | emitted | not emitted |
| Build fails on reachability of an excluded module | no | **yes** |
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
node apps/pages/scripts/build-profile.mjs \
  --profile apps/pages/capability-profiles/family-local.json \
  --mode hardened \
  --out dist-profiles/family-local-hardened \
  --expect-absent connectors.external/runtime

# The whole matrix (eight builds), aggregated into dist-profiles/measurements.json
node apps/pages/scripts/build-profile.mjs --all

# Verify a dist someone else built, independently of the plugin's own claim
node apps/pages/scripts/verify-capability-graph.mjs --dist apps/pages/dist \
  --profile apps/pages/capability-profiles/family-local.json --mode hardened
```

The package scripts `pnpm --filter @opensesame/pages build:profile` and
`pnpm --filter @opensesame/pages verify:capability-graph` run the same two
files; invoke them through `node` when you need to pass flags.

The three environment variables the Vite config reads are
`OPENSESAME_CAPABILITY_PROFILE` (a profile JSON path; absent means
`rich-explicit`'s distribution), `OPENSESAME_BUILD_MODE`
(`selective` | `hardened`, default `selective`) and `OPENSESAME_GRAPH_GATE`
(`enforce` | `report`, default `enforce` on a build).

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
- **Two vaults at one scope cannot run competing workers.** When the
  controlling script differs from the required one the controller exposes a
  `transition-required` state and moves only on an explicit transition.
  Unregistering a worker does not terminate its clients synchronously.
- **Caches are namespaced** `opensesame-pages:<scopePath>:<releaseId>:<variant>`,
  and cleanup touches only names matching that application and scope path.
  (The pre-composition worker deleted every cache on the origin. That is fixed;
  see `baseline.md`.)
- **Offline assets are staged from a module-id plan.** The page posts
  `{ type: "PLAN_ASSETS", releaseId, moduleIds }`; the worker resolves those ids
  to files through the same-origin `capability-graph.json`. It never accepts a
  URL from a page, and ignores any message outside that vocabulary.
- **`delivery.offlineCache: "shell-only"`** caches the shell and nothing else;
  `"selected-only"` stages the approved closure's assets. A capability that is
  approved but not cached is reported `NOT_CACHED_OFFLINE` — a distinct claim
  from "not approved".

Turning `notifications.web-push` off does not stop a worker mid-flight: the
plan asks for `core-only`, the controller reports the transition, and the
change lands when it is taken.

## 7. Seeing what is actually true

Five different facts, five different places. None of them implies another.

| Question | Where to look |
|---|---|
| What does this release **contain**? | `dist/capability-distribution.json` |
| Which file carries which capability? | `dist/capability-graph.json` (source module → chunk, static and dynamic edges, CSS/asset edges, workers, public files, classification with rationale) |
| What does the policy **permit**, and why not? | Settings › Capabilities, operator view — one row per permitted capability with its reason codes from `explainCapability` |
| What did this device **select and accept**? | Settings › Capabilities, Source view of `capabilities/installation-selection.yaml` |
| What did the resolver **decide**? | Settings › Capabilities, Effective view — `capabilities/effective-plan.yaml`, read-only |
| What is **cached** and what is the worker doing? | the offline status in Settings (`online-only`, `saving`, `saved`, `partial`, `storage-unavailable`) |
| What is **loaded and running** right now? | the per-row status glyph: `active`, `starting`, `approved`, `consent required`, `restart required`, `disabled`, `deselected` |

The status vocabulary is deliberately not collapsible. `approved` means the
plan would load it; `active` means it is running; `restart required` means its
module already ran in this document and cannot be unloaded — deselecting it
revokes its registrations and aborts its lease, but the namespace stays until
the page reloads. A preview never reads as applied: a draft row says
"selected · not yet applied".

Reason codes you will see on an unapproved capability: `NOT_DISTRIBUTED`,
`PROHIBITED_BY_INSTANCE`, `NOT_PERMITTED_BY_INSTANCE`, `DENIED_BY_WORKSPACE`,
`DISABLED_IN_VAULT`, `NOT_SELECTED`, `REQUIRED_NOT_ACCEPTED`,
`CONSENT_REQUIRED`, `DEPENDENCY_CONFLICT`, `ALTERNATIVE_NOT_CHOSEN`,
`UNSUPPORTED_RUNTIME`, `POLICY_UNVERIFIED`, `PROFILE_MISMATCH`,
`NETWORK_POLICY_DENIES`, `WORKER_GRAPH_UNAVAILABLE`, `NOT_CACHED_OFFLINE`,
`RESTART_REQUIRED`.

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

Settings › Capabilities offers **Disable now** — the store's emergency disable.
It blocks in memory first and aborts the lease before it asks storage, so the
capability stops being reachable even if the durable write then fails (and the
outcome tells you which happened). **Retire safely** is the ordinary reviewed
commit with the root removed.

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
