# ADR 0178 — Authorization checks are proofs the compiler can see

Status: Accepted
Date: 2026-10-06
Supplements: ADR 0086 ([wallet-native interaction layer](0086-wallet-native-interaction-layer.md), §7), ADR 0093 ([structural quality gates](0093-structural-quality-gates.md))

## Context

The Identity API and the client core check who may do a thing, and then do it,
in two statements that nothing connects:

```ts
const gate = await requireOwner(c);          // checks organization A
if (gate instanceof Response) return gate;
await putGroupRoleMapping(ctx, orgId, ...);  // takes any string
```

That shape has failed here before, and it drifts when copied.

- `requireOwner` existed four times (`org-domains`, `org-ldap`, `scim`,
  `scim-mapping-admin`) and the copies disagreed about what a live organization
  is: `!== "deleted"`, `=== "active"`, and no state check at all.
- "The principal's assurance is not `provisional`" was written five times with
  five messages, and the operation it guards (`AppClaimService.startClaim`,
  which transfers ownership of an OAuth client) took a raw
  `ownerPrincipalId: string` in a different file from the check.
- `routes/push-subscriptions.ts` records the same gap in a comment: reading the
  owner and then disabling "left a gap", and fixed it for one repository by
  putting the owner in the write.
- `os-domain/src/interaction-proof.ts` records the worst version. The approve
  route once took a whole `ApprovalProof` from the request body, and the
  repository's own test helper wrote `phishing_resistant` into storage having
  touched no key, with every test green. `sealApprovalProof` was documented as
  "the only way to make an `ApprovalProof`" while the type was a plain
  interface anyone could write a literal for.
- `bypassAccessCheck: true` on the app-core share writes made "this caller is
  system code" a boolean any caller could pass.

Each is boolean blindness: the result of a check is not a value the operation
depends on.

## Decision

