# Verifying capability composition

How each claim in [ADR 0130](../adr/0130-operator-controlled-capability-composition.md)
is checked, which gate checks it, and what the checks cannot tell you.

The claim under test is unusual: it is mostly about **absence**. "This build
does not contain the connector implementation" and "this document never
evaluated the WebMCP module" are not things a feature test can assert by
exercising a feature. They are measured from artifacts and from recorded runs,
by something other than the thing that produced them.

## 1. Six layers, each answering a different question

| Layer | Question | Method | Where |
|---|---|---|---|
| 1. Source and imports | Can this code even reach that code? | classification rules over every source file; import-boundary assertions | `apps/pages/src/lib/capabilities/classification*.ts` + `classification.test.ts`, `openfeature-defaults.test.ts` |
| 2. Emitted output | Is the implementation in the artifact at all? | the build's own graph, then an independent re-derivation from `dist/` on disk | `scripts/capability-compose-plugin.mjs`, `scripts/verify-capability-graph.mjs` |
| 3. Network and cache | Did anything get fetched or stored that should not have been? | destination classification before the socket; cache-name ownership; recorded requests | `lib/capabilities/egress.ts` + `egress.test.ts`, `src/sw/cleanup.test.ts` |
| 4. Execution and registration | Did the module evaluate, and did its contributions appear? | lease and generation fencing; evaluated-module facts; registry reads | `loader.test.ts`, `registry.test.ts`, `store.test.ts`, `authority.test.ts` |
| 5. Functional preservation | Does the full surface still work when everything is selected? | the legacy Playwright journeys under the `rich-explicit` profile | `verify:static`, `verify:keyboard`, `verify:mobile`, `verify:auth`, `verify:local-iam` |
| 6. Independent challenge | Would a hostile document, provider or tab get through? | red-team fixtures and rejection profiles; fail-closed assertions | `trust/*.test.ts`, `profiles.test.ts`, the four `managed-invalid-*` profiles |

A claim is only as good as the layer that can see it. "No rail row appears" is
layer 4 and says nothing about layer 2; "the chunk is not in `dist/`" is layer
2 and says nothing about whether some other chunk does the same job.

## 2. Which gate proves which contract

`docs/evidence/capability-composition/contract-test-matrix.json` is the
machine-readable map from a contract id to the tests that demonstrate it, with
the run each result came from. This section is the human summary.

### Pure semantics — `cd packages/capability-composition && pnpm exec vitest run`

The resolver, the parsers, the digests and the review are pure over their
input: no fetch, clock, storage, DOM or dynamic import. That is what makes them
testable as arithmetic.

- **Determinism (MODEL-07)** — reordering every input list yields an identical
  plan digest and identical explanations.
- **Monotonicity (MODEL-08)** — a property test (fast-check, recorded seed
  `20260922`) over generated policies, workspace restrictions and vault
  selections: tightening never grows `approvedCapabilities`, `approvedModules`
  or `approvedOperations`. This is the single most important check in the
  feature, because every other scope guarantee reduces to it.
- **Catalog validation (MODEL-06)** — unknown dependencies, cycles including
  through an alternative, chains deeper than 16, duplicate ids, oversize and
  malformed module prefixes are all rejected *boundedly*.
- **Parser strictness (MODEL-02, MODEL-03)** — overlapping id sets fail; a
  `default` other than `deny` fails; `allow: null` and `allow: []` stay
  distinct. Two fuzz suites assert the parsers never throw on arbitrary JSON
  and fail closed under field-by-field mutation of fixture-shaped documents.
- **Consent (CONSENT-04, CONSENT-05)** — a capability the catalog gains later
  is not covered by an existing receipt; a changed egress declaration or a new
  dependency re-opens consent.

Observed 2026-09-22: **10 test files, 60 tests, all passing.**

### Pages runtime — `pnpm --filter @opensesame/pages exec vitest run src/lib/capabilities`

- **Loader (LOAD-06, LOAD-07, LOAD-09)** — an undistributed id is refused
  before the module table is touched; an unapproved distributed module is
  refused; a module whose runtime names another capability is refused; an
  import revoked mid-flight is refused *and marks the realm dirty*; repeated
  enable/disable disposes every handle and never duplicates a registration.
