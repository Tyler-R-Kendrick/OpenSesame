# Capability composition — ownership and interface contract

> Status (2026-10-08): landed. [ADR 0130](../../adr/0130-operator-controlled-capability-composition.md)
> is Accepted and the contracts below are implemented; 12 of the 103 contracts in
> `docs/evidence/capability-composition/contract-test-matrix.json` are recorded
> `pending` (no landed test names them). Section 1 is the
> 2026-09-22 baseline and stays as history. Sections 2 to 7 were checked against
> this tree on 2026-10-08: paths are repository-relative (much of what was
> written as `apps/pages/src/lib/...` now lives in `packages/app-core/src/lib/`,
> ADR 0133), and the core and optional counts in section 5 are today's.

This is the coordination record for operator-controlled capability
composition ([ADR 0130](../../adr/0130-operator-controlled-capability-composition.md),
and the evidence under `docs/evidence/capability-composition/`). Every runtime, editor, build step
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
| module ID | `<capability-id>/<unit>` e.g. `connectors.external/section` | `apps/pages/src/lib/capabilities/ownership.ts` |
| asset ID | dist-relative path e.g. `assets/ConnectionsSection-x.js` | build plugin output `dist/capability-graph.json` |

Types for all four live in `packages/capability-composition/src/types.ts`
and are the only definitions.

## 3. Package and directory ownership

| Owner | Paths | Publishes |
|---|---|---|
| **S01** pure semantics | `packages/capability-composition/**` | `resolveComposition`, `explainCapability`, `reviewCompositionChange`, document parsers/validators, `exposureDigest`, `planDigest`, `receiptDigest`, `canonicalize`, reason codes, fixtures |
| **S02** inventory | `packages/app-core/src/lib/capabilities/catalog.ts` (with the `catalog-*.ts` files it assembles) and `presets.ts`, `apps/pages/src/lib/capabilities/ownership.ts`, `apps/pages/capability-profiles/*.json`, `packages/capability-registry/src/capability-map.ts` | descriptors, module ownership map, presets, profile fixtures, operation→capability map |
| **S03** trust | `packages/app-core/src/lib/capabilities/trust/**` | policy envelope verification, provenance, join/import review, revision/rollback checks |
| **S04** configuration resources | `packages/app-core/src/lib/configuration/capabilities-*.ts` | instance-policy / installation-selection / vault-restriction resources, file round trips, export |
| **S05** bootstrap | `apps/pages/src/main.tsx`, `apps/pages/src/bootstrap/**`, `packages/app-core/src/lib/runtime-config.ts`, `apps/pages/src/app-root.tsx` (the former `App.tsx` body) | core-only boot, parsed runtime config, core routes, unavailable/denied route |
| **S06** loader/runtime | `packages/app-core/src/lib/capabilities/{store,loader,registry,authority,lease}.ts` | store, `loadApprovedModule`, `activateApprovedCapability`, registrars, `assertCurrentOperationAuthority`, `admitOperation` |
| **S07** build | `apps/pages/scripts/capability-compose-plugin.mjs`, `apps/pages/scripts/build-profile.mjs`, `apps/pages/scripts/verify-capability-graph.mjs`, `apps/pages/vite.config.ts` (plugin wiring only), `tools/quality/bundle-budgets.json` (profile budgets) | virtual modules, hardened/selective builds, `dist/capability-graph.json`, `dist/capability-distribution.json`, forbidden-reachability gate |
| **S08** workers | `apps/pages/src/sw.ts`, `apps/pages/src/sw-push.ts`, `apps/pages/src/sw/**`, `packages/app-core/src/lib/capabilities/worker-controller.ts`, `apps/pages/scripts/build-workers.mjs` | core-only worker, push variant, owned caches, asset-plan messages, registration controller |
| **S09** setup/consent UI | `apps/pages/src/screens/capabilities/**`, `apps/pages/src/screens/SetupScreen.tsx`, `apps/pages/src/screens/FrontDoor.tsx` (requirements panel patch), `apps/pages/src/sections/settings/CapabilitiesPanel*.tsx` | purpose cards, capability cards, draft/review/apply, Settings › Capabilities |
| **S10** shell | `apps/pages/src/components/{AppShell,RailRows,NavDrawer,Crumbs,SettingsTree,KeymapSheet}.tsx`, `apps/pages/src/lib/keymap.ts`, `packages/app-core/src/lib/command-bar/types.ts`, `packages/app-core/src/webmcp/navigation.ts` | contribution-driven navigation, commands, shortcuts, help |
| **S11–S16** module owners | `apps/pages/src/modules/<capability-id>/runtime.ts` (+ moved feature code; 37 modules today) | one `capabilityRuntime` per optional capability |
| **S17** OpenFeature | `packages/app-core/src/lib/capabilities/openfeature.ts` | local read-only provider over the store snapshot |
| **S18** network | `packages/app-core/src/lib/capabilities/egress.ts`, `apps/pages/scripts/security-headers.mjs` | egress adapter, capability-derived CSP/header templates |
| **S19** lifecycle | `packages/app-core/src/lib/capabilities/{change,migration,invalidation}.ts` | change coordinator, `setup.v1` migration review, cross-tab invalidation |
| **S20** registry parity | `packages/capability-registry/src/capability-map.ts` + parity tests | operation→capability prerequisites, profile projections |
| **S21–S24** verification, docs | `apps/pages/scripts/verify-capability-graph.mjs`, `docs/**`, `docs/evidence/capability-composition/**` | property/fuzz suites, browser journeys, red-team fixtures, ADR, operator docs, evidence |

