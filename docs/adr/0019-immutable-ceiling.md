# ADR 0019 — Immutable capability ceiling

## Status
Accepted

## Context
Task runs must not silently gain authority after human or policy approval. Widening mid-run would defeat audit and intent binding.

## Decision
`capability_ceiling` and its `ceiling_digest` are fixed at task activation. The task-access engine persists the digest and rejects any mutation (`CeilingImmutable`). Current capabilities may only shrink via ratchet transitions; they may never exceed the ceiling.

## Consequences
Ceiling compilation happens once in `start_task`. Restriction proposals validate against the stored ceiling. Credential renewal and proof signing inherit the frozen ceiling digest.
