# Host project-config authorization

Host authorization is an explicit, durable ceiling managed by the operator. It
is not a cache populated by whoever presents an Identity session. An owner or
admin session needs a matching current Host role before managing configurations
or project permissions. A lower Identity/session role narrows that authority.

The native operator selects a canonical organization with
`X-OpenSesame-Organization`. There is no implicit default organization on these
routes. Browser code never receives the operator credential.

## Provision and revoke

`GET /api/v1/organizations/{organization}/config-members/{principal}` reads a
native role policy and its revision. Native
`PUT /api/v1/organizations/{organization}/config-members/{principal}` takes
`{"role":"member","expected_revision":0}` to create an initial policy.
Roles are `owner`, `admin`, `member`, or `null` (revoked). Updating an existing
policy requires its exact revision; a stale update cannot overwrite a newer
decision. Revocation deletes that principal's project permissions. Re-enrolling
a revoked member does not silently restore them.

Provisioning is an explicit local/operator approval step. An old session cannot
create a role row on a read. Verified Identity evidence can only narrow an
existing role, and its authentication time must be newer than the stored fence.
An assertion predating a downgrade or revocation cannot undo it. Identity's
organization roles do not implicitly expand the Host's ceiling.

## Project capabilities

Current owners/admins may manage organization configurations. Members require
explicit project permissions. A current owner/admin or native operator calls
`PUT /api/v1/projects/{project}/config-access/{principal}` with:

```json
{"metadata_read":true,"keys_read":false}
```

The target must have active Host membership. `metadata_read` permits config
names, environments and identifiers in that project. `keys_read` additionally
permits key names, version metadata, comparisons and changelog entries; it
requires metadata permission. Neither permission grants mutation or value read.
Set both fields to false to remove project access. Unrelated projects remain
hidden. Host project grants are explicit resource policy, not inferred from
client-supplied project IDs or unrelated Identity membership.

`GET /api/v1/projects/{project}/config-access` returns the caller's effective
capability names for UI affordances. Every actual route repeats the durable
authorization check, including both sides of comparisons and changelog aliases.
The panel does not fetch key names without their separate capability. A refresh
removes controls when server policy changes; UI state never authorizes a request.

Unauthorized and nonexistent config resources return the same not-found shape.
Native grants/updates produce metadata-only audit events containing stable IDs
and policy revisions, not secret names or values. No endpoint returns a value.

## Migration

Migration 0032 creates empty policy tables. It does not trust existing cached
session roles. The native provisioning ceremony must seed the approved local
owner/administrator ceiling before config operations are enabled. Existing
configurations and ciphertext remain unchanged. Back up the database before
migration and restore the complete backup, with services stopped, if rolling
back to a binary without this policy boundary.
