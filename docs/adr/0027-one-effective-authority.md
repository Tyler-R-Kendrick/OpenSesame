# ADR 0027 — One effective authority per task run

## Status
Accepted

## Context
Multi-principal scenarios (shared automation, delegated approval) must not ambiguously attribute authority mid-run.

## Decision
Each active `TaskRun` binds to one `AuthorityContext` at activation (`authority_context_id` locked). `AuthorityContextMode::SinglePrincipal` requires exactly one principal; `ConservativeCommonGrant` intersects grants across principals but still yields one context id. Switching context after activation is `AuthorityContextLocked`.

## Consequences
`start_task` calls `assert_single_effective_principal` for single-principal mode. Audit records one effective context per run. Broker rejects context swaps without new task activation.
