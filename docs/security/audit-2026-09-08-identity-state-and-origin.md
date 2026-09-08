# Identity state and application-origin hardening

Scope: Identity configuration, security-state composition, passkeys, and public
authentication. Baseline: `457a9b4cb9f1c9db264fb1fbabb01bf466040bc4`.

## Enforced changes

Deployment mode is an exact lowercase enum. Conflicting or absent modes fail
unless the explicit `OPENSESAME_ALLOW_DEV_DEFAULTS=1` local-only opt-in applies.
Network exposure enforces production safeguards regardless of the mode label.
Self-hosted CORS and upstream trust default to empty sets; Pages' compiled
browser provider is a separate product decision and is unchanged.

Production refuses missing database configuration, short claim peppers, and
injected test stores. Startup runs migrations and a database write/read/delete
transaction before serving. Readiness repeats the transaction and fails closed
after database failure; liveness remains minimal and independent.

Public authentication uses application IDs in the path, so preflight resolves an
active application's exact origin before admitting a request. Cookies, wildcard
origins, and Private Network Access are not enabled on this surface. Body/path
application mismatch fails. Legacy body-only routes return a deprecation refusal
without CORS; the browser SDK uses the new paths.

## Durable-store composition

| State | Enforcement |
| --- | --- |
| Principals, links, AgentAuth, notifications and approval activations | Existing PostgresRepositories retained |
| OIDC codes, refresh/session state, pairwise subjects | Existing Postgres OIDC and pairwise adapters retained |
| Client registration, origin ownership, consent | Existing Postgres stores retained |
| Organizations, projects, memberships, SCIM, SAML and federation | Existing Postgres stores retained |
| Public authentication applications, users, credentials, challenges, tokens | Existing Postgres authentication stores retained |
| Better Auth session/account/verification state | Same configured Drizzle database |
| Provisional sessions and token indexes | New namespaced durable records; token index keys are digests |
| Principal mappings | Permanent namespaced records, unique provider indexes, serialized mutations |
| ClaimEngine sessions/items | Existing claim tables and version compare-and-swap |
| Passkey credentials/challenges | Permanent credential records, single-use challenge deletion, serialized counter advancement |
| TOTP secrets, MFA codes and failed-attempt fences | Durable records, atomic code consumption and counter increments |
| Back-channel logout replay | Existing callback replay table, atomically claimed before effects |

Namespaced auxiliary records use existing `oidc_payloads`, never an actual OIDC
model name. Their server-authored serialization preserves dates and byte arrays;
record sizes, namespace capacity, and enumeration are bounded. Namespace writes
serialize capacity checks across replicas and reclaim expired rows before a
claim, so expired replay keys can be reused. Digest-entry deletion is a separate
server-only method; ordinary token deletion never interprets a special prefix.
No schema migration is introduced.
Passkey enrollment ownership and advancing-counter controls from PR #378 remain
enforced. PR #375's provider assertion trust additions are not silently imported
or replaced by a competing assertion/replay schema.

## Regression evidence and limits

The shared deployment truth table is exercised by TypeScript tests. Real OPTIONS
tests cover exact/wrong/inactive applications and origins, credential absence,
PNA absence, and application mismatch. The two-application PGlite test verifies
session acceptance and revocation, durable callback replay claims, single-winner
passkey counters, credential ownership, and readiness failure after database
damage. Dedicated tests cover claim CAS and durable-map expiry/consumption.

The complete Identity suite has 921 tests across 77 test files; auth-upstream
has 89 tests and sdk-browser has 96. These are local test evidence, not a
production deployment exercise or a model-backed scanner result.

Rate-limit caches, request idempotency caches, and process-local mutation mutexes
are not claimed to be distributed transactions. The new replica tests do not
independently reproduce every pre-existing Postgres store's lifecycle. Database
operators must protect credentials, backups, and database availability. Losing a
database fails readiness; restoring old database state can restore old replay
state and must follow the deployment's recovery policy.