**A function that needs a fact to be true takes a proof of it, about the exact
values it touches, from [`@gdp-ts/core`](https://github.com/rauchg/gdp-ts)
(Ghosts of Departed Proofs, pinned `0.1.0`).** The library is about 100 lines.
`name(value, k)` gives a runtime value a compile-time-only name that exists only
inside the callback; `defineProof("Kind")` returns a prover only a `proofs/`
module may hold; a sensitive function takes `Named<P, ProjectId>` and
`_proof: ProjectAdmin<A, P>`. A proof about another value, a raw string, or no
proof does not compile. At runtime a proof is a frozen `{ kind }` object.

1. **One trusted module per fact, under `proofs/`.** It defines the prover,
   never exports it, exports the proof interface and the checking function. The
   checking function returns a **verdict** (`{ ok: true, proof, … } | { ok:
   false, … }`), never a `Response`, so each route keeps its own status and
   message and the wire does not change (an id the caller cannot see is 404,
   never 403).
2. **Branded ids** (`packages/control-plane/src/lib/ids.ts`): a person and an
   organization are different types before any proof is asked for. This file is
   the only place a brand is asserted, each with a `SAFETY:` comment.
3. **A guarded layer demands the proofs** (`services/org-admin.ts`,
   `project-admin.ts`, `verified-admin.ts`, `webhook-admin.ts`): the write that
   needs the authority takes the proof plus the named id, and asserts the row's
   own id matches the name. Reads, audit rows and parsing stay in the route.
4. **Handlers run under a gate** (`routes/org-owner-gate.ts`,
   `project-role-gate.ts`, `verified-principal-gate.ts`): the gate calls
   `name()`, mints the proof and hands the handler a callback generic in the
   names, so a handler cannot return or store one. Where a per-resource lock
   exists it stays outermost and the proof is minted inside it.
5. **Preserve behavior; record drift.** Where call sites disagree, each
   behavior becomes an explicit named option on the proof (`OrgLiveness`:
   `not_deleted`, `active`, `unchecked`) and a test pins it. Nothing is unified
   silently.
6. **Every proof has a `*.mistakes.ts`**: a file nothing runs, of
   `@ts-expect-error` lines for the ways to skip or misuse it. `tsc` fails if one
   starts compiling, so weakening `Named`, a proof or a guarded function shows
   up before it reaches a route. Each was shown to be load-bearing by removing
   one directive and watching `tsc` fail.
7. **Tests get proofs from the real prover** (`org-owner-fixture.ts`,
   `verified-principal-fixture.ts`, `project-role-fixture.ts`) against real
   memberships, never from a cast.
8. **The lint closes what the type checker cannot.** `@gdp-ts/core/lint/oxlint`
   runs beside anti-slop in `oxlint.config.ts`, non-strict: `no-define-proof`
   (only `proofs/` may mint), `no-exported-prover`, `no-proof-assertion` (no
   `as SomeProof`). Strict mode (ban every `as`/`any`) is not enabled;
   anti-slop already requires a `SAFETY:` justification for every assertion. The
   preset's peer range says Oxlint `>=1.86`; it loads and fires on the pinned
   `1.79.0`, which is what the repo gates on.

## Where it is applied

| Fact | Proof | Demanded by |
|---|---|---|
| Actor owns a live organization | `OrgOwner<A, O>` | domain claim/verify/release, LDAP put/remove/sync, SCIM token mint/revoke, group-role mapping (can map a group to `owner`), organization update, member add/change/remove |
| Actor has a project role on a visible project | `ProjectMember` / `ProjectAdmin` / `ProjectOwner` | project update/delete, member grant/revoke/leave, owner grant/revoke |
| Actor is a stored, non-provisional principal | `VerifiedPrincipal<A>` | OAuth client create/patch/rotate/revoke, `AppClaimService.startClaim`/`verifyAndClaim`, authentication-application create, organization create |
| Actor owns a webhook endpoint | `OwnsWebhook<A, W>` | webhook delete (the repository's `deleteById` takes a bare id) |
| An approval was sealed by the server | `SealedApprovalProof` (os-domain, branded) | `interactionMachine.approve`; the app-core literal that fabricated one now goes through `sealApprovalProof` |
| Caller may write shares in this vault | `ManageGrants<T>` or `SystemShareWrite<T>` (app-core) | share create/revoke; replaces `bypassAccessCheck` with a typed, greppable choice |
| An item is reachable for read or write | `ItemReadReach` / `ItemWriteReach` (app-core) | WebMCP vault tools reading, revealing, TOTP and writing an item |

## Drift found and kept, for the owners to decide

These are existing behaviors the refactor made visible. None was changed.

- **Three readings of a live organization.** Domains, LDAP and organization
  update accept any state but `deleted` (so `provisional` and `suspended`
  pass); SCIM's first-party directory and tokens require `active`; the
  organization member routes and SCIM role mappings check no state, so an owner
  of a deleted organization can still list and edit members. The `unchecked`
  option records the last without endorsing it.
- **`PATCH /v1/projects/:id` takes no per-project lock** while `DELETE` does, so
  a stale `{...project}` write can race a delete and resurrect the project.
- **`POST /v1/projects/:id/members` adds a principal without checking they
  belong to `project.organizationId`.** Nothing, including the reconcile
  planner, enforces it for organization-scoped projects.
- **`agents.ts` registration checks a project role but not visibility**, so a
  member of an expired project can still register an agent there.
- **The SCIM role-mapping `PUT` writes no audit event.**
- **Personal-project rules differ per route** (`409
  personal_project_not_shareable` on add, `personal_project_immutable` on
  remove, nothing on role change).

## Not applied, and why

- **The Rust host plane.** gdp-ts is TypeScript-specific. The Host already uses
  the same idea natively: non-deserializable capability types such as
  `VerifiedPeer` (ADR 0132).
- **`apps/pages/server/*.mjs`**: plain JavaScript, one gate per route.
- **Operator-token admin routes**: gated once by middleware; no per-handler fact
  is left to prove.
- **Already proof-shaped**: the `with*Session` brackets, the vault store's
  `#requireUnlocked()`, and loaders that return the row or `null`
  (`loadForApprover`, `managedApplication`, `loadOwnedClient`).
- **Not converted this round, ranked by value for a follow-up:**
  1. A WebAuthn assertion bound to a transaction digest. Four hand-rolled copies
     (`authorization-requests`, `interaction-activation`, `mfa-step-up`,
     `host-authorization`) and two `PasskeySeam`s of one type, one of which
     accepts any non-empty signature under `allowDevDefaults`. This is the
     highest-value remaining site and is security-critical, so it needs its own
     change.
  2. `recordSettlement` demands a `CeremonyAllowed` proof; the evaluator's
     verdict is currently tested inline and discarded, with `requestDigestMatches:
     true` hard-coded at two call sites.
  3. `activationAuthenticationFacts(at: Date)` reports `phishingResistant: true`
     for any date; it should take the proof from (1).
  4. Host-authorization mint, factor-removal step-up, notification-channel
     binding ownership and freshness, quota verdicts, upstream-identity linking.
  5. app-core directory writes (`DirectoryChangeAllowed`): twelve production
     callers of `commitLocalDirectoryUnderLock`, two kinds (person-gated and
     system-gated); tractable, but the check runs before the lock, so check
     order has to stay exactly as is.
  6. `reconcileProjectAuthorityMembership` keeps its signature: a brand-new
     project's creator has no membership yet, so no provable role.

## Limits

gdp-ts does not guarantee more than the type checker and the lint can see.

- **The stores stay reachable** (`ctx.stores`, `ctx.repos`). The guarded layer is
  the path routes take, not a seal. Making a repository itself demand the
  principal, as `push-subscriptions` does, is complementary and stronger where
  it fits; `webhookEndpoints.deleteById(id)` still takes a bare id.
- **Forging needs `as` or `any`**, which the lint flags in the proof types; a
  `no-restricted-imports` override that limits who may import
  `systemShareWrite` and `sealApprovalProof` is not in place.
  `ServerEstablishedApproval` is still a plain interface, so anyone can hand
  `sealApprovalProof` any facts.
- **A proof can go stale.** It says the check passed when it was made; a role
  revoked in between is not seen. Mint it inside the lock that serializes the
  mutation, as the gates do.
- **`findSavedItem` in `webmcp/tool-shared.ts` is exported and unguarded**; it
  reads back an item the write tool just saved.
- A proof about a `string` id is only as good as the check that minted it.

## Consequences

- A route that forgets the owner check, runs it against another organization, or
  passes a raw id does not compile. A handler that forgets the `403` for a
  member does not compile, because the verdict is discriminated on role.
- `requireOwner` ×4, the five assurance checks and the project-role blocks are
  gone; `projects.ts` shrinks from 748 to 657 lines and
  `authentication-service.ts` from 1144 to 1110, and their baselines tighten
  with them.
- Wrapping a handler in a gate callback lengthens it; a few handlers were split
  into named helpers to stay inside the ADR 0093 function budgets.
- `@gdp-ts/core` is a dependency of `os-domain`, `app-core` and
  `control-plane` (the packages that hold proofs), and a root dev dependency for
  the lint preset. It has no dependencies of its own. A package adds it when it
  gets its first proof, not before.
- New authorization work in the TypeScript plane follows the skill bundled with
  the library (`npx skills add rauchg/gdp-ts`) and the rules above.