- **Store (MODEL-01, CONSENT-08, CONSENT-09, LIFE-01, LIFE-09, TRUST-08)** —
  core-only resolution with no selection; a superseded draft conflicts;
  a failed durable write publishes nothing; emergency disable blocks in memory
  and aborts the lease before storage answers, and still blocks when the write
  fails; an invalid managed policy is `managed-invalid` and core-only.
- **Authority (LIFE-04)** — `admitOperation` refuses on a newer durable
  generation, a stale lease, an unapproved operation, and the absence of Web
  Locks. Four of its five cases are refusals; that ratio is the point.
- **Trust (TRUST-02..TRUST-10)** — algorithm confusion, key substitution,
  tampered payload and header, wrong instance and wrong origin, rollback
  including a restored copy, same-revision-different-digest conflict, rotation
  only by the trusted key, validity judged by a supplied clock, and an
  expired policy that keeps governing while accepting nothing new.
- **Egress (NET-01..NET-05)** — same-origin-only assets; external services
  needing declaration *and* plan allow *and* a listed origin; local network
  needing the deployment profile; redirects never followed; and no query
  string in any error or decision.
- **OpenFeature (OF-01..OF-08)** — installs and answers with no network; a
  malicious provider can lie to the UI but never to the loader; a release flag
  can only restrict; only the projection and its facade import the SDK, and
  the loader, authority, store, registry and lease never read a flag.
- **Profiles (11 fixtures)** — each resolves to the approved count it claims:
  `minimal-local` 0 optional, `family-local` 0, `family-sharing-selected` 2,
  `single-provider-selected` 2, `enterprise-selected` 6, `rich-explicit` 24,
  `managed-prohibited` 1, and the four `managed-invalid-*` fixtures approve
  nothing optional for four different reasons.

Observed 2026-09-22: **20 test files, 167 tests, 166 passing, 1 failing.** The
failure is `classification.test.ts > matches every source module the build
sees`, naming three helper files written minutes earlier by concurrent
module-owner work that have no classification rule yet. It is recorded rather
than glossed; the check is doing exactly its job.

### Boot — `pnpm --filter @opensesame/pages exec vitest run src/lib/runtime-config.test.ts src/App.test.tsx`

- The shipped `os-runtime-config.json` is an empty object, so the boot fetch is
  a 200 and not a 404.
- An invalid `capabilityComposition` section is `invalid` with a **null**
  policy, and core endpoints are still applied (TRUST-08).
- A known optional section the plan lacks answers with the unavailable route;
  an optional popup route the plan did not contribute is withheld (LOAD-03).
- Contributed unlock effects run once after unlock and nothing runs while
  locked.

Observed 2026-09-22: **2 test files, 24 tests, all passing.**

### Build — `node apps/pages/scripts/build-profile.mjs`

- `capability-compose-plugin.mjs` generates the module table from
  compile-time-known specifiers only, emits `capability-distribution.json` and
  `capability-graph.json`, and **fails the build** on reachability of an
  excluded module from any entry (BUILD-05, BUILD-06, BUILD-08, LOAD-04).
- `verify-capability-graph.mjs` then re-derives the same closure from `dist/`
  on disk — enumerating every file, parsing each HTML entry for module scripts
  and modulepreloads, lexing every JS chunk with `es-module-lexer` — and checks
  that the emitted graph agrees with disk (EVID-02). `--expect-absent <module-id>`
  asserts a module is in no chunk and no `cap-<capability>-*.js` chunk exists
  (BUILD-04).
- `--all` runs the eight-build matrix and aggregates sizes into
  `dist-profiles/measurements.json`.

**The verifier is deliberately not the plugin.** A build step that certifies
its own output proves nothing; the separation is the evidence.

### Browser journeys

The legacy full-surface suites keep their coverage by running under the
explicit `rich-explicit` profile (`PAGES_CAPABILITY_FIXTURE=rich-explicit`),
with the journey accepting the installation's declared capabilities on the
front door. Minimal-profile journeys run with no fixture and assert **absence**.
Neither family is deleted — that is the functional-preservation layer, and
deleting a full-surface test to make a minimal build pass would be the exact
failure this feature is supposed to prevent.

