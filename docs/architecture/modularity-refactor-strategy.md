# Modularity and generative-template refactor strategy

Status: Evaluation (no decision recorded yet)
Date: 2026-09-03
Scope: repository-wide, 512,226 lines (177,715 TS source, 155,024 TS test,
179,487 Rust)
Relates to: ADR 0065 ([agent-surface parity](../adr/0065-agent-surface-parity.md)),
ADR 0084 ([external authorization notifications](../adr/0084-external-authorization-notifications.md)),
ADR 0087 ([vault item types are plugins](../adr/0087-vault-item-type-plugins.md)),
ADR 0088 ([AI-native contextual support](../adr/0088-ai-native-contextual-support.md))

## 1. The finding that reframes the rest

The working hypothesis behind this review was that the codebase is complex
because it lacks the patterns that would make it swappable — that it needs
adapters, strategies and visitors introduced.

That hypothesis is wrong, and it is worth saying so plainly before proposing
anything, because it changes what the work is.

This repository already knows those patterns and applies several of them at a
high standard. `packages/notification-adapters` is a textbook adapter set
behind a registry: seven channel adapters, a closed `ChannelAdapter` contract
in `contract.ts:310`, and an 87-line registry that resolves them by kind. No
provider logic leaks anywhere else. `packages/ceremony-kit`,
`packages/guide-lang` and `crates/lifecycle` are each built as a pure core with
I/O pushed to the edges. `packages/vault-item-types` turns 23 item types into
1,435 lines of JSON manifests over a shared engine, with a generated embedding
step (`packages/vault-item-types/scripts/emit-definitions.mjs` →
`src/definitions.generated.ts`), guarded by a drift test that fails if the
emitted output no longer matches its sources. (That generator's own docstring
points the reader at a `definitions.generated.test.ts` that does not exist;
the real guard is in `registry.test.ts:93`. A harmless instance of the same
drift the guard was written to catch.)

The complexity is not coming from missing patterns. It is coming from a
specific, repeating failure mode:

> **A new seam gets built, the data or contract behind it gets authored, and
> then the old hand-written path is never retired. Both survive. The
> abstraction is added; the complexity is not removed.**

Every major hotspot in this repository is an instance of that one shape. The
strategy that follows is therefore sequenced around *finishing* migrations
already begun, not around introducing new abstraction. That ordering matters:
introducing more patterns on top of unfinished ones is what produced the
current state.

### The proof case: ADR 0087 is half-migrated

ADR 0087 was accepted with an unusually clear thesis — "a vault item type is a
manifest, never a code path" — and diagnosed the exact problem it meant to
solve: a discriminated union, label tables beside it, and a `switch (item.kind)`
in `ItemEditor.tsx` (then 884 lines) and `ItemDetail.tsx` (then 1,047 lines),
so that "adding a bank account means editing five files in one app and shipping
a build."

And its Decision §1 did not hedge:

> This is not a format for *community* types with the seven builtins carved
> out beside it. **The seven builtins are manifests in this format**, in
> `packages/vault-item-types/definitions/`, loaded through the same registry
> as an installed one. [...] If the generic path is not good enough to render
> `card` or `note`, it is not good enough to offer anyone, and we will find
> that out first.

The engine was built. The manifests were authored. And then:

| ADR 0087 target | At acceptance | Today |
|---|---:|---:|
| `ItemEditor.tsx` | 884 | **921** |
| `ItemDetail.tsx` | 1,047 | **1,056** |

Both files *grew*. `ItemDetail.tsx:476` still opens a `switch (item.kind)` with
seven hand-written per-kind JSX arms — `login`, `passkey`, `card`, `secret`,
`drop`, `note`, `certificate` — and an eighth arm, `case "typed"`, which
delegates to the manifest renderer `TypedFields.tsx` (520 lines).

