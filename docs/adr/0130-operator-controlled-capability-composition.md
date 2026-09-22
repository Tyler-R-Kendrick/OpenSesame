# ADR 0130 — Operator-controlled capability composition

- Status: Accepted
- Date: 2026-09-22
- Supplements: [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (the static front end is complete without a backend), [ADR 0065](0065-agent-surface-parity.md)
  (the operation registry), [ADR 0114](0114-tabbed-setup-ceremony.md) (the
  setup ceremony — its tab list is now derived, see §5), [ADR 0115](0115-front-door-and-connector-directory.md)
  (the front door)
- Implementation record: `docs/implementation/capability-composition/ownership.md`
- Evidence: `docs/evidence/capability-composition/`

## Context

A person or operator installing OpenSesame gets everything: external
connectors, enterprise directory and certificate administration, agent
integrations, AI support, a spending wallet. A family that wants a
password-and-passkey vault carries all of it merely to function. Worse, it
carries it in the first request: `main.tsx` statically imported `App`, and
`App` statically imported the connector directory, ambient SSO, the support
model session and WebMCP, so the eager entry chunk was 1.19 MB of code the
household never selected. Hiding a section behind a flag would not have
changed that — the implementation is downloaded, parsed and evaluated whether
or not a rail row appears.

Three separate things were conflated: what a release *contains*, what an
operator *permits*, and what a device *selected and consented to*. And two
more were missing entirely: a truthful account of what is loaded versus
merely hidden, and a build that can leave excluded implementations out.

## Decision

### 1. Four identifier universes, one resolver

- **Capability ID** (`connectors.external`, `vault.passwords`) names an
  installable product function. It is what a person selects.
- **Operation ID** is the existing `@opensesame/capability-registry` action.
  Nothing is renamed; a capability *owns* operations
  (`packages/capability-registry/src/capability-map.ts`).
- **Module ID** (`connectors.external/runtime`) is an executable unit the
  loader may fetch. Only compile-time-known modules exist.
- **Asset ID** is an emitted file. The build writes the mapping.

`@opensesame/capability-composition` is a pure, browser-safe package: no
fetch, clock, storage, DOM or dynamic import. `resolveComposition` takes the
catalog, the distribution contract, the policy documents, the consent
receipt and explicit runtime facts and returns an immutable `EffectivePlan`
with independent axes per capability (distributed, permitted, required,
selected, runtime-supported, approved, restart-required), stable reason
codes, conflicts, the consent delta still owed and a digest that is
independent of input ordering. Restrictions are monotone: a smaller
permitted set can never enlarge the approved set, and a property test
enforces it.

### 2. Scopes that never collapse into one another

| Scope | Document | Authority |
|---|---|---|
| Distribution | `capability-distribution.json` (emitted per build) | what this release contains |
| Instance | `InstanceCapabilityPolicy` (deployment's `os-runtime-config.json`, a signed import, or authored locally for a personal installation) | required / optional / prohibited roots, network envelope |
| Workspace | `WorkspaceCapabilityRestriction` | may only narrow |
| Installation | `InstallationCapabilitySelection` + `ConsentReceipt` | what this browser installation accepted |
| Vault session | `VaultCapabilitySelection` | may only disable |
| Operation | existing principal/resource/grant authorization | evaluated at dispatch by the existing authorities |

An absent restriction inherits; an explicit empty allow set permits none of
the optional capabilities; an explicit empty selection selects no optional
roots. A required root a person declines is a refused join, not an enabled
capability and not a deleted vault.

The catalog has **7 core and 24 optional** capabilities
(`apps/pages/src/lib/capabilities/catalog.ts` and the three
`catalog-optional-*.ts` files; the counts are stated here so a later catalog
change is visible to a reader of this decision). Core-tier capabilities —
`shell.navigation`, `vault.passwords`, `vault.local-unlock`,
`backup.local-encrypted`, `identity.brokered-signin`, `settings.core`,
`install.pwa` — are always present and cannot be prohibited; they are listed
so their exposure is declared, not so they can be turned off. The optional 24
are `access.authority`, `activity.log`, `agents.webmcp`,
`backup.cloud-secrets`, `backup.git-remote`, `connectors.external`,
`enterprise.ca-administration`, `enterprise.directory-provisioning`,
`identity.ambient-sso`, `identity.federation`, `identity.local-iam`,
`identity.site-broker`, `identity.siop`, `notifications.web-push`,
`sharing.drops`, `sharing.household`, `support.guided-help`,
`support.local-ai`, `support.remote-ai`, `telemetry.external`,
`vault.certificate-records`, `vault.interop-formats`, `vault.passkey-records`
and `wallet.spending`.

### 3. Consent is a receipt, not a checkbox

Applying a selection writes a `ConsentReceipt` binding the exact roots and
the exposure digest of every capability in the closure. A catalog update that
adds a capability, or a capability that grows a dependency, an egress
destination, a key privilege or a worker requirement, produces a review delta
and stays unapproved until accepted. `setup.v1`'s `skipped` list, an endpoint
URL in `settings.v1`, an imported vault, a URL callback and a cached module
are none of them consent.

### 4. The import graph is cut at bootstrap, not at render

`main.tsx` is a core bootstrap: frame check, runtime config parsed as data,
core key hydration, plan resolution, then `import("./app-root.js")`. Optional
implementations live under `apps/pages/src/modules/<capability-id>/runtime.ts`
and reach the page only through the generated module table
(`virtual:opensesame-capability-modules`), after `loadApprovedModule` has
checked the current plan and lease, and after the generation is re-checked
following the await. Modules perform no top-level side effects; they register
routes, sections, settings categories, setup panels, commands, shortcuts,
tutorial entries, item kinds, tools, jobs and unlock effects through
registrars that return revocable handles. The shell, the command bar, the
keymap, the tutorial registries and WebMCP enumeration render from those
registrations and nothing else, so an excluded feature has no rail row, no
command, no shortcut, no help entry and no disabled advertisement.

### 5. Setup asks about capabilities first, then only about what was chosen

The setup ceremony's first tab is capability selection: purpose presets
(Personal, Family, Homelab, Organization, Custom) are data, a preset is a
preview until Apply, and every later tab is a `setup-panel` contribution of a
selected capability. ADR 0114's fixed six-tab list is superseded by the
derived list; the executable had four tabs at the time of this decision and
the discrepancy is recorded in the baseline evidence.

### 6. Two delivery modes, one solver

- **Selective**: every first-party module may be on the host; a device loads
  only its accepted graph.
- **Hardened**: a validated profile decides the allowed graph *before*
  bundling. Excluded modules, HTML entries (`auth/redirect.html`), public
  files and worker variants are not emitted; the build fails on reachability
  of an excluded module from any entry, and an independent post-build verifier
  re-derives the closure from `dist/` on disk.

The build emits `capability-graph.json` (source module → chunk, static and
dynamic edges, CSS and asset edges, worker and public files, classification
with rationale). Browser-local selection cannot rebuild a hosted site; the
configuration UI distinguishes **Save on this device**, **Export instance
configuration** and **Publish deployment configuration**, and offers the last
only when a publication capability is approved.

### 7. Workers are installation-wide graph selections

A service worker cannot `import()`. Worker code is therefore a set of static
variants (`sw.js` core-only, `sw-push.js` with Web Push) built from one
source tree; the plan names the variant the installation must run and the
controller never registers competing workers for different vaults at one
scope — it exposes a transition instead. Caches are namespaced by
application, scope, release and variant; cleanup touches only owned caches;
offline assets are staged from a module-id plan the worker resolves through
`capability-graph.json`, never from URLs a page sends.

### 8. OpenFeature projects; it does not decide

`@openfeature/web-sdk` is wired through a local read-only provider over the
store snapshot. Optional capability keys evaluate with `false` defaults, a
release flag can only restrict, and the loader and dispatch gates read the
store directly, so a provider that answers `true` for a prohibited
capability changes nothing.

## What this decision does not claim (P-TRUTH)

- A JavaScript loader does not sandbox same-origin code, control browser
  extensions, or stop the browser's owner from editing local state.
- Evaluated module namespaces cannot be unloaded; a narrower selection after
  optional code ran is shown as **restart required**, and unregistering a
  worker does not terminate its clients synchronously.
- Browser storage rollback and offline clocks are not trustworthy. Accepted
  policy revisions are recorded and conflicts detected; nothing here is
  cryptographic rollback prevention.
- A signed policy authenticates a document against an established key. It
  does not protect a replaced bootstrap and does not establish first-contact
  trust; an invitation that verifies its own key is unverified until the
  fingerprint ceremony.
- A fetch-then-hash followed by `import(url)` would be two loads. Modules are
  same-origin, immutable-URL chunks; no eval, blob module or home-grown loader.

## Consequences

- Every new user-facing feature is a capability: a descriptor in the catalog,
  a module entry, an ownership rule, an operation mapping, and a profile
  fixture that proves its absence — in addition to ADR 0065's registry entry.
- Legacy full-surface tests run under the explicit `rich-explicit` fixture;
  minimal tests run under `minimal-local`. Neither family is deleted.
- `pnpm --filter @opensesame/pages build:profile` and
  `verify:capability-graph` are part of the merge gate for changes to the
  bootstrap, modules, workers or the build.
