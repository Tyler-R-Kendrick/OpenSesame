# ADR 0028 — Enforcement fencing during ratchet

## Status
Accepted

## Context
Capability shrink must be observed by credential-agent and result buffers before irreversible side effects complete.

## Decision
Ratchet transitions requiring mediation enter fencing: `MediationKind::RequestFence` blocks in-flight downstream requests; `ResultBuffer` holds protected payloads until all required acks arrive. Commit applies new capabilities atomically with buffer release.

## Consequences
Credential-agent implements request fence mediation. Gateway honors held buffers via `release_result_buffer` only after commit. Incomplete ack sets block transition commit (`MediationAckIncomplete`).