That eighth arm is the whole problem in one line of code, and it is the exact
shape Decision §1 rejected: in `model.ts:204` the union reads
`LoginItem | PasskeyItem | CardItem | SecretItem | NoteItem | CertificateItem |
DropItem | TypedItem` — `TypedItem` as a *peer* of the seven, which is
"the seven builtins carved out beside it" in as many words. Four more consumers
still switch by hand:
`lib/vault/model.ts:467`, `lib/vault/export/cxf.ts:380`,
`lib/vault/import/merge.ts:143`, and `webmcp/tools.ts:214`.

The decisive detail is that **all seven legacy kinds already have manifest
definitions on disk** — `login.json`, `passkey.json`, `card.json`,
`secret.json`, `note.json`, `drop.json`, `certificate.json` are all present in
`packages/vault-item-types/definitions/`. The data exists. The engine exists.
The consumers were simply never moved.

This is the cheapest large win available and it should be done first, because
it is also the template for everything below.

## 2. Ranked opportunities

Ranked by leverage — lines retired and future edits avoided, divided by risk.
"Hand-maintained" means code a human must edit when the underlying contract
changes, and which nothing mechanically verifies against that contract.

| # | Area | Hand-maintained | Pattern | Risk |
|---|---|---:|---|---|
| 1a | Vault item **rendering** via manifests | ~1,900 | Template/manifest | Medium |
| 1b | Vault item **storage** convergence | — | Data migration | High |
| 2 | Repository layer double-implementation | 4,708* | Conformance suite + engine | Medium |
| 3 | MCP/WebMCP tool surfaces | 2,114 | Generative registry | Low |
| 4 | Identity-plane OpenAPI document | 2,738 | Derived artifact | Low |
| 5 | WIT contracts as documentation | 324 (+ drift) | Codegen (bindgen) | Medium |
| 6 | GuideLang instruction dispatch | ~50 arms × 4 files | Visitor/fold | Low |
| 7 | Connector provider dispatch | 1,832 | Strategy via manifest | Medium |
| 8 | `crates/storage` god-struct | 10,601 | Bounded-context split | High |
| 9 | Turbo cache correctness | — | Reproducibility | Low |
| 10 | Field-type catalogue duplicated per plane | 375 | Shared corpus | Low |

\* Mechanical portion only — see §2.2; `memory.ts` is not pure CRUD.

### 2.1 Finish ADR 0087 — retire the seven hardcoded kinds

**Now:** five consumer files switch on `item.kind` for seven kinds whose
manifests already exist. `ItemDetail.tsx` (1,056) and `ItemEditor.tsx` (921)
carry per-kind JSX that `TypedFields.tsx` already knows how to render from a
definition.

**The trap, and why this item is not the cheap one it looks like.** The seven
are not merely rendered differently — they are *stored* differently.
`LoginItem` is a flat, statically-typed record (`username`, `password`, `totp`,
`uris: LoginUri[]`, `passwordChangedAt`, `reenrollState`), while `TypedItem` is
`{ typeId, values: FieldValues }` — a dynamic bag. Converging them is a
storage-model change, and because items live in E2EE vaults the host cannot
perform it: the rewrite has to happen client-side, per device, on unlock. Some
of those fields also carry behaviour rather than presentation —
`passwordChangedAt` drives the health report, `reenrollState` drives passkey
re-enrolment — so the union is buying static typing on domain state, not just
form layout.

**Move, in two stages that should not be conflated:**

*1a — unify rendering.* Project each legacy item through its existing manifest
and render every kind via `TypedFields.tsx`, leaving storage untouched. This
retires the duplicated per-kind JSX in `ItemDetail.tsx` and `ItemEditor.tsx`
without migrating a single stored vault.

**Corrected after implementation was attempted.** 1a was rated low-risk and
mechanical on the strength of "the manifests already exist". Two thirds of the
groundwork does exist and is better than expected: `definitionFor(item)`
resolves *any* item through `itemTypeId`, and `readItemField` already reads both
shapes because "the definitions name their fields to match" — so the projection
this item seemed to need is already written. What is missing is the dispatch:

