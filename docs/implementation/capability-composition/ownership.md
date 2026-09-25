# Capability composition — ownership and interface contract

This is the coordination record for operator-controlled capability
composition (see the ADR in `docs/adr/` once numbered, and the evidence under
`docs/evidence/capability-composition/`). Every runtime, editor, build step
and test codes against the contracts named here. Where this file and a code
comment disagree, fix the code or this file — never add a second resolver,
loader, registry or vocabulary.

## 1. Environment facts (recorded 2026-09-22)

- Checkout: `424bc48cfb74e3c69f4f1f6b44cbe5b2fb979716` on
  `claude/new-session-9wpwbh` (one commit past the inspected baseline
  `f1c1e7a`; it adds SOPS/KMS protectors, Activity, GitHub backup combobox).
- Untracked at start: `packages/database/drizzle/0029_*` (session-start
  `db:generate` artefacts; not part of this change, never committed).
- Node `v22.22.2`, pnpm `9.15.0`, Vite `6.4.3`, vite-plugin-pwa `1.0.3`,
  React `19.2.8`, React Router `8.3.0`, TypeScript `5.8.3`, Vitest `4.1.10`,
  Playwright `1.55.1`, Chromium at `/opt/pw-browsers/chromium`.
- **Environment quirk:** the session's `NODE_OPTIONS` contains `--import tsx`,
  which this Node build refuses (`node: --import tsx is not allowed in
  NODE_OPTIONS`). Every shell command that runs Node must first
  `export NODE_OPTIONS="--max-old-space-size=8192"`.
- Baseline Pages production build (`VITE_BASE=/OpenSesame/ pnpm exec turbo run
  build --filter=@opensesame/pages`, 34 s): `dist/` 3.6 MB, 78 assets; the
  eager entry chunk `assets/main-*.js` is **1,189,653 bytes**; `sw.js` 8,901
  bytes. `index.html` references only `main-*.js` and the modulepreload
  polyfill. The client-core Wasm is not emitted in this environment, so
  `tools/quality/bundle-budgets.json`'s 17.9 MiB `total` is not reproduced here.
- Baseline observations that contradict earlier prose (P-TRUTH):
  - `SetupScreen.tsx` has **four** statically imported tabs (connectors, ai,
    identity, mfa); ADR 0114 describes six.
  - `sw.ts` precaches **only `index.html`** from `__WB_MANIFEST`; the comment
    in `App.tsx` claiming the shell chunk is precached is stale.
  - `sw.ts` deletes every Cache Storage entry whose name is not its own
    (`opensesame-pages-v3`) — origin-wide, not application-scoped.
  - `main.tsx` statically imports `App`, which statically imports ambient
    auth boot, connector-directory sealing, Vercel Connect hydration,
    federation, the broker screen, the support provider and WebMCP. The
    entry chunk therefore carries every optional system.
  - `main.tsx` calls `registerSW({ immediate: true })` unconditionally.

## 2. Identifier universes (never merged)

| Universe | Shape | Owner |
|---|---|---|
| capability ID | `family.name[-name]` e.g. `connectors.external` | `packages/app-core/src/lib/capabilities/catalog.ts` |
| operation ID | existing `@opensesame/capability-registry` ids, unchanged | `packages/capability-registry` |
| module ID | `<capability-id>/<unit>` e.g. `connectors.external/section` | `packages/app-core/src/lib/capabilities/ownership.ts` |
| asset ID | dist-relative path e.g. `assets/ConnectionsSection-x.js` | build plugin output `dist/capability-graph.json` |

Types for all four live in `packages/capability-composition/src/types.ts`
and are the only definitions.

## 3. Package and directory ownership