Shared-hotspot rule: only the owner rewrites a file; everyone else sends a
narrowly scoped patch (a new export, a hook call, a filtered list). Files
stay under 400 lines (`pnpm quality:gate`). New files start at zero debt.

## 4. Runtime contracts (Pages)

### 4.1 Store (`packages/app-core/src/lib/capabilities/store.ts`, S06)

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

The two hooks are React bindings in `apps/pages/src/bindings/capabilities.ts`; the
store itself (`compositionStore`, which also has `preview(draft)`) is framework-free.

### 4.2 Loader and registrars (`packages/app-core/src/lib/capabilities/{loader,registry,authority}.ts`, S06)

```ts
export async function loadApprovedModule(id: ModuleId, lease: ActivationLease): Promise<CapabilityModule>;
export async function activateApprovedCapability(id: CapabilityId, lease: ActivationLease): Promise<RuntimeHandle[]>;
export function registerContribution<K extends ContributionKind>(kind: K, entry: ContributionEntry<K>, lease: ActivationLease): RegistrationHandle;
export function useContributions<K extends ContributionKind>(kind: K): readonly ContributionEntry<K>[];  // generation-fenced, sorted by `order` then id (the hook is in apps/pages/src/bindings/contributions.ts; registry.ts exports the same read as `contributions(kind)`)
export function assertCurrentOperationAuthority(op: OperationId, lease: ActivationLease): void;  // throws CapabilityDenied before any handler import
export function assertCurrentCapabilityAuthority(id: CapabilityId, lease: ActivationLease): void;  // the same, for a destination (no operation)
export async function admitOperation<T>(op: OperationId, lease: ActivationLease, operation: () => T | Promise<T>): Promise<AdmissionOutcome<T>>;  // Web Locks + durable generation compare; the lock is held through the operation
```

**Dispatch gates** (`packages/app-core/src/lib/capabilities/dispatch.ts`). Listing an entry is not
authority to use it: each surface re-resolves the entry's live registration
(current generation, the registering lease) at the moment it acts, and throws
`CapabilityDenied` before the handler runs.

| Surface | Where | Check |
|---|---|---|
| WebMCP tool call | `apps/pages/src/modules/agents.webmcp/registrar.ts` execute wrapper → `authority.ts` `authorizeToolCall` | `assertCurrentOperationAuthority(owner op, registering lease)`; a tool not declared `readOnly` is **sensitive** and is then admitted with `admitOperation` (refused on a newer durable generation, a stale lease, an unapproved op, or no Web Locks) |
| Command path | `packages/app-core/src/lib/command-bar/execute.ts` section command; `packages/app-core/src/webmcp/navigation.ts` (`commandPathAuthorized`) | `assertCurrentCapabilityAuthority(registering capability, lease)` — a destination names no operation (`activity.log` owns none and still owns `/activity`) |
| Keymap jump | `apps/pages/src/lib/keymap-jumps.ts` `sectionJumpPath` | the same; a refused jump is swallowed like an unbound letter |

