# ADR 0009: Claims separate from device authorization

## Status
Accepted

## Decision
Claim sessions (`ClaimSession` / `osc_clm_*`) attach or transfer ownership/delegation.
Device authorization (RFC 8628) grants a client session after user approval.
They share UX patterns and polling ergonomics but **never** share tables, token purposes, audiences, or completion semantics.

## Consequences
`packages/claims` and `packages/device-auth` are distinct; console copy distinguishes “Authorize CLI” vs “Claim ownership”.
