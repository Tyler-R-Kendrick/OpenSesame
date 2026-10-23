# Assume privilege

Competitive contract for [Infisical assume privileges](https://infisical.com/docs/documentation/platform/access-controls/assume-privilege).

Status: target design. This checkout has no assumption mode, no per-identity
ownership field on local directory records, and no effective-permission
override. This document defines the safe shape before any code is written.

## Infisical behavior

- An authorized user temporarily inherits a target user or machine identity's
  **permissions**, not the identity itself.
- The session is limited to one hour and one project.
- Only users with the specific **assume privilege** permission may use it.
- The action is confirmed by typing `assume`.
- A yellow banner marks the active session; **Exit** ends it.
- Actions are audited under the **original user**, not the target.
- The feature is for testing and verifying permissions before granting them,
  and for troubleshooting without asking the target to reproduce a problem.

## Current OpenSesame gap

| Piece | State |
|---|---|
| Local directory identities | People, agents, applications, organizations; no `createdBy` or `owner` |
| Local Access roles | `operator`, `member`, `guest`; no per-resource effective-role override |
| Host organization roles | owner, admin, member; project membership |
| Assume permission | Missing |
| Assumption record | Missing |
| Effective permission resolution | No assumption path |
| Audit as actor | Existing audit model can carry `actor` plus target metadata |
| Banner/exit UI | Missing |
| Native CLI | Missing |

The local vault is not a multi-tenant project store. The first implementation
therefore needs a scope unit: a local vault (PWA) or a Host project (native and
hosted). Do not pretend a local agent has project permissions that do not exist.

## Target model

```text
Assumption
  id
  actorPrincipalId
  targetPrincipalId
  scope: { kind: "vault"; vaultId } | { kind: "project"; organizationId; projectId }
  targetRole
  startedAt
  expiresAt            # startedAt + min(1h, target grant remaining)
  endedAt              # exit, expiry, revoke
  reason
  auditActorPrincipalId  # always the actor
```

Rules:

- **Permission-based, not identity-based.** The actor keeps its own identity,
  sessions, credentials and audit actor. Only the effective role/permission set
  inside the scope is replaced.
- **Owned targets only.** A target must be owned by the actor:
  - local agent/application: `ownerPrincipalId === actor`;
  - hosted machine identity: the actor owns or created the identity and holds
    the assume permission.
- **No widening.** The target's effective permissions must be a subset of the
  actor's assignable permissions. An actor cannot assume a role it could not
  grant. Owner cannot assume a higher owner role unless it already holds owner.
- **One scope.** A vault or project, never the whole organization and never two
  at once.
- **One hour maximum.** Expiry is `min(now + 1h, target grant expiry)`; there is
  no refresh. Exit is immediate and idempotent.
- **No chaining.** An active assumption cannot start another assumption.
- **No credentials.** Assumption never reveals a vault item, connection secret,
  client secret or API token. It only affects authorization decisions.
- **Fail closed.** If the actor or target is disabled, ownership changes, the
  target role drops below the assumed role, or the vault/project is locked or
  deleted, the assumption ends before the next decision.
- **Audit.** Every write is attributed to the actor and carries
  `assumedTargetPrincipalId` and `assumptionId`. A reviewer can never mistake an
  action for the target's own.

## Permission

Add `assume_privilege` as an explicit capability:

- Local Access: owner/operator only by default; can be granted to a member.
- Host organization: owner/admin only by default; a custom role may grant it.
- The target's own role must not be able to grant `assume_privilege` unless the
  actor can.

## UX

### Entry

- On an owned agent/application row, an **Assume privilege** key appears only
  when the actor holds `assume_privilege` and the target is owned.
- A sheet names the target, scope, role, and exact expiry.
- The confirmation word is `assume`; the key stays disabled until it matches.
- The sheet says plainly: "Your identity and audit trail stay yours. You are
  testing the target's permissions, not becoming the target."

### Active session

- A persistent warning banner shows target, scope, role, and remaining time.
- **Exit** ends it immediately. Closing the tab ends it; expiry ends it.
- No "extend" key. Starting again creates a new audited assumption.
- A write that is denied still shows the target role and the reason.

### Audit

- Start, exit and expiry each produce an event.
- Events name the actor, target, scope, role and assumption id.
- No secret, token or item value is logged.

## Native and PWA

- **PWA local vault**: an assumption changes the local Access role and share
  resolution inside that vault only. It never changes the vault key, session
  proof, or credential visibility.
- **Host project**: an assumption changes the effective project role used by
  Host authorization checks for that project only. It never mints a new
  principal, token or connection authority.
- **Native CLI**: `opensesame access assume --target <id> --scope <vault|project>`
  and `opensesame access exit`. The CLI uses the same assumption record and
  expiry; it does not hold a second privilege model.
- **SCIM/IdP**: assumption is never provisioned or synchronized. It is an
  interactive operator action only.

## Outperformance

- Assumption never issues a bearer token that can be copied; it is a scoped
  decision record tied to the actor's live session.
- No refresh, no silent extension, and no assumption beyond the target grant's
  own expiry.
- The audit actor is always the real person; a target can never be blamed for
  an assumption action.
- Effective permissions are intersected with the actor's assignable ceiling, so
  assume cannot become an escalation path.
- Owned-target enforcement is explicit; there is no "assume any identity" mode.
- Assumption is disabled under a duress fence and for disabled or orphaned
  identities.

## Delivery slices

1. **Ownership and permission.** Add `ownerPrincipalId` to local agents and
   applications; add `assume_privilege` to the Access capability model.
2. **Assumption record and clock.** Persist actor/target/scope/role/expiry;
   end on expiry, exit, disable, ownership change, vault lock or project delete.
3. **Effective role resolution.** Local vault first: resolve share visibility
   and Access capability from the assumption only within that vault.
4. **PWA UI.** Owned row key, confirmation sheet, active banner, exit.
5. **Host project.** Project-scoped effective role in authorization checks; no
   new principal or token.
6. **Native CLI.** Same record and expiry.
7. **Audit and adversarial tests.** Actor attribution, no chaining, no
   widening, no credential reveal, expiry, revocation.

## Acceptance

- A user without `assume_privilege` cannot see or call the action.
- A user cannot assume an agent/app it does not own.
- A member cannot assume owner; an owner cannot assume a role with permissions
  the owner could not grant.
- The session expires at one hour or the target grant expiry, whichever is
  sooner; there is no refresh.
- Exit, vault lock, identity disable, ownership change and project deletion end
  the assumption before the next authorization decision.
- Every action during the session is audited under the actor with the target and
  assumption id; the target receives no audit attribution.
- No item value, connection secret, token or client secret becomes visible
  because of an assumption.
- A second assumption cannot start while one is active.
- A denied operation reports the target role, not a generic failure.
