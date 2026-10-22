# Group provisioning and GitHub team sync

Competitive contract for two related features:

- [Infisical GitHub team sync](https://infisical.com/docs/documentation/platform/github-org-sync)
  for user identities.
- [Proton Pass SCIM groups](https://proton.me/support/scim-groups) for groups
  that carry sharing access.

Status: target design. This checkout already has SCIM users and a narrow SCIM
Groups PATCH path; it does not yet have general groups, group shares, or GitHub
team sync.

## What exists today

| Piece | State | Where |
|---|---|---|
| SCIM 2.0 users | Create, list, filter by userName, get, PATCH, deactivate; provisioning tokens | `packages/control-plane/src/routes/scim.ts` |
| SCIM Groups | PATCH only, keyed by caller-supplied group id; add/remove members | `scim.ts`, `scim-groups.ts` |
| SCIM group role mapping | Separate explicit group → organization role mapping; no role from a name | `scim-groups.ts`, `scim-mapping-admin.ts` |
| SCIM group CRUD | Missing: no POST, GET list/by-id, DELETE, PUT, member replace | — |
| SCIM group approval | Missing | — |
| Group sharing | Missing: only the built-in **All users** group can be named by a local share | `packages/app-core/src/lib/local-groups.ts`, `local-share-grants.ts` |
| Local group records | Missing: `LocalGroup` is a single built-in record | `local-groups.ts` |
| GitHub OAuth scopes | `read:user user:email`; not `read:org` | `packages/control-plane/src/interactions/registry.ts` |
| GitHub App permissions | metadata, contents, administration, workflows, pull requests; no members/org read | `packages/app-core/src/lib/github-app-manifest.ts` |
| GitHub team sync | Missing | — |
| GitHub account link | Stored as an external identity `(kind: oauth2, issuer: https://github.com, subject: <GitHub user id>)` | `external_identities` |

The existing SCIM Groups path is therefore not Proton parity: an IdP cannot
create, list, read or delete a group, cannot replace its membership, and the
group cannot be granted a vault or item.

## Infisical GitHub team sync behavior

- Configure a GitHub organization on the SSO **Provisioning** page.
- Enable the sync; the GitHub OAuth application needs `read:org` and the
  organization must approve it.
- On GitHub login, the user's GitHub teams are read and mapped to Infisical
  groups by team.
- A manual **Sync Now** uses a classic token with `read:org` or a fine-grained
  token with organization **Members: Read**. It processes members who have
  already signed in with GitHub.
- Matching uses the GitHub account ID linked at sign-in. It never infers a
  person from a GitHub username or public profile email.
- If a person has not signed in with GitHub, manual sync stops and names them
  instead of guessing.
- Secret teams are visible only to owners and team members. A regular member's
  token skips them; skipped teams are left unchanged.

## Proton Pass SCIM group behavior

- The IdP creates groups and memberships; Proton creates the group and members
  on the next provisioning cycle.
- Group changes from the IdP are staged for admin approval before they take
  effect.
- Members must have signed in once before a group can be approved.
- SCIM groups cannot be edited or deleted in Proton; the IdP is authoritative.
- A group can be granted vault or item access, and every member inherits that
  access. Adding a member later grants the same access without re-sharing.

## Target model

One group record, used by SCIM, GitHub teams, manual groups and sharing.

```text
Group
  id, organizationId
  source: manual | scim | github
  externalId: string | null       # SCIM id or GitHub team id
  displayName
  purpose: string | null
  members: principalId[]
  state: pending | active | disabled
  revision: number
  digest: string                  # canonical name + members + source
  approvedBy, approvedAt
  createdAt, updatedAt

GroupShare
  id, groupId, resourceKind, resourceId, role, grantedBy, grantedAt
```

Rules:

- `(organizationId, source, externalId)` is unique. A display name is never an
  identity.
- A SCIM or GitHub group is read-only in the app; edit it at the source.
- A pending group can be reviewed but grants nothing. Approval activates its
  membership and its shares.
- Removing a group disables it and its shares; the users and their other grants
  remain.
- Group membership is resolved at use time, never copied into a share. Adding a
  member to an active group grants every share that group holds.
- `All users` stays a built-in, non-editable group.
- A group can be nested only if the source supports it; the first release does
  not nest SCIM or GitHub groups.

## GitHub sync target

### Configuration

A GitHub organization sync record on the tenant:

```text
GithubTeamSync
  organizationId, githubOrganization
  mode: github_app | personal_token
  credentialRef                 # sealed; never returned
  enabled
  lastSyncAt, lastSyncState, lastSyncDetail
```

- `github_app` mode uses the tenant GitHub App installation and requests
  `members: read` (organization members and teams). Existing installations must
  be re-approved for the new permission; the UI says so.
- `personal_token` mode accepts a classic `read:org` token or fine-grained
  **Members: Read** token. It is sealed and never rendered.
- The configuration screen lives with the organization SSO provisioning
  controls.

### Login-time sync

After a successful GitHub OAuth login:

1. Resolve the linked GitHub account ID. Do not use username or email.
2. With a configuration-scoped token, list the teams the account belongs to.
3. Upsert one group per team, keyed by GitHub team id.
4. Add or remove the person from those groups; never touch a group the token
   cannot see.
5. Stage changes for approval if the organization enables approval. Otherwise
   apply them and write an audit event.

The login token is never stored. Team sync does not widen the OAuth scope of
the sign-in itself; it runs only when the tenant configured sync and the GitHub
App/token has the permission.

### Manual sync

1. Read every team the configured credential can see and every member of each.
2. Resolve each GitHub account ID to the linked principal. Never match on
   login or email.
3. If any team member has no linked GitHub identity, stop before changing that
   team and report the people who must sign in. This is Infisical's safety
   property and we should keep it.
4. Apply membership changes, team removals and team renames as staged changes
   or direct changes according to tenant policy.
5. Secret teams the credential cannot see are skipped and left unchanged.
6. Write one audit event per group change and one summary event.

## SCIM Groups target

Add the missing SCIM 2.0 surface:

| Route | Behavior |
|---|---|
| `POST /Groups` | Create a SCIM group; validate member ids exist; starts pending |
| `GET /Groups` | List with `startIndex`, `count`, `filter=displayName eq "…"` |
| `GET /Groups/:id` | Return the group resource |
| `PATCH /Groups/:id` | Add/remove/replace members; name change; stages changes |
| `PUT /Groups/:id` | Full replacement, including members |
| `DELETE /Groups/:id` | Disable the group and revoke its shares; never delete users |

Additional rules:

- A SCIM group id is generated if the IdP omits one; the response carries it.
- Member ids must be provisioned SCIM users in the same organization.
- PATCH `replace` on `members` is supported; Proton and Entra use it.
- Group changes are staged for approval when approval is enabled, including
  membership edits. A pending user must sign in before approval.
- A SCIM-managed group is never editable through the app.
- Deactivation/removal from the IdP disables the group and its shares.
- Role mapping remains an explicit, separate action. A group named `owners`
  still grants nothing until mapped; mapping is owner-gated and audited.
- SCIM Groups CRUD is available only on an organization with provisioning
  enabled and a valid SCIM token.

## Sharing

Groups need to be share principals in both planes:

- **Hosted/Identity**: a `GroupShare` records the group and role. Project and
  vault access resolve group membership at use time.
- **Local PWA**: add `Group` records beside `LocalGroup`; local share grants may
  name any active group. The existing `All users` group remains.
- **Access checks**: resolve `principal -> groups -> shares`; no member list is
  copied into a share. A removed member loses the share at the next check.
- **Invites/approval**: a group share sends no per-member invitation. The group
  is the grantee; members inherit when active.
- **Audit**: name the group and the approving admin, never the member list in a
  log line.

## Native and PWA split

This is a control-plane feature, not a runtime credential path.

- **PWA**: organization group list, review queue, approvals, shares, GitHub
  sync configuration. It never holds a GitHub personal token in page state; the
  token goes straight into the sealed credential endpoint.
- **Native**: `opensesame org groups` and `opensesame org github-sync` for
  operators and CI; same API, no separate policy.
- **SCIM**: always server-to-server; never a browser endpoint.

## Outperformance

- Source-pinned groups: a DisplayName change can never collide with a manual
  group, and no role is inferred from a suffix.
- GitHub matching by account ID only, with an explicit stop for unlinked
  members instead of an email guess.
- Secret-team visibility is reported, not silently widened by a token with
  more privilege.
- Approval is a staged group revision with a digest, not an immediate
  membership mutation.
- Group shares are resolved at use time, so offboarding is immediate.
- Every provisioning change is auditable without logging member lists.

## Delivery slices

1. **Group records + shares.** Local and hosted groups, `GroupShare`, member
   resolution, audit. Keep `All users` built-in.
2. **SCIM Groups CRUD.** POST/GET/PUT/PATCH/DELETE, replace members, staged
   revisions, read-only source groups, delete/disable semantics.
3. **Group approval UI.** Review queue, approve/reject, digest, member sign-in
   requirement.
4. **GitHub team sync.** Config record, sealed token/App permission, login-time
   and manual sync, account-ID matching, unlinked-member stop, secret-team
   reporting.
5. **Sharing UI.** Group principals in vault and item share sheets, member
   counts, access preview.
6. **Alerts/audit.** Provisioning change events, sync failures, approval
   notifications.

## Acceptance

- SCIM POST/GET/PUT/PATCH/DELETE Groups round-trip against a directory client;
  a replace of members removes missing members.
- A SCIM group cannot be created with a member from another organization.
- A SCIM group created pending grants nothing until approved; a member who has
  never signed in blocks approval with a named list.
- A GitHub team member without a linked GitHub account stops that team's sync;
  no email/username guess is made.
- A secret team invisible to the token is left unchanged and reported.
- Renaming a GitHub team or SCIM group does not create a second group or drop
  its shares.
- Removing a member from an active group revokes inherited access immediately.
- Deleting/disabling a group revokes its shares but not its members' accounts.
- A group named `owners` grants no role until explicitly mapped.
- The GitHub token and SCIM token never appear in logs, URLs, model context, or
  a PWA global.
