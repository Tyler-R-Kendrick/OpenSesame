# ADR 0105: Browser-local organization membership

Status: Accepted for local persistence, session-enforced operations and vault-custodian membership controls.

## Decision

Use the domain's existing `owner | admin | member` roles. Memberships and
identities share one encrypted directory record and one cross-tab mutation
fence. Version-one directories are read as version two with no memberships;
reading does not rewrite storage. The next successful edit writes version two
while preserving identities and advancing the revision. Old readers reject the
new version instead of silently dropping memberships during an edit.

An organization has no delegated authority before its vault custodian assigns
the first human owner. Once configured, it must retain an enabled human owner.
Removing, disabling, deleting or demoting its last owner is refused. Ownership
must be transferred first. Deleting the organization deletes its memberships in
the same record. Agents can be members, never owners or administrators.

Session-enforced reads expose only active organizations the authenticated local
person belongs to. Unknown and unrelated organizations share the same refusal.
Owners can manage roles; administrators can add or remove ordinary members but
cannot appoint privileged peers or modify owners/admins. Members cannot mutate
memberships. All role checks read current state inside the session fence and
commit through the directory's fenced primitive without reacquiring the lock.

The directory is bounded by 1,000 identities, 5,000 memberships and 512 KB of
serialized plaintext, whichever limit is reached first. Validation happens
before writing. Duplicate, dangling, invalid-role and ownerless configured
memberships fail closed; corrupt authority data is never replaced with an empty
directory. Membership edits invalidate existing local sessions through ADR
0104's directory revision binding, requiring another passkey sign-in.

## Trust and remaining work

The unlocked vault custodian remains the local administrative trust root, not
an automatically authenticated organization member. Session-facing operations
do not accept that root authority by omission. The internal commit primitive
requires its caller to hold the directory/session fence; it is not an RPC or
agent surface. These roles grant no connector invocation, secret-value access,
application token or external Host authority.

Organization rows expose a native Members disclosure for the vault custodian:
assign the first owner, add members, update roles and confirm removal. This
administrative UI does not impersonate a delegated member session. Resource
policies, application admission, agent credential proofs and browser
relying-party transport remain necessary for full IAM.

## Verification

`local-organizations.test.ts` exercises real passkey-backed owner/admin/member
sessions, organization isolation, privileged-role refusal, last-owner safety,
ownership transfer, agent restrictions and atomic membership removal.
`local-directory.test.ts` covers non-mutating legacy reads, write-time migration
and refusal to overwrite malformed membership records.
`verify:keyboard` covers owner assignment, role changes, member removal and
last-owner refusal through the rendered controls at desktop and mobile widths.
