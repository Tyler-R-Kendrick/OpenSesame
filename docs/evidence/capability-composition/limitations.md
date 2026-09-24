# Limitations — what capability composition does not claim

- Date: 2026-09-22
- Branch: `claude/new-session-9wpwbh`
- Decision: [ADR 0130](../../adr/0130-operator-controlled-capability-composition.md)
- Baseline: [`baseline.md`](baseline.md)

This is the P-TRUTH ledger. Each entry names a claim a reader could
reasonably infer from the feature, says plainly that it does not hold, and
points at the file that says so. Nothing here is a to-do: these are
properties of the browser and of the threat model, not gaps someone forgot
to close. Where a claim is weaker than it looks, the product copy has to say
so too — `apps/pages/src/lib/capabilities/trust/` is tested for exactly that
(`expiry-provenance.test.ts` — "states its limitations in product copy").

## 1. There is no same-realm sandbox

An optional module is same-origin JavaScript in the document that loaded it.
Once it is evaluated it can reach anything the page can reach. The loader is
an **admission** gate, not a confinement boundary: `loadApprovedModule`
decides whether the import happens at all (`apps/pages/src/lib/capabilities/
loader.ts`), and after that the module is ordinary application code.

What follows from that:

- A module is given ports, not the run of the page — a registrar, the parsed
  runtime config, a scoped `hydrate`, the vault's tomb id and guest flag, and
  a destination-validated `EgressPort` (`runtime-contract.ts`,
  `egress.ts`). Those ports are the *interface*, not a cage. A module that
  ignored them and reached for `window` directly would not be stopped by the
  loader; it would be stopped by review.
- Browser extensions, devtools, and the person who owns the browser are all
  outside the model. Local state is editable by its owner, by design.
- The composition documents are non-secret metadata by construction
  (`ownership.md` §4.5). Nothing in this feature keeps a secret from the
  device it is stored on.

## 2. An evaluated module cannot be unloaded

JavaScript has no way to discard a module namespace. Deselecting a capability
whose module already ran therefore cannot undo the evaluation. What the system
does instead:

- `activate` returns a `RuntimeHandle` whose `dispose` is called, contributions
  registered under the old generation are revoked, and the lease is aborted
  (`loader.ts` `deactivateGeneration`, `registry.ts` `revokeGeneration`). The
  feature stops being reachable.
- The plan then reports the capability as `restartRequired`, computed from
  `facts.evaluatedModuleIds` (`resolve.ts` `buildState`), and the UI says
  "restart required" rather than "disabled"
  (`apps/pages/src/screens/capabilities/status.ts`).
- A module whose lease went stale *during* its import is still marked
  evaluated (`loader.ts` calls `markModuleEvaluated` before awaiting the
  importer), because pretending otherwise would be the lie.

The same applies to service workers: unregistering a worker does not terminate
its clients synchronously, so the controller exposes a `transition-required`
state instead of racing a second registration
(`lib/capabilities/worker-controller.ts`).

## 3. There is no cryptographic rollback prevention

Browser storage is editable and restorable by its owner.

- The highest accepted policy revision is recorded
  (`capabilities.policy.accepted.v1`) and an older revision presented later is
  detected as a rollback, including a restored copy
  (`trust/accepted-revision.test.ts`, TRUST-05). The same revision arriving
  with a different digest is a conflict (TRUST-06).
- **Detection is not prevention.** Nothing here stops a person from editing
  their own browser's storage; it makes the edit visible to the next
  resolution.
- Cross-context ordering is a durable counter compared under a Web Lock
  (`authority.ts` `admitOperation`, `capabilities.generation.v1`). With no Web
  Locks it refuses (`no-serialization`) rather than guessing. That is
  serialization, not tamper-resistance.

## 4. There is no trusted offline clock

`Date.now()` is whatever the device says. The trust layer never reads it: a
policy's validity window is judged by an explicitly supplied clock
(`trust/envelope.test.ts`, TRUST-09), and the resolver takes `facts.now` as
input rather than reading a clock at all (`types-documents.ts` `RuntimeFacts`).

The consequence an operator has to live with: an expired policy keeps running
and keeps governing the device it is on — it simply stops accepting anything
new (`trust/expiry-provenance.test.ts`, TRUST-09/10). There is no way to make a
disconnected browser expire a policy on time.

## 5. A signature authenticates a document, not a deployment

- A verified envelope proves the document was signed by an **established** key.
  It does not protect a replaced bootstrap: an attacker who can serve
  `index.html` does not need to forge a policy.
- It does not establish first contact. An invitation that carries its own key
  verifies against itself and is therefore `invitation-unverified` until a
  human compares the fingerprint (`trust/join-review.test.ts`, TRUST-02/07).
  `PolicyProvenance` has a distinct value for exactly this state and the
  provenance is classified from the source, never inferred from the content.