| Owner | Paths | Publishes |
|---|---|---|
| **S01** pure semantics | `packages/capability-composition/**` | `resolveComposition`, `explainCapability`, `reviewCompositionChange`, document parsers/validators, `exposureDigest`, `planDigest`, `receiptDigest`, `canonicalize`, reason codes, fixtures |
| **S02** inventory | `packages/app-core/src/lib/capabilities/catalog.ts`, `ownership.ts`, `presets.ts`, `apps/pages/capability-profiles/*.json`, `packages/capability-registry/src/capability-map.ts` | descriptors, module ownership map, presets, profile fixtures, operation→capability map |
| **S03** trust | `packages/app-core/src/lib/capabilities/trust/**` | policy envelope verification, provenance, join/import review, revision/rollback checks |
| **S04** configuration resources | `packages/app-core/src/lib/configuration/capabilities-*.ts` | instance-policy / installation-selection / vault-restriction resources, Visual/Source/Effective round trips, export |
| **S05** bootstrap | `apps/pages/src/main.tsx`, `src/bootstrap/**`, `src/lib/runtime-config.ts`, `src/app-root.tsx` (the former `App.tsx` body) | core-only boot, parsed runtime config, core routes, unavailable/denied route |
| **S06** loader/runtime | `packages/app-core/src/lib/capabilities/{store,loader,registry,authority,lease}.ts` | store, `loadApprovedModule`, `activateApprovedCapability`, registrars, `assertCurrentOperationAuthority`, `admitOperation` |
| **S07** build | `apps/pages/scripts/capability-compose-plugin.mjs`, `scripts/build-profile.mjs`, `scripts/verify-capability-graph.mjs`, `vite.config.ts` (plugin wiring only), `tools/quality/bundle-budgets.json` (profile budgets) | virtual modules, hardened/selective builds, `dist/capability-graph.json`, `dist/capability-distribution.json`, forbidden-reachability gate |
| **S08** workers | `apps/pages/src/sw.ts`, `src/sw-push.ts`, `src/sw/**`, `src/lib/capabilities/worker-controller.ts`, `scripts/build-workers.mjs` | core-only worker, push variant, owned caches, asset-plan messages, registration controller |
| **S09** setup/consent UI | `apps/pages/src/screens/capabilities/**`, `src/screens/SetupScreen.tsx`, `src/screens/FrontDoor.tsx` (requirements panel patch), `src/sections/settings/CapabilitiesPanel*.tsx` | purpose cards, capability cards, draft/review/apply, Settings › Capabilities |
| **S10** shell | `src/components/AppShell.tsx`, `RailRows.tsx`, `NavDrawer.tsx`, `Crumbs.tsx`, `SettingsTree.tsx`, `KeymapSheet.tsx`, `src/lib/keymap.ts`, `src/lib/command-bar/types.ts`, `src/webmcp/navigation.ts` | contribution-driven navigation, commands, shortcuts, help |
| **S11–S16** module owners | `apps/pages/src/modules/<capability-id>/runtime.ts` (+ moved feature code) | one `capabilityRuntime` per optional capability |
| **S17** OpenFeature | `packages/app-core/src/lib/capabilities/openfeature.ts` | local read-only provider over the store snapshot |
| **S18** network | `packages/app-core/src/lib/capabilities/egress.ts`, `scripts/security-headers.mjs` | egress adapter, capability-derived CSP/header templates |
| **S19** lifecycle | `packages/app-core/src/lib/capabilities/{change,migration,invalidation}.ts` | change coordinator, `setup.v1` migration review, cross-tab invalidation |
| **S20** registry parity | `packages/capability-registry/src/capability-map.ts` + parity tests | operation→capability prerequisites, profile projections |
| **S21–S24** verification, docs | `apps/pages/scripts/verify-capabilities*.mjs`, `docs/**`, `docs/evidence/capability-composition/**` | property/fuzz suites, browser journeys, red-team fixtures, ADR, operator docs, evidence |

Shared-hotspot rule: only the owner rewrites a file; everyone else sends a
narrowly scoped patch (a new export, a hook call, a filtered list). Files
stay under 400 lines (`pnpm quality:gate`). New files start at zero debt.

## 4. Runtime contracts (Pages)

### 4.1 Store (`lib/capabilities/store.ts`, S06)

