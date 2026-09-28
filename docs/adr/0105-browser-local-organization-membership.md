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
administrative UI does not impersonate a delegated member session.

The member's own view is separate and goes only through the session-enforced
operations. While a person's local passkey session is active, their Passkeys
disclosure lists the organizations `listLocalOrganizations` returns (name and
role); opening one reads its members through `readLocalOrganization`, which
now carries each member's name and kind from the same fenced read. Role and
removal keys appear only where `changeLocalOrganizationMembership` would
accept them (owner: every role on a person, removal of anyone; admin: removal
of ordinary members; member: none), and the library still decides on every
press. A refusal is a status mark. A committed edit advances the directory
revision, so ADR 0104's binding ends every local session, the editor's
included; the view revalidates, reports that the session ended and hands
focus to Sign in locally. An agent-key session sees its organizations
read-only. Adding a member who is not yet in the organization stays with the
custodian: a session read never lists unrelated identities to choose from. Resource
policies, application admission, agent credential proofs and browser
relying-party transport remain necessary for full IAM.

## Verification

`local-organizations.test.ts` exercises real passkey-backed owner/admin/member
sessions, organization isolation, privileged-role refusal, last-owner safety,
ownership transfer, agent restrictions and atomic membership removal.
`local-directory.test.ts` covers non-mutating legacy reads, write-time migration
and refusal to overwrite malformed membership records.
`verify:keyboard` covers owner assignment, role changes, member removal and
last-owner refusal through the rendered controls at desktop and mobile widths,
and walks the member view by keyboard alone: a real Chromium WebAuthn sign-in,
opening the organization, arming, keeping and confirming removal, and a role
change, both meeting the last-owner refusal as a mark.
`LocalMemberOrganizations.test.tsx` renders real passkey-backed owner, admin,
member and agent-key sessions: an owner's role change ending the session,
admin keys absent on owners and admins, confirmed removal, member and agent
read-only views, and unrelated organizations never listed.
