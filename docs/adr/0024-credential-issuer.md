# ADR 0024 — Task credential issuer

## Status
Accepted

## Context
Task runs need time-bounded credentials without persisting raw secrets in the task store.

## Decision
The credential-agent issues task-scoped credentials; `TaskCredentialRecord` stores digest, state version, and expiry only. Renewal is bounded by `maximum_expires_at` and current task state version. Raw token material never enters `TaskStore`.

## Consequences
`renew_credential` validates ceiling immutability and expiry ceiling. Downstream RPs introspect or validate via configured profile. Revocation aligns with task completion or mediated restriction.