```ts
type CompositionSnapshot = Readonly<{
  status: "resolving" | "ready" | "managed-invalid" | "storage-unavailable";
  plan: EffectivePlan | null;          // null until resolved; never a permissive default
  generation: number;                  // bumps on every commit/lock/vault switch/revocation
  provenance: PolicyProvenance;
  policy: InstanceCapabilityPolicy | null;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  lifecycle: Readonly<Record<CapabilityId, CapabilityLifecycle>>;
  durability: "durable" | "session-only" | "unknown";
  diagnostics: readonly string[];      // human-readable, never secrets
}>;

export const compositionStore: {
  getSnapshot(): CompositionSnapshot;
  subscribe(listener: () => void): () => void;
  /** Resolve from parsed runtime config + persisted documents + runtime facts. */
  boot(input: { runtimeConfig: ParsedRuntimeConfig; vaultId: string | null; facts: RuntimeFacts }): Promise<void>;
  currentLease(): ActivationLease;     // scoped to current generation; aborted on bump
  /** Draft → review → commit. Commit is revision-checked and durable before publish. */
  review(draft: InstallationCapabilitySelection): CompositionChangeReview;
  commit(draft: InstallationCapabilitySelection, receipt: ConsentReceipt): Promise<CommitOutcome>;
  emergencyDisable(id: CapabilityId): Promise<EmergencyDisableOutcome>;  // blocks in memory first
  onVaultChange(vaultId: string | null): void;  // bumps generation, re-resolves
  invalidate(reason: string): void;             // lock, logout, policy refresh
};
export function useComposition(): CompositionSnapshot;      // useSyncExternalStore
export function useCapability(id: CapabilityId): CapabilityState | null;
```

### 4.2 Loader and registrars (`loader.ts`, `registry.ts`, S06)

```ts
export async function loadApprovedModule(id: ModuleId, lease: ActivationLease): Promise<CapabilityModule>;
export async function activateApprovedCapability(id: CapabilityId, lease: ActivationLease): Promise<RuntimeHandle[]>;
export function registerContribution<K extends ContributionKind>(kind: K, entry: ContributionEntry<K>, lease: ActivationLease): RegistrationHandle;
export function useContributions<K extends ContributionKind>(kind: K): readonly ContributionEntry<K>[];  // generation-fenced, sorted by `order` then id
export function assertCurrentOperationAuthority(op: OperationId, lease: ActivationLease): void;  // throws CapabilityDenied before any handler import
export async function admitOperation(op: OperationId, lease: ActivationLease): Promise<AdmissionDecision>;  // Web Locks + durable generation compare
```

`ContributionEntry<K>` shapes (all serializable except component/handler
fields, which the module supplies already-imported):

- `section`: `{ id, to, label, segment, jump, icon: IconName, order, Tree?: ComponentType<TreeProps> }`
- `route`: `{ id, path, element: ComponentType, framed: boolean, order }`
- `settings-category`: `{ id, label, guideId, Panel: ComponentType, order }`
- `setup-panel`: `{ id, tab, rail, Panel: ComponentType, order }`
- `command-path`: `{ path, label }`
- `keymap-jump`: `{ key, path }`
- `tutorial-target` / `tutorial-goal` / `tutorial-route`: the existing descriptor types
- `item-kind`: `{ kind, label, segment, Icon?: ComponentType, order }`
- `webmcp-tool`: `WebMcpToolSpec` (already fenced by the core; the core filters by `approvedOperations` before registration)
- `background-job`: `{ id, start(signal): void }`
- `unlock-effect`: `{ id, run(ctx: { tomb: string; guest: boolean; signal: AbortSignal }): Promise<void> }`

### 4.3 Module entry contract (S11–S16)

Every optional module is `apps/pages/src/modules/<capability-id>/runtime.ts`
(directory name = capability id verbatim, dots kept), and its default export
is:

```ts
export const capabilityRuntime: CapabilityRuntime = {
  capability: "connectors.external",
  async activate(ctx: ApprovedCapabilityContext): Promise<RuntimeHandle> { ... }
};
type ApprovedCapabilityContext = Readonly<{
  lease: ActivationLease;
  register: <K extends ContributionKind>(kind: K, entry: ContributionEntry<K>) => RegistrationHandle;
  runtimeConfig: ParsedRuntimeConfig;      // parsed data; the module applies its own endpoints
  hydrate: (keys: readonly string[]) => Promise<void>;  // kvHydrate for the module's own keys
  vault: { tomb: string | null; guest: boolean };
  egress: EgressPort;                      // destination-validated fetch (S18)
}>;
```

