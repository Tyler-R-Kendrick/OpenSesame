# Browser-local policy administration — 2026-09-10

Scope: Access → Policies in the current uncommitted Pages worktree.

The local application scope evaluator already enforced exact role admission,
but Access hid policy administration behind Host configuration. The tab now
mounts its local editor independently. It reuses Identity's registration editor,
encrypted storage, revision fence and deny-by-default scope policy. There is no
second policy store, authority hierarchy, or agent self-administration endpoint.
Optional Host policies retain their separate connection requirement.

Focused tests use real encrypted storage and verify keyboard role selection,
saved policy, unchanged denied roles, empty counts and locked-read refusal.
Same-named applications are distinguished by their stable public references;
an encrypted-store regression covers that distinction.
The real Chromium journey first establishes cross-origin application access,
opens a separately unlocked local Policies tab, removes an allowed role, saves,
reloads the policy, and verifies that the actual RP's next check is refused.
Both 1280px and 390px journeys pass alongside the existing person, agent and
custodian revocation journeys: eight browser flows in total.

`pnpm --filter @opensesame/pages test`: **3564 tests pass in 292 files**, 70.92s.
Pages build/typecheck, full-repository `pnpm lint:anti-slop`, scoped strict
anti-slop and Biome pass. Structural quality
required tightening AccessSection's max-lines baseline from 3688 to 3687; no
threshold was increased. `git diff --check` passes.

The independent Impeccable review requested stable application references and
measured introductory prose. Both were fixed together and recaptured at both
viewports; its verdict pass marked both resolved. This is a scoped UI verdict,
not a security certification. `pnpm lint:design` passes across 291 files.

This does not establish full IAM completion, bundle-budget clearance, complete
repository verification, external scanner execution, or release readiness.
