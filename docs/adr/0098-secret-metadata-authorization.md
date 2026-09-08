# ADR 0098: Durable Host ceilings for project secret metadata

Status: accepted

## Context

Secret names and configuration topology can be collaborative without being
organization-wide public metadata. A generic member denial would strand valid
collaboration; trusting a cached session role would make revocation stale.

## Decision

Migration 0032 adds explicit durable organization role ceilings and independent
project metadata/key-name permissions. A native operator provisions an initial
ceiling or changes it using the current revision. Revoked roles remain
tombstoned with their revision and evidence-time fence. Revocation removes
project grants; re-enrollment does not restore them automatically.

Current Host owner/admin ceilings permit organization configuration management.
A session's role can narrow, never expand, the stored ceiling. Verified Identity
evidence may only narrow an existing ceiling and must postdate the stored
authentication-time fence. Reads never populate role policy from a session.

A member needs project `config.metadata.read` to see configuration names and
environments. Key names and version/comparison/changelog metadata additionally
require `config.keys.read`. Key permission requires metadata permission.
Neither grants mutation or value read. Only a current authorized owner/admin
or native operator can set those project permissions.

Native operator calls explicitly select a canonical organization. There is no
default organization shortcut. Resource checks are shared by list/detail,
parent configuration, both comparison operands and changelog aliases.
Unauthorized and nonexistent resources use the same not-found shape. Actual
requests read current durable policy; UI capability hints grant no authority.

Pages fetches server-reported permissions before names and does not request
key/version metadata without the separate grant. Permission refresh clears
prior metadata and fences stale asynchronous responses. No route reveals
secret values; audit records use stable IDs and revisions rather than names.

## Migration and recovery

Existing configurations remain unchanged. Empty policy tables do not inherit
cached roles: native provisioning must establish approved owner/admin access.
See [the operator procedure](../operators/config-authorization.md) for revision
updates, explicit project grants and revocation. Back up the database before
migration. An older binary without this authorization boundary is not a safe
online rollback; restore a complete compatible backup with services stopped.

## Evidence and limits

Broker and route tests cover member metadata without keys, role narrowing,
revocation, stale evidence, tenant/project separation and concurrent revision
updates. UI tests cover permission-specific affordances. Final integrated test
results are separate release evidence, not implied by this ADR.

Authorization is checked when an operation is admitted. This does not promise
to cancel a mutation already authorized and in flight when revocation commits.
Previously disclosed metadata cannot be recalled from a client. These limits
do not permit stale cached authority to admit a later request.
