# REDTEAM security-review draft (exclusive)

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
