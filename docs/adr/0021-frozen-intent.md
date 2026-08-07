# ADR 0021 — Frozen intent (V2)

## Status
Accepted

## Context
Legacy [`Intent`] (V1) lacks task binding and is insufficient for task-secured invocations. Callers need a digest-stable artifact tied to task state.

## Decision
Introduce `FrozenIntentV2` with domain-separated digest (`OpenSesame/FrozenIntent/v2\0` || canonical bytes), binding to `task_run_id`, `task_state_version`, and `task_state_digest`. V1 intents remain for compatibility with explicit `LegacyIntentCompatibility` notes; migration is opt-in via `FrozenIntentV2::from_legacy`.

## Consequences
Broker signs and verifies intent digests against live task state. Mismatch or stale state version fails closed. Gateway rejects V1 for task-secured profiles without migration.
