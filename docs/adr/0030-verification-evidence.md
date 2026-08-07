# ADR 0030 — Verification evidence for ratchet commits

## Status
Accepted

## Context
Mediation acks and proof validation must leave durable, digest-stable evidence linked to task runs and protocol profiles.

## Decision
Record `VerificationEvidence` with kind (DPoP validation, intent digest match, state version match, mediation ack, etc.), optional `task_run_id` and `protocol_profile_id`, and `subject_digest`. Evidence digests use canonical JSON + SHA-256. Transitions may reference evidence via `trigger_evidence_digest`.

## Consequences
Enforcement acks carry `evidence_id`. Ratchet audit trail is reconstructible from evidence records. External policy decisions are explicit evidence kind, not silent log lines.