- A same-origin deployment policy is labelled `same-origin-deployment` and is
  never called verified (`trust/expiry-provenance.test.ts`).

## 6. Selective delivery is not exclusion

In `selective` mode every first-party module is on the host; a device merely
declines to load the ones it did not select. Anyone can fetch a chunk directly.
If the requirement is that the implementation **not be on the server**, that is
`hardened` mode and a new artifact — excluded modules, HTML entries, public
files and worker variants are not emitted, and the build fails on reachability
from any entry (`scripts/capability-compose-plugin.mjs`,
`scripts/verify-capability-graph.mjs`).

Related: browser-local selection cannot rebuild a hosted site. Turning a
capability off in Settings changes what this browser loads; it does not change
what the deployment serves.

## 7. The load path is a module table, not a verifier

Modules are same-origin, immutable-URL chunks imported from a compile-time
generated table. There is no `eval`, no blob module, and no home-grown loader
(`loader.ts`; the table maps an id to an import, never a URL a caller
supplied). Deliberately, there is **no** fetch-then-hash-then-`import(url)`
step: that would be two loads, and the second one is the one that runs.

## 8. OpenFeature projects, it does not decide

The provider is a local read-only projection over the store snapshot. A
provider that answers `true` for a prohibited capability changes what a UI
draws and nothing else — the loader, the authority check and the store read the
plan directly (`openfeature-consumer.test.ts`, OF-05/OF-08). This is a
deliberate weakness in the flag layer, compensated for by not trusting it.

## 9. Coverage limits of the evidence itself

- The browser evidence is **Chromium only**. Coverage instrumentation, the
  precise-memory and performance APIs the measurement harness uses, and the
  pinned browser at `/opt/pw-browsers/chromium` are all Chromium's. Firefox and
  WebKit behaviour is not measured here.
- The client-core Wasm is not emitted in this environment, so
  `bundle-budgets.json`'s 17.9 MiB `total` is not reproduced locally
  (`baseline.md`).
- "No network request was made" is evidence about a recorded run in one
  browser, not a proof about all runs.

## 10. Recorded contradictions between prose and the executable

From `baseline.md`, kept here so they are not quietly lost:

- `SetupScreen.tsx` had **four** statically imported tabs (connectors, ai,
  identity, mfa) when the decision was taken; [ADR 0114](../../adr/0114-tabbed-setup-ceremony.md)
  describes six. The list is now derived from contributions, so neither number
  is a target.
- The old `sw.ts` precached only `index.html`, while a comment in `App.tsx`
  claimed the shell chunk was precached.
- The old `sw.ts` deleted every Cache Storage entry whose name was not its own
  — origin-wide, not application-scoped.

## 11. Contracts with no landed test

Tracked in [`contract-test-matrix.json`](contract-test-matrix.json) with
`"status": "pending"` and an owner area. A pending row is a claim nobody has
demonstrated yet; it is not a claim that has been disproved, and it is also not
evidence.

## 8. The selective build's reachability number is a chunk measurement

The reachability gate reports every optional-owned module that sits inside a
chunk the entry statically reaches. That is the right thing to measure — a
module in such a chunk *is* downloaded and evaluated — but it means the
number does not fall one import at a time. It falls when a whole chunk
leaves the static closure, and not before.

Measured on this branch (`apps/pages/dist/capability-graph.json`, default
selective build): **10 of 62 chunks** are statically reachable from the
entry, and one of them holds **1062 modules**. Rollup names that chunk after
whichever capability first imported it dynamically, but its contents are the
shared optional library surface — so a single remaining static edge into it
keeps roughly a thousand modules inside the closure and the reported number
pinned near its current value.

Three real cuts landed in this delivery, each of them a correct ownership
statement rather than a number-chasing edit:

- `lib/duress/settings/*` named `@opensesame/contracts` (a 27-module barrel)
  where it wanted one corner; it names `@opensesame/contracts/duress` now.
- `lib/orgs.ts` mixed the core sign-in vocabulary with four Identity-API
  directory calls; the calls moved to `lib/orgs-directory.ts`, which
  `identity.federation` installs into seams that otherwise refuse.
- the duress corner of `@opensesame/contracts` is classified core
  (`vault.local-unlock`, ADR 0131) instead of inheriting the package's
  `connectors.external` rule.

Together they took the report from 354 to 331 and removed nine static edges.
That ratio is the point of this entry: the remaining work is not a list of
imports to delete. It is that **a selective build shares one chunk across
capabilities**, which ADR 0130 §6 explicitly permits — the device loads only
its accepted graph, and exclusion is a promise only a hardened build makes.
A hardened build does not emit the excluded modules at all, which is why the
gate is enforcing there and a diagnostic here.

Anyone continuing this should not start from the violation list. Start from
`capability-graph.json`: find the chunks in the entry's static closure, and
decide for each whether it should be there at all.