Rules: no top-level side effects in a module or anything it imports (no
provider init, timers, network, DOM registration, storage migration,
permission requests); everything happens in `activate` and is undone by the
returned `dispose`. A module receives only the ports above — never the vault
store's root material, never an unbounded fetch.

Module ids: `<capability-id>/runtime` is the entry; a capability with a
service-worker part also lists `<capability-id>/worker` (satisfied by a worker
variant, never loaded by the page).

### 4.4 Parsed runtime config (`lib/runtime-config.ts`, S05)

```ts
type ParsedRuntimeConfig = Readonly<{
  status: "absent" | "ok" | "invalid";
  endpoints: RuntimeEndpointConfig & { connectCallbackBase?: string };  // applied by core Settings only
  ambientAuth: BoundaryValue | undefined;     // applied by identity.ambient-sso's runtime, not here
  capabilityComposition: Readonly<{ instancePolicy: InstanceCapabilityPolicy | null; provenance: "same-origin-deployment"; diagnostics: string[] }> | null;
  diagnostics: readonly string[];
}>;
export async function loadRuntimeConfig(): Promise<ParsedRuntimeConfig>;   // fetch + parse + validate; applies core endpoints only
export function runtimeConfigSnapshot(): ParsedRuntimeConfig;             // for modules
```

`os-runtime-config.json` gains:

```json
{ "capabilityComposition": { "schemaVersion": 1, "instancePolicy": { …InstanceCapabilityPolicy… } } }
```

An invalid `capabilityComposition` section is `status: "invalid"` →
`compositionStore` enters `managed-invalid` (core-only plan, recovery
explanation, no optional loads). An absent section is a personal-local
installation.

### 4.5 Persistence keys (plaintext boundary, bounded, non-secret)

| Key | Content | Owner |
|---|---|---|
| `capabilities.selection.v1` | `InstallationCapabilitySelection` | S06 store |
| `capabilities.receipt.v1` | `ConsentReceipt` | S06 store |
| `capabilities.policy.local.v1` | personal-local `InstanceCapabilityPolicy` authored on device | S04 |
| `capabilities.policy.accepted.v1` | `{ instanceId, revision, digest, provenance, acceptedAt }` highest accepted managed policy | S03 |
| `capabilities.generation.v1` | `{ generation, committedAt }` durable admission counter | S06 |
| `tomb/<id>/capabilities.v1` | `VaultCapabilitySelection` (per-vault disables) | S19 |

Installation id: `installation.v1` → random opaque id minted once per browser
installation, hydrated by the core boot.

### 4.6 Build (S07)

- `OPENSESAME_CAPABILITY_PROFILE=<path>` selects a profile JSON
  (`{ instancePolicy, installationSelection }`); absent → `rich-explicit`'s
  distribution (every module present) in `selective` mode.
- `OPENSESAME_BUILD_MODE=selective|hardened` (default `selective`).
- Virtual modules: `virtual:opensesame-capability-modules` exporting
  `MODULE_TABLE: Record<ModuleId, () => Promise<CapabilityModule>>` (only
  distributed modules; compile-time-known import specifiers), and
  `virtual:opensesame-distribution` exporting a `DistributionContract`.
- Emitted: `dist/capability-distribution.json`, `dist/capability-graph.json`
  (source module → chunk, static/dynamic import edges, CSS/asset edges, entry
  HTMLs, workers, public files, ownership classification with rationale).
- Hardened: excluded module entries absent from the table; excluded HTML
  entries (`auth/redirect.html` → `identity.ambient-sso`), public files and
  worker variants not emitted; build fails on forbidden reachability from
  any entry.

### 4.7 Workers (S08)