- **ADR 0087 §6's handler registry was never built.** §6 is explicit that the
  four builtins doing something no data description can — certificate issuance,
  a drop's claim session, passkey custody, a secret's grant ceilings — keep
  their ceremonies "as a `handler` named in the definition and resolved against
  a platform registry of exactly those names, **not as a `switch (item.kind)`**".
  Five definitions (`certificate`, `drop`, `login`, `passkey`, `secret`) already
  declare `handler` in their spec, and the guard rails around it are built in
  both planes: `HANDLER_IDS` is the closed list of legal names, `validate.ts:682`
  refuses an unknown one, and only a platform publisher may name a handler at
  all (`validate.rs:498` mirrors it). What does not exist is the *resolution*
  step — no `handlerFor`, no registry, nothing in `apps/pages` that reads
  `spec.handler` and returns a ceremony. So the field is validated but never
  dispatched, and the switch §6 forbids is what still decides. The fence was
  built around an empty lot.
- **The renderer would drop affordances the catalogue can already describe.**
  The login arm renders a live rotating code (`<TotpCode secret={item.totp} />`)
  and the card arm deliberately shows `•••• •••• •••• {last4}` while concealed,
  so a card is identifiable without being revealed. `TypedFields.tsx` renders
  every concealed field the same way — `ConcealedValue`, dots alone — so a naive
  migration shows a TOTP *seed* where a code belongs and loses the card's last
  four.

  The vocabulary is not the problem, though, and it is worth being precise
  because the first version of this paragraph got it wrong: `totp` and
  `payment-card` are **already in the closed catalogue, in both planes**
  (`catalogue.ts:53,99`; `catalogue.rs:152`). Nothing needs adding to the
  catalogue, and this is not the two-plane change it first looked like. The gap
  is entirely in the single-plane renderer, which does not yet branch on those
  two types. (`card.json` also types its number as `concealed` rather than
  `payment-card`, so the definition is not asking for the richer treatment
  either — a one-line change to the manifest.)

So 1a is not "delete the case arms". It is: build §6's handler registry, teach
`TypedFields.tsx` the two field types the catalogue already defines, and only
then migrate the JSX. Ordered that way it stays safe; done in the other order it
silently degrades a TOTP field or a concealed card number, which is the one
class of regression this vault cannot afford. Re-rated **Medium**, and sequenced
behind the handler registry rather than in the first group.

A partial migration is specifically the wrong answer here: leaving four kinds
on the switch and three on the generic path is the ADR-0087 shape all over
again, one level down.

*1b — converge storage (needs its own ADR).* Collapse the seven variants into
`TypedItem`. This is what Decision §1 actually asks for, and it is a
client-side data migration inside sealed vaults plus a deliberate trade of
static typing for uniformity. It should be argued on its own merits, with a
migration plan and a rollback story — not slipped in behind 1a.

**Payoff:** 1a retires most of the ~1,900 duplicated lines. 1b is what closes
ADR 0087, and is the expensive half.

**Guard:** after 1a, a test asserting no per-kind `switch` survives in a
rendering path. After 1b, none outside `model.ts`'s storage narrowing.

### 2.2 Repository layer — two hand-written implementations of 23 interfaces

**Now:** `packages/database/src/repos/` holds `interfaces.ts` (866 lines,
23 repository interfaces), `postgres.ts` (2,898), `memory.ts` (1,810) and
`agent-auth-repo.ts` (719). Postgres and memory are hand-maintained parallel
implementations that must stay behaviourally identical. The Postgres side is
mechanical Drizzle: `insert(...).values({...}).returning()`, a unique-violation
catch, and a `mapX(row)` call — the `channelBindings` block is representative.

This is the highest raw line count that is genuinely mechanical, and the
duplication is the dangerous kind: a divergence between the two backends is a
test that passes in memory and fails in production.

**Move — two options, and the second is better:**

*Option A (codegen):* emit both implementations from the Drizzle schema plus a
per-repo mapping manifest. Effective, but generated code of this volume is
unpleasant to review and to debug.

*Option B (generic engine over the mechanical subset — recommended, with a
limit):* keep one hand-written Postgres adapter, and drive the in-memory
backend from the table metadata Drizzle already holds.

