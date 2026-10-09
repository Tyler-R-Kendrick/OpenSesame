# REDTEAM security-review draft (exclusive)

> Status (2026-10-08): a draft kept for reference.
> `docs/evidence/2026-09-21-duress/security-review.md` is the review of record,
> and its finding log lists RT-BACKUP-001, RT-CANARY-001, RT-CANARY-002 and
> RT-AUTH-001 as closed, so "Open findings" below is out of date. There is no
> `attack-trees.ts` in this directory: the attack trees are in
> `packages/contracts/src/duress/attack-trees.ts`. The defenses listed
> under "Held defenses" are tested under `packages/app-core/src/lib/duress/` (its
> `redteam/` folder and the module folders beside it); this directory holds
> `attack-trees.test.ts`, `compiler-fuzz.test.ts` and `gaps.honest.test.ts`.

Mirror / expansion of findings contributed to `docs/evidence/2026-09-21-duress/security-review.md`.

## Attack trees
See `attack-trees.ts`.

## Open findings
See REDTEAM finding log IDs RT-BACKUP-001, RT-CANARY-001, RT-CANARY-002, RT-AUTH-001.

## Held defenses (executable)
- AccessContext brand / forge rejection
- PRF⊕code two-input
- UV+code gating at selectTrigger
- Peer nonce replay / audience / alg none
- Alert authority transitions
- Share MAC + stale policy
- Fence monotonicity + compartment intersect
- Import enabled ≠ armed; alternate unlock / independent keys compiler rejects