The existing Pages gates continue to apply unchanged to whatever a profile
does render: `verify:static`, `verify:mobile`, `verify:keyboard`,
`verify:auth`, `verify:local-iam`.

## 3. Running the whole thing

```bash
export NODE_OPTIONS="--max-old-space-size=8192"

# Layer 1 + 4 + 6, fastest signal
cd packages/capability-composition && pnpm exec vitest run
pnpm --filter @opensesame/pages exec vitest run src/lib/capabilities
pnpm --filter @opensesame/pages exec vitest run src/lib/configuration src/screens/capabilities src/sections/settings/CapabilitiesPanel.test.tsx
pnpm --filter @opensesame/pages exec vitest run src/sw scripts/capability-compose-plugin.test.mjs scripts/verify-capability-graph.test.mjs

# Layer 2, the one that costs a build
node apps/pages/scripts/build-profile.mjs --all

# Layer 5, against a fresh build
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium pnpm --filter @opensesame/pages verify:static
```

Changes to the bootstrap, a module, a worker or the build take
`build:profile` and `verify:capability-graph` as merge gates (ADR 0130,
Consequences). Changes to the catalog, the ownership map, the presets or the
profile fixtures take the Pages capability suites. Changes to the resolver or
the parsers take the composition package's suites, including the property test.

## 4. What these gates do not tell you

Each of these is a real limit, not a backlog item. The full ledger is
[`docs/evidence/capability-composition/limitations.md`](../evidence/capability-composition/limitations.md).

**No same-realm sandbox.** Every check here is about *admission*: whether the
import happens. Once a module is evaluated it is same-origin code with the run
of the page. No test in this suite constrains what an evaluated module does,
and none could — that is review's job, not the loader's.

**No unloading of evaluated modules.** A test can prove that contributions were
revoked, handles disposed and the lease aborted. It cannot prove the namespace
is gone, because JavaScript has no way to discard one. The honest report is
`restartRequired`, and the tests assert that the system *says* so rather than
claiming a clean removal.

**No cryptographic rollback prevention.** The rollback and conflict tests
(TRUST-05, TRUST-06) prove **detection**. Browser storage is editable and
restorable by its owner; nothing here prevents the edit, and a green test on
those contracts must not be read as if it did.

**No trusted offline clock.** Validity is judged by a clock the caller supplies
(TRUST-09), which is what makes the check testable — and is also the admission
that no clock on the device can be relied on. An expired policy keeps running.

**Chromium only.** The browser layers run in the pinned Chromium at
`/opt/pw-browsers/chromium`. The coverage instrumentation, the
precise-memory and performance APIs the measurement harness uses, and the
service-worker behaviours being measured are all Chromium's. Firefox and
WebKit are not covered by any of this.

**Selective delivery is measured, not enforced.** In `selective` mode the
`--expect-absent` assertions are meaningless: every module is on the host by
design. Absence evidence only means what it says in a `hardened` build.

**"No request was made" is a recorded run, not a proof.** Layer 3 records what
one run in one browser did. It is strong evidence and it is not a universal
quantifier.

**A pending contract is not a passing one.** Sixteen contracts in
`contract-test-matrix.json` carry `"status": "pending"` with an owner area —
including the whole `SURFACE-08`/`SURFACE-09` shell cluster, the `VAULT-*`
family (which has no assigned contract id anywhere in the checkout), and
`BUILD-07`. Absence of a test is recorded as absence of evidence, never as a
green row.

## Related

- [ADR 0130](../adr/0130-operator-controlled-capability-composition.md) — the decision
- [`docs/operators/capability-composition.md`](../operators/capability-composition.md) — the operator guide
- [`docs/evidence/capability-composition/baseline.md`](../evidence/capability-composition/baseline.md) — what was measured before the change
- [`docs/evidence/capability-composition/limitations.md`](../evidence/capability-composition/limitations.md) — the P-TRUTH ledger
- [`docs/evidence/capability-composition/contract-test-matrix.json`](../evidence/capability-composition/contract-test-matrix.json) — contract → test
- [`docs/evidence/capability-composition/assignment-ledger.json`](../evidence/capability-composition/assignment-ledger.json) — ownership and landed surface
- [`docs/validation/code-quality-gates.md`](code-quality-gates.md) — the structural gates every file here also passes