The limit matters and I got it wrong on the first pass: `memory.ts` is **not**
pure CRUD. It carries 46 sites of domain logic — `interactionMachine.isTerminal`
guards on status transitions, `OUTBOX_CLAIM_HOLD_MS` claim leases, version
compare-and-set. None of that is derivable from schema metadata, because none of
it is a schema fact. A generic engine can serve the mechanical majority; the
invariant-bearing methods stay hand-written on both sides. So the realistic
saving is well under the 1,810-line file, and the estimate in the table is the
mechanical portion, not the file.

**Guard — and this is the actual deliverable here, more than the engine:** a
shared conformance suite run against every backend. It is the only thing that
keeps two implementations of a state machine honest, it is what makes a third
backend cheap instead of a third rewrite, and it is worth building even if the
generic engine is never written.

### 2.3 MCP surfaces — the registry describes them but does not generate them

**Now:** `packages/capability-registry` holds 127 capabilities, each mapping
five surfaces (`cli`, `pwa`, `mcp_host`, `mcp_client`, `webmcp`) or carrying an
ADR-cited exclusion. It is well-designed data. But it only *asserts parity* —
the parity sweeps check that a token exists in the surface's source.

Meanwhile `apps/mcp-host` hand-writes 2,114 lines across `tools-read.ts`
(1,014), `tools-act.ts` (622) and `tools.ts` (478). Every entry has the same
shape: `server.tool(name, description, paramSchema, async handler)` where the
handler is `hostFetch(path)` → `agentJson(body, ok, responseSchema)` →
`toolError` on throw. That is a five-column table rendered as code.

**Move:** promote the registry from *assertion* to *source*. Add the missing
columns to each capability — HTTP method, path template, parameter schema,
response schema — and let one registrar render the tool surface from it.
`registerTool(capability)` replaces ~1,600 lines of transcription.

**Payoff:** this is where ADR 0065's parity guarantee actually becomes
structural. Today parity is *checked*; after this it is *unrepresentable*
otherwise — a capability cannot exist on the host without appearing on the
agent surfaces or carrying its exclusion, because the same record produces
both. Adding a capability becomes one registry entry rather than an entry plus
three hand-written adapters plus a parity test that confirms you wrote them.

This is the change most aligned with the repository's own stated goals, and it
is low-risk because the registry is already authoritative in intent.

### 2.4 OpenAPI — a 2,738-line hand-written document

**Now:** `apps/control-plane/src/openapi.ts` is a hand-authored OpenAPI 3.1
document. It declares 77 paths. The route modules under
`apps/control-plane/src/routes/` contain 703 method registrations.

The two numbers are not directly comparable — the 703 includes sub-app mounts
and middleware, so the real route count is lower — but the gap is large and
nothing verifies it. A hand-written spec beside 40+ route modules drifts, and
drift in a published API document is a correctness problem for every consumer,
including `packages/api-client`.

**Move:** the plane already depends on Zod `3.25.67`. Derive the document from
route definitions — `@hono/zod-openapi` or equivalent — so the spec is a build
output, not a maintained file. `pnpm generate:openapi` already exists as the
emit step; it should emit from routes rather than from a parallel description.

**Interim guard, if the full move is deferred:** a test asserting every
registered route appears in the document. That converts silent drift into a
failing check for a fraction of the effort, and is worth doing even if the
derivation lands later.

### 2.5 WIT — an IDL used as documentation

**Now:** `wit/` holds seven worlds, 324 lines. Exactly one —
`wit/connector` — is used for binding generation, via
`wasmtime::component::bindgen!` in `crates/connector-host/src/wasm.rs:40`.

The other six are read as *text* and substring-asserted in tests. From
`crates/host-core/src/lib.rs:660`:

```rust
let src = read_wit("wit/task/world.wit");
assert!(src.contains("authorize-and-invoke"));
assert!(src.contains("restrict"));
```

