# ADR 0020 — Trust ratchet for task capabilities

## Status
Accepted

## Context
Agents should release unused authority as work completes, but downstream enforcers must observe the shrink before effects become irreversible.

## Decision
Capability reduction is a **ratchet**: monotonic shrink only, mediated by `CapabilityStateTransition` with required `EnforcementAcknowledgement`s before commit. Protected results buffer until acks complete. No widen operation exists in the domain model.

## Consequences
`TaskAccessEngine::propose_restriction` enters `Restricting`; `commit_transition` requires complete ack sets. Audit and credential-agent fences participate as mediation points.
