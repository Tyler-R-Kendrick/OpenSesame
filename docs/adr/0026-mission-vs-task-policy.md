# ADR 0026 — Mission policy vs task policy

## Status
Accepted

## Context
AAuth missions and OpenSesame task templates both express governance intent but at different granularities and lifetimes.

## Decision
**Mission policy** (experimental AAuth) compiles to a governance context digest and may inform ceiling inputs. **Task policy** (template + ratchet rules) governs runtime capability state on a specific `TaskRun`. Mission bytes do not mutate an active task ceiling; task policy wins at enforcement time.

## Consequences
Mission changes affect future task activations only. Active runs use frozen ceiling and task template ratchet rules. AAuth adapter maps mission digest into ceiling compilation, not live mutation.