These assertions are load-bearing for security posture — `assert_no_secrets_or_arbitrary_sign`
enforces ADR 0005's no-`getSecret()` rule at the contract level, which is a
genuinely good idea. But `contains()` on source text is a weak instrument: it
passes on a commented-out line, on a renamed parameter, on a type change that
preserves the identifier.

**Move:** extend `bindgen!` to the remaining worlds so the Rust types *are* the
WIT types. The security assertions then run against a parsed AST rather than a
string, and every drift between contract and implementation becomes a compile
error instead of a passing substring test.

**Note on risk:** this is the one item where the constraint is real rather than
organisational. `wasmtime` is banned from daemon dependency trees by
`pnpm audit:daemon-deps` (ADR 0048 §5), so the binding generation must not drag
the runtime into those crates. `wit-bindgen` (guest-side, no wasmtime) or a
build-script parse using `wit-parser` alone are the paths that respect that
budget. Confirm against the daemon gate before committing to an approach.

### 2.6 GuideLang — one AST, four dispatch sites

**Now:** eleven instruction kinds in `packages/guide-lang/src/ast.ts`, switched
over in four files: `parse.ts` (10 arms), `serialize.ts` (13), `validate.ts`
(9), `guide-runtime/src/runtime.ts` (18). Adding an instruction means four
files plus tests, and a missed site is a silent gap rather than a type error.

**Move:** this is the textbook visitor case, and TypeScript makes it pleasant
without ceremony — an `InstructionVisitor<T>` record with one method per kind,
and exhaustiveness enforced by the compiler through a `never` check. Each of
the four sites becomes a visitor instance; a new kind fails to compile until
every site handles it.

**Payoff:** small in lines, large in the property gained. Given ADR 0088's
security posture — a model may emit GuideLang and nothing else — a silently
unhandled instruction kind in `validate.ts` is precisely the failure that
matters most. Compiler-enforced exhaustiveness across all four sites is a
security property here, not a tidiness one. Recommend doing this early despite
the modest line count.

### 2.7 Connector providers — an open-coded strategy table

**Now:** `crates/connector-host/src/providers.rs` (1,832 lines) dispatches on
`match (provider_id, operation)` — `("aws-secrets-manager", Read)`,
`("aws-parameter-store", List)`, and so on — each arm building an argv. Adding
a provider means editing a match in a compiled crate and shipping a binary.

The irony is that `manifest.rs` (515 lines) already defines
`ConnectorManifest`, `OperationSpec`, `AuthMode` and `Outbound` — the
declarative vocabulary exists. Providers just do not go through it. This is the
same shape as §2.1: the declarative path was built beside the hardcoded one.

**Move:** express providers as manifests over a closed, auditable command
vocabulary, and reduce `providers.rs` to an interpreter.

**Caveat worth stating:** these arms construct subprocess invocations, so the
manifest schema must be a *closed* vocabulary — a fixed executable allowlist
and typed argument slots — never a free-form command string. A manifest that
can express arbitrary argv is a code-execution surface wearing a data costume.
`crates/ceremony`'s typed capture slots that fail closed are the right model.
This is why this item sits at medium risk despite being mechanically similar to
the others.

### 2.8 `crates/storage` — a 10,601-line god-struct

**Now:** `crates/storage/src/lib.rs` is 10,601 lines. `Db` carries 210 `pub
async fn` methods spanning certificates, CAs, PKI policy, approvals, signers,
discovery, alerts, sync blobs and more. The `Store` trait at line 6,591 has
exactly one method (`quorum_ok`) — a false seam that looks like an abstraction
boundary and is not one.

**A correction worth recording, because it reverses the reasoning.** A first
pass counted 15 files outside the crate referencing `Db` and concluded the blast
radius was small. That measured the wrong thing. `AppState` holds `pub db: Db`
(`apps/gateway/src/app_state.rs:64`), so consumers reach storage through the
state handle: **134 call sites across 32 files in the gateway alone**. The
coupling is wide, not narrow, and this is a genuine modularity problem rather
than only a readability one.

**Move:** split by bounded context — `storage::certificates`,
`storage::approvals`, `storage::signers`, `storage::sync` — each with a real
trait carrying its own methods. Compose them on `Db` so external call sites
keep working, then migrate consumers to the narrow traits.