- `src/sw.ts` → `sw.js`: core-only. Shell + approved asset-plan caching, no
  push, no protocol handlers. Cache name `opensesame-pages:<scopePath>:<releaseId>:core`.
- `src/sw-push.ts` → `sw-push.js`: core + Web Push handlers; only emitted when
  `notifications.web-push` is distributed; only registered when it is in the
  plan and the installation accepted it.
- Page → worker messages: `{ type: "PLAN_ASSETS", releaseId, moduleIds }` —
  the worker maps module ids to assets via same-origin
  `capability-graph.json`; never accepts URLs. Any other type is ignored.
- Cleanup deletes only `opensesame-pages:<same scopePath>:*` names that are
  neither current nor retained for active clients.

## 5. Core versus optional (as landed: 7 core, 24 optional)

Core (`tier: "core"`, always present), 7: `shell.navigation` (the rail,
routes, crumbs, command bar, keymap and statusline every other capability
contributes into), `vault.passwords` (items, editor, login/note/card/secret
kinds, health), `vault.local-unlock` (password, PIN, passkey-PRF protectors
and the second-step ceremony), `backup.local-encrypted` (encrypted file
export/import/recovery), `identity.brokered-signin` (compiled-in broker +
guest + local-only seal — the ADR 0090 front door), `settings.core` (General,
Security, Vaults, Danger, Capabilities), `install.pwa` (install offer +
core-only worker).

Optional (default off), 24: `access.authority`, `identity.federation`,
`identity.ambient-sso`, `identity.local-iam`, `identity.siop`,
`identity.site-broker`, `enterprise.directory-provisioning`,
`enterprise.ca-administration`, `connectors.external`, `agents.webmcp`,
`support.guided-help`, `support.local-ai`, `support.remote-ai`,
`wallet.spending`, `activity.log`, `notifications.web-push`,
`telemetry.external`, `vault.passkey-records`, `vault.certificate-records`,
`vault.interop-formats`, `sharing.drops`, `sharing.household` (alternatives
slot `transport` → `sharing.drops`), `backup.git-remote`,
`backup.cloud-secrets`.

The two counts are the ones `catalog-core.ts` and the three
`catalog-optional-*.ts` files actually declare; `catalog.test.ts` asserts the
catalog and `OPERATION_CAPABILITY` agree, so a later catalog change that
leaves this paragraph behind is visible to a reader rather than silent.

The prompt's example IDs (`vault.passwords`, `backup.local-encrypted`,
`vault.passkey-records`, `sharing.household`, `connectors.external`,
`enterprise.ca-administration`, `enterprise.directory-provisioning`,
`agents.webmcp`, `support.remote-ai`, `telemetry.external`) must all exist so
the example documents validate.

## 6. Test fixtures for legacy suites

Legacy Playwright verifiers walk every section. They keep their coverage by
running under the explicit `rich-explicit` profile: the static-origin harness
serves that profile's `os-runtime-config.json` when
`PAGES_CAPABILITY_FIXTURE=rich-explicit` and the journey accepts the
installation's declared capabilities on the front door (`acceptInstallation`
helper). Minimal-profile journeys run with no fixture and assert absence.

## 7. `@opensesame/capability-composition` exports (S01; consumers rely on these exact names)