No live registration is `NOT_REGISTERED`. Core destinations (`/vault`,
`/settings`) are core tier and not gated. An entry on the jsdom test channel
(`registerContributionForTest`, `packages/app-core/src/lib/contributions.ts`) stands in for a lease; `dispatch.test.ts`
fails if any non-test source writes that channel.

`ContributionEntry<K>` shapes (all serializable except component/handler
fields, which the module supplies already-imported):

- `section`: `{ id, to, label, segment, jump, icon: IconName, order, Tree?: ComponentType<TreeProps> }`
- `route`: `{ id, path, element: ComponentType, framed: boolean, order, gate?: "unlocked" | "any" }`
- `settings-category`: `{ id, label, guideId, Panel: ComponentType, order, panels?, files? }`
- `settings-panel`: `{ id, label, category, Panel: ComponentType, order, files? }` — a block a capability draws inside a category the core already has
- `shell-wrapper`: `{ id, Wrapper: ComponentType<{ children? }>, Gate?: ComponentType, order }` — a provider the shell body is wrapped in (guided help, the agent-tool registrar), and its part of the gate screens
- `setup-panel`: `{ id, tab, rail, Panel: ComponentType, order }`
- `command-path`: `{ path, label }`
- `keymap-jump`: `{ key, path }`
- `tutorial-target` / `tutorial-goal` / `tutorial-route`: the existing descriptor types
- `item-kind`: `{ kind, label, segment, Icon?: ComponentType, order, creatable?: boolean, Record?: ComponentType<{ item }>, Create?: ComponentType<ItemCreateProps> }` — the record view and creation form of a contributed kind (a drop's, `sharing.drops`)
- `webmcp-tool`: `WebMcpToolSpec` tagged with `operationIds` (`tagWebMcpTool`; already fenced by the core). A tool is registered by the capability that owns its operations, so it exists exactly while that capability is active; the `agents.webmcp` surface registers the contributed set with the browser, keeping a tool only while the plan approves the operation it is owned by (its first id), and never an untagged one
- `background-job`: `{ id, start(signal): void }`
- `unlock-effect`: `{ id, run(ctx: { tomb: string; guest: boolean; signal: AbortSignal }): Promise<void> }`
- `secret-share`: `{ id, order, Panel: ComponentType<{ item: VaultItem; open: boolean; onClose: () => void }> }` — an offer to share a stored secret (a drop)
- `item-draft-assist`: `{ id, order, Suggestions: ComponentType<{ typeId, website?, onApply }>, suggest(context, signal): Promise<DraftLabels> }` — labels for a new item from a model, beside the editor and for the WebMCP draft tools
- `command-assist`: `{ id, order, interpret(utterance, { itemNames }): Promise<InterpretResult>, Voice?: ComponentType }` — what the command bar asks when its own parser finds no command, and its voice input
- `vault-command`: `{ id, order, Command: ComponentType, Entry?: ComponentType }` — an icon key in the vault path strip's command group, after New item (Import, `vault.interop-formats`), and `Entry` the same flow as a way to add on a phone

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
  navigate: (to: string) => void;          // the shell's router; throws `router_unavailable` until it is mounted
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

### 4.4 Parsed runtime config (`packages/app-core/src/lib/runtime-config.ts`, S05)

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

### 4.5 Persistence keys (beside the vault, not under its key; bounded, non-secret; written through `kv`, so sealed under the device's at-rest key, ADR 0149)

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
  push, no protocol handlers. Cache name `opensesame-pages:<scopePath>:<releaseId>:core-only`.
- `src/sw-push.ts` → `sw-push.js`: core + Web Push handlers; only emitted when
  `notifications.web-push` is distributed; only registered when it is in the
  plan and the installation accepted it.
- Page → worker messages: `{ type: "WORKER_HELLO" }` and `{ type: "PLAN_ASSETS",
  releaseId, planDigest, moduleIds }` — the worker maps module ids to assets via
  same-origin `capability-graph.json`; never accepts URLs. Any other type is
  ignored (`apps/pages/src/sw/messages.ts`).
- Cleanup deletes only `opensesame-pages:<same scopePath>:*` names that are
  neither current nor retained for active clients.

## 5. Core versus optional (as landed: 15 core-tier, 29 optional)

The counts are the ones `catalog-core.ts`, `catalog-always-on.ts`,
`catalog-always-on-local.ts` and the four `catalog-optional-*.ts` files actually
declare (44 descriptors); `apps/pages/src/lib/capabilities/catalog.test.ts`
asserts the catalog and `OPERATION_CAPABILITY` agree, so a later catalog change
that leaves this paragraph behind is visible to a reader rather than silent.

Core (`core(...)`, `tier: "core"`, statically linked, always present), 7:
`shell.navigation` (the rail, routes, crumbs, command bar, keymap and statusline
every other capability contributes into), `vault.passwords` (the base secret and
the file: item list, editor, TOTP codes, website matching and the health report;
other item types are optional), `vault.local-unlock` (password, PIN and passkey
protectors, the enrolled second step, recovery codes, the device's vault list,
travel mode, the duress code, resetting this browser), `backup.local-encrypted`
(one encrypted file: export, import, recover on a new device),
`identity.brokered-signin` (the ADR 0090 front door: compiled-in broker road,
guest, local-only seal, sign out), `settings.core` (General, Security, Vaults,
Danger, Capabilities, the setup record and the runtime endpoint file),
`install.pwa` (install offer, persistent storage, update checks and the
core-only worker).

Always on (`alwaysOn(...)`, also `tier: "core"`: in every plan, no switch, but
the code is a module loaded after boot, ADR 0135 and ADR 0142; a verified
instance policy may still withdraw one), 8: `identity.site-broker`,
`backup.git-remote`, `sharing.drops`, `vault.interop-formats`,
`backup.cloud-secrets`, `identity.ceremonies`, `activity.log`,
`support.guided-help`.

Optional (`optional(...)`, default off), 30: `identity.local-iam`,
`identity.siop`, `vault.passkey-records`, `vault.certificate-records`,
`connectors.external`, `access.authority`, `identity.federation`,
`identity.ambient-sso`, `enterprise.directory-provisioning`,
`enterprise.ca-administration`, `agents.surrogate-credentials`,
`vault.browser-autofill`, `agents.webmcp`, `support.local-ai`,
`ai.password-reset`, `support.remote-ai`, `wallet.spending`,
`notifications.local`, `notifications.web-push`, `notifications.routing`,
`telemetry.external`, `networking.tailnet`, `networking.tailnet-devices`,
`vault.derived-records`, `sharing.live`, `vault.environments`,
`storage.encrypted-search`, `vault.security-checks`, `sharing.household`
(alternatives slot `transport` → `sharing.drops`), `sharing.trusted-contacts`
(the Settings › Trusted contacts category: Circles, Guarding and Recovery
panels over the quorum desk, with its walkthrough; ADR 0187).

Every always-on and optional capability has a module,
`apps/pages/src/modules/<capability-id>/runtime.ts` (38 today).

The prompt's example IDs (`vault.passwords`, `backup.local-encrypted`,
`vault.passkey-records`, `sharing.household`, `connectors.external`,
`enterprise.ca-administration`, `enterprise.directory-provisioning`,
`agents.webmcp`, `support.remote-ai`, `telemetry.external`) must all exist so
the example documents validate.

## 6. Test fixtures for legacy suites

Legacy Playwright verifiers walk every section. A device that has approved
nothing has no rail row for an optional capability's section (ADR 0130), so a
journey that needs one switches it on the way a person does:
`addCapabilities(page, titles)` in `apps/pages/scripts/lib/pages-journey.mjs`
opens Settings › Capabilities, presses each capability's switch and waits for the
review to commit; an always-on capability is skipped, since it has no switch.
`rich-explicit` remains a profile (`apps/pages/capability-profiles/rich-explicit.json`)
built by `build:profile`, and the build's default when no profile is named.

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

Resolution semantics (binding): core-tier capabilities are approved
(`reasons: ["CORE"]`) and never appear in policy sets, except that a verified
instance policy may withdraw an always-on one (a core-tier capability that owns a
module) by listing it in `prohibited`, and with it every always-on capability that
depends on it (`resolve-withdraw.ts`, ADR 0142). `permitted` for an
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