**Priority: still last, for the opposite reason.** Not "harmless, so defer" but
"expensive and wide, so sequence it deliberately". 134 call sites across a
10,601-line file is the highest merge-conflict cost in the plan, and it wants
the narrow traits designed against real bounded contexts rather than guessed.
Do it after the cheaper items have paid for themselves, as a mechanical file
split first, with trait design deferred until the contexts are legible. It is
the biggest modularity win available — and the one most likely to go wrong if
taken early.

### 2.9 Reproducibility — the cache is over-hashing

Toolchain pinning is genuinely good: `rust-toolchain.toml` pins 1.88.0 with
components and targets, pnpm is pinned via `packageManager`, both lockfiles are
committed, and there is an SBOM target.

The gap is `turbo.json`. Across 68 workspaces, no task declares `inputs`, and
there is no `globalDependencies`. Turbo therefore hashes each package's entire
contents for every task, so a README edit invalidates `build`, `typecheck` and
`test` for that package and everything downstream. Two consequences:

- **Cache misses that look like flakiness** — CI re-runs work it has already
  proven, and the cache appears unreliable rather than merely imprecise.
- **Missing global invalidation** — `globalDependencies` is not declared at
  all, while **51 packages extend a shared root config** (`tsconfig.base.json`,
  `config/tsconfig.library.json`). Editing one of those changes how every
  dependent package compiles, and Turbo has not been told, so a cached
  `typecheck` can outlive the config that produced it. That is a correctness
  gap, not a speed one. (Lockfile changes are excluded from this claim —
  Turbo hashes lockfiles specially, so they do not need declaring.)

**Move:** declare `inputs` per task (`src/**`, `package.json`, `tsconfig.json`)
and `globalDependencies` (`pnpm-lock.yaml`, root configs). Small change,
immediate and measurable effect on both cache hit rate and cache soundness.

Worth noting: `pnpm verify`, the audit gates, and the coverage/mutation suites
are not in `turbo.json` at all — they are shell scripts outside the graph. That
is a defensible choice for gates that must not be cached, but it means the
heavy suites get no dependency-aware scheduling. Not urgent; worth revisiting
once `inputs` are correct.

### 2.10 The field-type catalogue is written twice

Found while scoping §2.1a, and it is the thesis in miniature. ADR 0087's closed
field-type catalogue is one contract with two hand-written implementations:
`packages/vault-item-types/src/catalogue.ts` (170 lines) and
`crates/vault-item-types/src/catalogue.rs` (205). Both enumerate the same
vocabulary — `concealed`, `password`, `key-material`, `month-year`,
`person-name`, `host-port`, `payment-card`, `totp` — and both must agree, because
the definitions corpus is embedded by both planes and a field type either plane
does not know is a definition that plane cannot load.

The asymmetry with the definitions is the interesting part, and it is sharper
than "one got generated and the other did not". The corpus is safe in *both*
planes, by two different mechanisms: Rust embeds the JSON directly with
`include_str!` on `definitions/*.json`, so it cannot drift — the compiler reads
the real file — while TypeScript, which has to bundle for a browser and cannot
read files at runtime, generates `definitions.generated.ts` and guards it with
the drift test in `registry.test.ts:93`. Two planes, two mechanisms, both sound.

The catalogue that *validates* that corpus has neither. It is hand-written twice
and kept in step by a comment: `catalogue.rs:68` says "Every catalogue entry, in
the same order as the TypeScript table." Nothing tests that claim. The data got
the treatment; the schema describing the data is on the honour system.

**Move:** the same one already applied to the definitions — author the catalogue
once as data and generate both planes' constants from it, with the drift test
`registry.test.ts:93` already models. Low risk and small; the vocabulary is
closed and changes rarely, which is exactly why the duplication has survived
unnoticed.

## 3. Composition patterns worth standardising

Three already work well here and should be named as house patterns so they are
reached for by default rather than reinvented:

1. **Closed contract + registry + adapters** — `notification-adapters` is the
   reference. A closed capability record (`packages/os-domain/src/notifications.ts`),
   adapters that cannot widen it, a registry that resolves by kind. Applies
   directly to §2.2 and §2.7.

2. **Manifest over closed catalogue** — `vault-item-types` is the reference:
   fields name types from a closed catalogue, and a concealed field can never
   reach `subtitle`, `search` or a filename. The closure is what makes the
   manifest safe to accept from outside. Applies to §2.1, §2.3 and §2.7.

3. **Pure core, ports at the edges** — `guide-runtime` executes over ports with
   no DOM, no renderer and no real timers, and re-enforces every budget rather
   than trusting the parser. `crates/lifecycle` and `crates/security-events` are
   pure and value-blind. This is why those modules are testable without
   scaffolding, and it is the answer to the 852 `vi.fn()` calls sitting behind
   only a 328-line shared testing package: mock volume is usually a symptom of
   I/O that was never pushed to an edge.

## 4. Where generative templates pay, and where they do not

Codegen earns its place when a contract already exists in machine-readable form
and code is being transcribed from it by hand. By that test:

**Strong candidates.** Three of these have a machine-readable contract today.
The MCP row does not, quite: `capability-registry` records *that* a capability
maps to a surface, never *how* to call it — there is no method, path or schema
column in it. So that row is "extend the registry by four columns, then
generate", which is design work before transcription work, not transcription
alone. It stays top of the list because the registry is already authoritative
in intent; it is just not yet sufficient in content.

| Target | Source of truth | Retires |
|---|---|---:|
| MCP/WebMCP tool surfaces | `capability-registry` | ~1,600 |
| In-memory repository backend | Drizzle schema metadata | ~1,800 |
| OpenAPI document | Route + Zod definitions | 2,738 |
| Rust types for 6 WIT worlds | `wit/*.wit` | drift, not lines |
| Vault item rendering | `definitions/*.json` | ~1,900 |

**Poor candidates** — worth stating explicitly, because the failure mode of a
codegen push is generating things that should have been designed:

- **Gateway route handlers** (33,168 lines). The prologue is repetitive —
  authorize, act, audit, respond — but the middles are genuinely different, and
  they are where the security decisions live. Extract the prologue as
  composable middleware; do not template the handlers.
- **Crypto and protocol cores** (`human-vault`, `pki-core`, `rotation-web`).
  Small, high-value, correctness-critical, low-churn. Hand-written and
  hand-reviewed is right.
- **UI sections.** `AccessSection.tsx` (4,161) and `IdentitySection.tsx`
  (2,884) are large, but from too much in one file rather than repetition.
  Decompose along `CeremonyShell`/`FieldShell` seams that already exist.

Two constraints any generator here must respect, both from existing ADRs:
generated output must never be able to express a raw-secret accessor (ADR
0005), and generated agent surfaces must carry ADR 0065's exclusions rather
than silently omitting a capability.

## 5. Suggested sequence

Ordered so each step is independently shippable and the early steps buy time
for the later ones. Sizes are relative, not calendar estimates.

**First — finish what is started.** §2.1a (render the seven through their
manifests) and §2.9 (turbo `inputs` and `globalDependencies`). Both are small
and low-risk, and together they demonstrate the thesis: complexity comes out by
*removing* the superseded path. §2.9 pays back immediately in CI time and
closes a cache-correctness gap.

Note what moved: §2.1**b** — converging storage onto `TypedItem` — is
deliberately *not* here. It is the half that actually closes ADR 0087, and it is
a client-side migration inside E2EE vaults. It belongs with the fourth group,
behind its own ADR.

**Second — make the registry generative.** §2.3, then §2.6. The MCP work turns
ADR 0065's parity from checked to structural. The GuideLang visitor is small
and buys a compile-time security property under ADR 0088; do not defer it just
because the line count is modest.

**Third — derive the contracts.** §2.4 (OpenAPI from routes) and §2.5 (WIT
bindgen, subject to the daemon dependency budget). These remove whole classes
of drift rather than lines.

