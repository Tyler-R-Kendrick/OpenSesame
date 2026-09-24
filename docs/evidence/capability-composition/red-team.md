# Red team — what was attacked, what held, what was not attempted

- Date: 2026-09-22
- Branch: `claude/new-session-9wpwbh`
- Decision: [ADR 0130](../../adr/0130-operator-controlled-capability-composition.md)
- Harness: `apps/pages/scripts/verify-mutations.mjs` (`pnpm --filter @opensesame/pages verify:mutations`)
- Corpus: `apps/pages/scripts/lib/mutations.mjs`

This covers **S23-E** — "introduce representative forbidden import,
permissive default, origin-wide cache cleanup, stale lease, and mixed-chunk
mutations; require the verification system to fail for each". The rest of
S23 is named at the bottom as not attempted, because a partial red team
reported as a whole one is worse than none.

## Why a mutation harness

Every gate in this delivery is an assertion that some contract holds. None
of them is evidence that the gate would notice if it stopped holding. A
suite that passes on correct code and also passes on broken code is not a
gate; it is a test that happens to agree. The harness breaks one contract at
a time in the source, runs the gate that claims to hold it, and requires
that gate to notice — so the verification system is itself verified.

Each mutation is applied to the working tree and taken back with
`git checkout --`. The harness refuses to start unless every file it will
touch is clean, restores on any exit path including a signal, and refuses a
mutation whose anchor does not appear in its file exactly once — so a
refactor that moves the code fails loudly instead of quietly skipping.

## Result: 6 of 6 caught

| Mutation | Contract broken | Gate | Observed |
|---|---|---|---|
| `permissive-default` | An optional capability the instance does not permit is never approved (P-AUTHORITY) | `@opensesame/capability-composition` suite | exited 1 |
| `scope-widening` | A vault-session restriction may only narrow (P-SCOPING) | same | exited 1 |
| `consent-replay` | A receipt written for another instance or installation covers nothing here (CONSENT) | same | exited 1 |
| `origin-wide-cache-cleanup` | Cleanup deletes only caches this application, scope, release and variant own (PWA) | `@opensesame/pages` `src/sw` | exited 1 |
| `stale-lease` | A module whose lease went stale during its own import is disposed, not activated (LOAD, P-NOLOAD) | `@opensesame/pages` `src/lib/capabilities` | exited 1 |
| `forbidden-import` | The core entry does not statically reach an optional capability's module (P-NOLOAD) | pages build reachability report | names `src/bootstrap/boot.ts` |

`scope-widening` is the one mutation with a history: the contract it breaks
was **not** held when it was written. `VaultCapabilitySelection` carries
`instanceId`, `installationId` and `vaultId`, and `buildContext` read none of
them, so a record lifted from one tomb narrowed whichever session happened
to be open. VAULT-04 found it, `resolve-axes.ts` binds the three fields now,
and this mutation is what keeps them bound.

## `forbidden-import` is checked differently, and why

The reachability gate reports 354 violations on the ordinary selective
build. That is by design — [ADR 0130 §6](../../adr/0130-operator-controlled-capability-composition.md)
says a selective build may carry every first-party module and the device
loads only its accepted graph — and it is also the honest measure of work
this delivery has not finished. Either way its *exit code* proves nothing
today: it is already non-zero, so a mutation cannot make it "go red".

What the gate can still prove is that its detector sees the new edge. The
harness therefore requires the build's report to **name the file it
injected the import into** — a check that is unaffected by the 354 and that
becomes a plain exit-code check the moment that number reaches zero. The
`names` mode in the harness exists for exactly this, and for nothing else.

The same applies to the `mixed-chunk` mutation in S23-E's list: the
`MIXED_CAPABILITY_CHUNK` invariant is among the 354 already reported, so a
mutation there is indistinguishable from the baseline. It is left out rather
than written as a check that would pass whatever the code did.
`consent-replay` stands in its place — a different contract, but one whose
gate is green today and therefore one a mutation can actually move.

## Not attempted

Named so nobody reads this page as a completed red team:

- **S23-A** — defeating exclusion through shared chunks, barrels, eager
  globs, CSS, WASM, public assets, secondary HTML, source maps, preloads,
  tutorial catalogs and worker variants. The chunk-cycle defect in `38865cf`
  was found this way by accident, not by a systematic pass.
- **S23-B** — physically removing every excluded implementation asset from a
  family selective copy and re-walking the local journeys.
- **S23-C** — policy precedence, signature substitution, same-origin scope
  confusion, stale tabs, consent replay through the UI, prototype and alias
  abuse, deep links, callbacks and agent entry points. `consent-replay`
  above is the resolver-level case only.
- **S23-D** — zero side effects before selection commit, and telling an
  already-started import race apart from a new unauthorized load.
- **S23-F** — this file is the publication, but it reports one sub-task.
