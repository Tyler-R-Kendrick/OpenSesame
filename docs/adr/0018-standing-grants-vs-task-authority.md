# ADR 0018 — Standing grants vs task authority

## Status
Accepted

## Context
OpenSesame already models durable [`Grant`] records for standing delegation. Task-scoped authority introduces a separate lifecycle with ceilings, ratchets, and credentials bound to a [`TaskRun`].

## Decision
Standing grants **compile into** task ceilings at activation; they do not substitute for task authority during a run. Runtime authorization checks task `current_capabilities` and frozen intent bindings, not grant rows directly. Grants may widen what a ceiling *could* include at compile time but never bypass an active task run.

## Consequences
Broker compiles `CeilingInput` from grants; gateway/task-access engine enforces task state. Revoking a grant affects future tasks, not in-flight runs unless mediated restriction removes derived capabilities.