**Fourth — the adapter and migration work.** §2.2 (shared conformance suite
first, generic backend second — in that order, since the suite is what makes the
backend safe to write), then §2.7 (provider manifests over a closed vocabulary),
then §2.1b behind its own ADR. Each wants its conformance suite in place before
the old path is deleted.

**Last — `crates/storage`.** §2.8. Mechanical file split first; trait design
once the bounded contexts are legible.

## 6. The guard that makes this durable

Every item above is a migration, and this repository's demonstrated failure
mode is that migrations stop at the seam. ADR 0087 shipped an engine, authored
23 manifests, and left the seven hardcoded arms in place — and the two files it
targeted are larger today than when it was written.

So the recommendation is procedural as much as architectural: **no migration in
this plan is done when the new path works. It is done when the old path is
deleted and a test forbids its return.**

Concretely, each item ships with a guard:

- §2.1 — no `switch (item.kind)` outside `model.ts` storage narrowing
- §2.2 — one conformance suite, every backend
- §2.3 — registry entry is the only way to declare a tool
- §2.4 — every registered route appears in the emitted document
- §2.5 — WIT drift is a compile error, not a substring assertion
- §2.6 — exhaustiveness via `never`, checked by the compiler

The pattern already exists in-repo and works:
`packages/vault-item-types/src/registry.test.ts:93` ("keeps the generated
module in step with the JSON corpus") re-reads `definitions/*.json` from disk
and fails if the embedded copy has drifted, in either direction. That is
exactly the shape every item above needs — and its presence in the one place
codegen was adopted, next to its absence everywhere the old path survived, is
the clearest evidence that the guard is what makes the difference.

Two details from that guard are worth copying. It fails rather than silently
regenerating, which is why `generate` is deliberately absent from
`turbo.json` — a stale artifact should break the build, not be quietly
repaired under a developer. And it compares in both directions, so a
definition added to the corpus without regenerating fails just as loudly as
an edited artifact.

Those guards are the deliverable. The line reductions follow from them; without
them, this document describes a second set of paths to maintain beside the
first.

## 7. What this evaluation did not cover

Stated so the gaps are not mistaken for clean bills of health:

- **No behavioural verification.** This is a static read of structure and
  volume. Line counts and call-site counts are exact; claims about what is
  *mechanical* versus *essential* are informed judgement and should be checked
  against a real diff before the larger items (§2.2, §2.7, §2.8) are committed
  to.

  This caveat has already earned its place. An adversarial re-read of the first
  draft found four errors of exactly this kind, all now corrected above:
  §2.1 was described as a rendering change when it is a storage migration;
  §2.2 assumed `memory.ts` was pure CRUD when it carries state-machine and
  lease logic; §2.8's "low coupling" rested on a count that missed
  `AppState.db` and was wrong by 8×; and §4 claimed a machine-readable contract
  for MCP generation that does not yet exist. Three of the four were
  *optimistic* — they made work look cheaper than it is. Treat every remaining
  "Low risk" here as provisional until someone has tried it.
- **The 703-vs-77 OpenAPI figure is a drift signal, not a route census.** The
  703 includes mounts and middleware. The gap warrants the guard in §2.4; it
  does not by itself quantify undocumented routes.
- **Test suites were measured, not assessed.** 155,024 lines of TS tests and
  852 `vi.fn()` calls are reported as duplication signals. Whether that mocking
  is load-bearing was not examined, and the test-depth suites
  (`test:coverage`, `test:mutation`, `test:fuzz`) were not run.
- **No security review was performed.** Several items touch security-relevant
  paths — §2.5 (WIT contract assertions enforcing ADR 0005), §2.7 (subprocess
  construction), §2.3 (agent-facing surfaces). Each needs the relevant
  `pnpm audit:*` gates and, for §2.7, a `security-review` pass before landing.
- **No ADR is proposed here.** These are candidate decisions. §2.2, §2.3 and
  §2.7 change contracts that existing ADRs govern and should each get their own
  ADR before implementation.
