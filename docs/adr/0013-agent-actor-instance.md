# ADR 0013 — Agent principal / actor / instance separation

## Status
Accepted

## Decision
Human `Principal`, agent `Actor`, concrete `AgentInstance` (proof key), and OAuth `Client` are distinct dimensions. Claiming an agent creates ownership/delegation; it never converts the agent into the human principal.

## Consequences
Audit events record principal, actor, and instance separately. Pre-claim credentials are revoked on claim completion.
