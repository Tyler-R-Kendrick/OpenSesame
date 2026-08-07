# ADR 0003: Availability classes A0–A3

## Status
Accepted

## Decision
Encode operation classes:
- A0_LOCAL: client-local E2EE
- A1_PREAUTHORIZED: explicit offline grant only
- A2_AUTHORITY_REQUIRED: grants/claims/rotations/issuance — fail closed without quorum
- A3_EXTERNAL_SIDE_EFFECT: provider side effects — online authz + idempotency + receipt

## Consequences
Gateway readiness and broker enforce class checks. Docs must not claim impossible HA.
