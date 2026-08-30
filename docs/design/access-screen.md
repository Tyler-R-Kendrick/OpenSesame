# Access — the PAM plane

Design contract for the Pages **Access** section. Decision record:
[ADR 0061](../adr/0061-access-pam-plane-ceremonies.md) (supersedes the tab
structure of [ADR 0054](../adr/0054-access-screen-pam.md)). Parity target:
[`docs/competitors/border0-tailscale-pam.md`](../competitors/border0-tailscale-pam.md).

Access is the grantor's PAM plane. It **does** privileged access management —
grant, revoke, narrow, approve, terminate — it never *describes* connectors,
secrets, or itself.

## Hard rules

- **No prose.** No taglines, no educational captions, no connector
  descriptions. Table headers, action buttons, one-line empty states. If a
  sentence explains what PAM is, delete it.
- **A ceremony per fork.** Every distinct action is its own focused
  ceremony (own view state inside the section, back-link out), never fields
  appended to a long page: Grant access, Approve/Deny, Revoke, Narrow,
  Policy edit. One ceremony visible at a time.
- **Nothing non-PAM.** No service-account registration (that's agent
  provisioning — it doesn't live here), no vault secret inventory panels,
  no "what is a connection" content.

## Layout

Route `/access`, nav label **Access** (`IconAuthority`), crumb `access`.
Tabs, one mounted at a time (`role="tablist"/"tab"`, `aria-selected`):

**Grants · Requests · Sessions · Resources · Policies**

## Grants — the center of gravity (Border0: standing privilege = 0)

The primary tab. The delegation table (`GET /api/v1/delegations` — rows
where the caller is owner):

| Claimant | Resource (connection) | Actions | Mode | Expires | |
|---|---|---|---|---|---|
| `claimant_subject` | connection name/ref | action chips | broker/relay | countdown | Revoke · Narrow |

- **Revoke** — confirm sheet → `DELETE /api/v1/delegations/{id}`.
- **Narrow** — small form (actions, resources, shorter expiry) →
  `POST /api/v1/delegations/{id}/narrow`.
- Empty state: `No active grants.`
- Primary action, top right: **Grant access** → the ceremony below.

### Ceremony: Grant access (JIT)

Steps, each its own view:

1. **Target** — a searchable picker of grant targets, two groups:
   *Connections* (every connection) and *Secrets* (vault secrets — a secret
   grants through its `connectionRef`; picking one prefills scope from its
   ceiling and shows the ceiling as read-only context).
2. **Scope** — actions + resources (chips/CSV), execution mode
   (broker | relay — relay adds "each use needs approval"), duration
   (presets: 1h, 8h, 1d, 1w + custom seconds). For a secret target these
   prefill from `ceiling` grants (`action`/`resource` → offer `actions`/
   `resources`) and stay editable downward (narrowing only, never widening
   past the ceiling — the UI enforces subset).
3. **Mint** — `POST /api/v1/delegations`
   `{items: [{connection_id, actions, resources, expires_in_seconds, execution_mode}]}`.
4. **Code card** — the minted `claim_token` + `user_code` with copy
   affordances and the offer expiry. One line: hand these to the requester;
   the grant activates when claimed. Done → back to Grants.

## Requests — the approval inbox (Border0: Access Requests)

- Pending relay requests (`GET /api/v1/relay/requests/pending`): operation →
  resource, parameters, connection, digest. Approve/Deny echo
  `request_digest` (ADR 0046). 404 on decide → row collapses as
  "already decided". Empty state: `Nothing waiting for approval.`
- **My offers** — offers I minted (`GET /api/v1/delegations/offers`) with
  state (pending/claimed/expired) and expiry; revoke a pending offer
  (`DELETE /api/v1/delegations/offers/{id}`).

## Sessions — who is in what, now (Border0: Session Logs)

- Live task runs (`GET /api/v1/tasks`): principal, status, started;
  expand → detail (`GET /api/v1/tasks/{id}`, ceiling comparison);
  **Terminate** → `POST /api/v1/tasks/{id}/terminate`
  `{expected_state_version}`. Empty state: `No live sessions.`
- Receipt trail beneath (connection/agent audit events), terse rows.

## Resources — what grants point at

Terse rows, three groups, searchable by name/ref:

- **Connections** — name, ref, status chip. Actions: **Grant access**
  (opens the ceremony with this target preselected), **Policy** (drill-in).
- **Secrets** — name, connection ref, ceiling size. Actions: **Grant
  access** (prefilled target). Values never render.
- **Sites** — origin clients (name/origin, status, created). Actions:
  **Manage** (drill-in below). Group header action: **Register a site** →
  the register ceremony (origin validation, scopes, create → client id +
  snippet).

Empty state: `Nothing to grant yet — connect a service or add a secret.` +
link to Connections. No other copy.

### Site drill-in (site access management)

Selecting **Manage** on a site row swaps to the site view (back link), the
verbs the old Sites screen had, one per section: client id with copy,
**Rotate** / **Revoke** (confirm each), the integration snippet (sign-in +
callback variants), the domain allow/block policy for the origin, and the
site's sign-in events. One site on screen at a time.

## Policies — standing rules, drill-in

A plain list of connections. Selecting one swaps to the policy view (back
link): the existing `PolicyEditor` (delegation depth, materialization,
shareability) and `BindingEditor` (who is bound: organization, project,
agent, group, device, identity) for that connection only. One resource's
policy on screen at a time.

## Data and state rules

- Extend `apps/pages/src/lib/access.ts` (same seam pattern):
  `listDelegations()`, `revokeDelegation(id)`, `narrowDelegation(id, input)`,
  `mintOffer(input)`, `listMyOffers()`, `revokeOffer(id)` — wire shapes from
  `crates/connection-broker/src/delegation.rs` (`MintOfferRequest`,
  `OfferView`, `DelegationView`) and `apps/gateway/src/routes/delegations.rs`.
  Read them before binding.
- Secret targets come from the unlocked vault (`useVault` items of kind
  `secret`): name, `connectionRef`, `ceiling`, `grantees`. Locked vault →
  secrets group hidden with one line `Unlock the vault to grant secrets.`
- Every list fails soft (unreachable → note + retry, never blank).
- Relative time for expiry; countdown ticks without refetch.

## Explicitly not here

Service-account/agent registration, connector descriptions, vault secret
value inventory, Pages-hosting notes, claim-ownership ceremonies, device
approval (lives in Identity → Devices).

## Test plan

Rewrite `AccessSection.test.tsx` (hoisted seam mocks, no module mocking):

- Grants table renders delegation rows; Revoke confirms then calls seam;
  Narrow posts the narrowed shape.
- Grant ceremony: connection target → scope → mint posts the exact
  `MintOfferRequest` → code card shows token + user code. Secret target →
  scope prefilled from ceiling; scope cannot exceed ceiling (attempt to add
  an out-of-ceiling action is blocked); mint uses the secret's
  `connectionRef`.
- Requests: approve echoes digest; 404 → "already decided"; offers list
  renders states; revoke offer calls seam.
- Sessions: terminate posts `expected_state_version`.
- Resources: rows are terse (assert no prose strings), Grant/Policy actions
  navigate to ceremony/policy view.
- Policies: picker → drill-in → back.
- No "Agent"/"Agents" strings, no registration form, no multi-sentence
  paragraphs (a lint-style test asserting the section's text content stays
  under a per-view sentence budget is fine).
- Lib tests for the new delegation functions (wire mapping, error mapping).

Gates: `pnpm --filter @opensesame/pages test`, `tsc --noEmit`, per-file
oxlint anti-slop, biome — all green before reporting.