```ts
export type Diagnostic = Readonly<{ code: string; message: string; path: string }>;
export type ValidationResult = Readonly<{ ok: true } | { ok: false; diagnostics: readonly Diagnostic[] }>;
export type ParseResult<T> = Readonly<{ ok: true; value: T } | { ok: false; diagnostics: readonly Diagnostic[] }>;

export function isCapabilityId(v: string): boolean;            // ^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*)+$ , ≤ 64
export function isModuleId(v: string): boolean;                // <capability-id>/<unit>, unit ^[a-z][a-z0-9-]*$
export function canonicalize(v: BoundaryValue): string;        // recursively key-sorted JSON
export function sha256Hex(v: string | Uint8Array): string;     // @noble/hashes
export function exposureDigest(d: Omit<CapabilityDescriptor, "exposureDigest">): string;  // "sha256:<hex>"
export function buildCatalog(descriptors: readonly Omit<CapabilityDescriptor, "exposureDigest">[], catalogVersion: number): CapabilityCatalog;
export function validateCatalog(c: CapabilityCatalog): ValidationResult;
export function parseInstancePolicy(v: BoundaryValue): ParseResult<InstanceCapabilityPolicy>;
export function parseWorkspaceRestriction(v: BoundaryValue): ParseResult<WorkspaceCapabilityRestriction>;
export function parseInstallationSelection(v: BoundaryValue): ParseResult<InstallationCapabilitySelection>;
export function parseVaultSelection(v: BoundaryValue): ParseResult<VaultCapabilitySelection>;
export function parseConsentReceipt(v: BoundaryValue): ParseResult<ConsentReceipt>;
export function parseDistributionContract(v: BoundaryValue): ParseResult<DistributionContract>;

export type ResolveInput = Readonly<{
  catalog: CapabilityCatalog;
  distribution: DistributionContract;
  instancePolicy: InstanceCapabilityPolicy | null;   // null = personal-local: ceiling is every distributed optional capability
  provenance: PolicyProvenance;
  policyValid: boolean;                               // false → managed-invalid: core-only plan, POLICY_UNVERIFIED on every optional
  workspace: WorkspaceCapabilityRestriction | null;
  installation: InstallationCapabilitySelection | null;
  vault: VaultCapabilitySelection | null;
  receipt: ConsentReceipt | null;
  facts: RuntimeFacts;
  installationId: string;
  vaultId: string | null;
}>;
export function resolveComposition(input: ResolveInput): EffectivePlan;
export function explainCapability(plan: EffectivePlan, id: CapabilityId): CapabilityExplanation;
export function reviewCompositionChange(before: EffectivePlan, after: EffectivePlan, catalog: CapabilityCatalog): CompositionChangeReview;
export function buildConsentReceipt(plan: EffectivePlan, catalog: CapabilityCatalog, acceptedAt: string): ConsentReceipt;
export function computeConsentDelta(plan: EffectivePlan, catalog: CapabilityCatalog, receipt: ConsentReceipt | null): ConsentDelta;
export const REASON_CODES: readonly ReasonCode[];
// Deterministic test fixtures shared by every package's tests:
export const FIXTURE_CATALOG: CapabilityCatalog;
export const FIXTURE_DISTRIBUTION: DistributionContract;   // selective, everything distributed
export const FIXTURE_POLICIES: { personalLocal: null; family: InstanceCapabilityPolicy; managedProhibited: InstanceCapabilityPolicy };
export const FIXTURE_FACTS: RuntimeFacts;
```

Resolution semantics (binding): core-tier capabilities are always approved
(`reasons: ["CORE"]`) and never appear in policy sets. `permitted` for an
optional capability = distributed ∧ (instancePolicy null ∨ id ∈ required ∪
optional) ∧ id ∉ prohibited ∧ (workspace.allow null ∨ id ∈ allow) ∧ id ∉
workspace.prohibited. `selected` = id ∈ acceptedRequired ∪ selectedOptional.
A required root not in `acceptedRequired` → `REQUIRED_NOT_ACCEPTED`, and the
plan's `consent.requiredNotAccepted` is non-empty (joining refused; nothing
optional approved). Closure = selected roots + hard dependencies + chosen
alternatives, each of which must itself be permitted, distributed and
runtime-supported, else the *root* conflicts and neither root nor dependency
is approved. A capability with `egress` containing an automatic
`external-service` declaration is `NETWORK_POLICY_DENIES` when
`network.externalServices === "deny"`. `approved` additionally requires
consent coverage: id ∈ receipt.exposure with an equal digest (else
`CONSENT_REQUIRED`); the plan still lists it in `consent.addedRoots` /
`changedExposure`. `restartRequired` = ¬approved ∧ (a module of the
capability ∈ facts.evaluatedModuleIds). `requiredWorkerVariant` = the single
variant satisfying every approved capability's worker constraint, or
`WORKER_GRAPH_UNAVAILABLE` conflicts on those capabilities.
