# Identity agent registry and audit predecessor races

The legacy `/v1/agents` product-actor registry retained agents and instances in
process-local maps even when claims and the rest of Identity used PostgreSQL.
Restarting lost the actor referenced by a durable claim. A real migrated
database also rejected registration because its claim foreign keys reference
the existing relational `agents` and `agent_instances` tables.

The registry now uses those tables, without a parallel JSON representation or
schema migration. The separate AgentAuth registration tables remain unchanged.
Reads validate persisted ownership and state. Claim completion checks ownership
and changes provisional state under the registry transaction lock. Live quota
usage is counted in SQL; quota revalidation and the two registration inserts
share one advisory-locked transaction across replicas. A failed second insert
rolls back the first. Storage admission has a hard 10,000-record ceiling for each
registry table. A failed claim issuance releases its matching provisional
reservation; retained claim rows continue to enforce their foreign keys.

The concurrent HTTP regression exposed a second issue: Drizzle wraps PostgreSQL
unique-constraint failures in `cause`, and driver implementations name the
constraint field differently. The audit chain's previous conflict predicate
missed that wrapper and could return a server error after the winning operation.
The chain now recognizes only SQLSTATE `23505` for the exact predecessor
constraint through a bounded cause traversal. It reloads the durable tip and
relinks, for at most 32 attempts. Unrelated failures still propagate, and a
failed append never advances the local tip. Sustained contention can still
exhaust this bounded retry budget; that is an explicit error, never a forked or
silently dropped audit event.

Regression evidence is in `legacy-agent-durability.test.ts`: actual PGlite
migrations, two application instances, cross-instance claim completion,
duplicate-key transactional rollback, concurrent HTTP registration with exactly
one remaining quota slot, a third instance reading the resulting state, and
verification of the persisted audit hash chain. `replica-conflict.test.ts`
checks eight contending writers, wrapped-driver discrimination, cyclic causes,
and bounded contention failure. These are local tests, not a model-backed scan
or a production attack.
