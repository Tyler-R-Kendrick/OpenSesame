# Access — the PAM screen

Design spec for the Pages **Access** screen (`/access`), implementing
[ADR 0054](../adr/0054-access-screen-pam.md). Parity target: Border0 /
Tailscale PAM, per
[`docs/competitors/border0-tailscale-pam.md`](../competitors/border0-tailscale-pam.md).
Everything below binds APIs the Host already serves; no new server surface.

## Layout

Standard section anatomy (`div.section__inner` → `header.section__head` →
tab bar → one active tab panel). Thesis line: "Who can reach what, right
now — and who decided." Four tabs, one visible at a time:

```
Access
Who can reach what, right now — and who decided.
[ Resources ] [ Sessions ] [ Requests ] [ Policies ]
```

Tab order mirrors the operator's day: see resources, watch sessions, decide
requests, shape policies. **Requests carries a count badge** when the relay
inbox is non-empty — an undecided approval is the one thing on this screen
that blocks someone.

## Resources — the inventory (Border0: Sockets / client portal)

One searchable list of what can be reached, type-icon first. Sources, merged:

- **Host connections** (`GET /api/v1/connections` via `lib/connections.ts`)
  — name, provider icon, `status`, `connectionRef`, bindings count, last
  event. Row actions: **Authorize** / **Revoke** (`authorizeConnection`,
  `revokeConnection`), expand for bindings + egress scopes.
- **Vault secrets with ceilings** (`useVault()` `SecretItem`s — the old
  `SecretsAndCeilings` panel, kept as-is visually) — name, `connectionRef`,
  grantee chips, ceiling pairs.
- **Discovery** (`discoverConnections`, best-effort) — offers not yet
  adopted, with an adopt affordance.
- **Agent registration** (the old `RegisterAgent` ceremony, unchanged)
  lives here as the "service account" creation flow (Border0: Teams →
  Service Accounts).

UX parity notes: fuzzy search box filters all rows client-side (client
portal parity); per-type icons (existing connector marks); a standing
offline/pairing note (`PagesCannotHostNote`) when the Host is unreachable —
the list is the screen, never a dead-end.

## Sessions — who is in what, now (Border0: Session Logs)

- **Task runs** (`GET /api/v1/tasks` → rows: `task_run_id`, `status`,
  `state_version`, principal; expand → `GET /api/v1/tasks/{id}` ceiling vs
  current capabilities table — the old `TaskInspector`, now driven by the
  list instead of manual id entry). Row action: **Terminate**
  (`POST /api/v1/tasks/{id}/terminate`) — Border0's kill-session.
- **Activity** (identity audit events, the old `AgentActivity` feed,
  refreshed, filterable) — who did what, when.

## Requests — the approval inbox (Border0: Access Requests)

New client surface (`lib/access.ts`), the screen's reason to exist:

- **Pending relay requests** (`GET /api/v1/relay/requests/pending`): each
  card shows operation, resource, parameters (pretty-printed), connection,
  and state. Actions **Approve** / **Deny**
  (`POST /api/v1/relay/requests/{id}/approve|deny` with `request_digest`
  echoed — consent binds to exact bytes, surfaced in the UI as a
  "reviewed digest" confirmation line).
- **Delegation offers** (`GET /api/v1/delegations/offers`): claimable
  grants with a **Claim** action (`POST /api/v1/delegations/claim`).
- Empty state is a good state, said plainly: "Nothing waiting on you.
  Standing privilege stays at zero."

## Policies — who may do what (Border0: Policies)

Per-connection policy surface, reusing the existing
`sections/connections/PolicyEditor` and `BindingEditor` components against
`updateConnectionPolicy` / `bindConnection` / `unbindConnection`, plus the
ceiling review from the old screen. No new policy model is invented here —
the tab presents the Host's.

## Data and state rules

- All loads are best-effort and independent: a Host that's down degrades
  tabs individually (vault-backed content still renders), following the
  Connections section's two-phase pattern.
- Every mutation is optimistic-free: act, await, then reload the list.
- Requests badge polls on screen focus, not on a timer.
- Errors map to plain words via the existing notice pattern; a 404 on
  decide means "already decided or lapsed — someone else got there,"
  exactly as the server intends (indistinguishable by design).

## Files

- `apps/pages/src/sections/AccessSection.tsx` + `access.css` + tests
  (replacing the `AgentsSection` trio; `/agents` redirects).
- `apps/pages/src/lib/access.ts` — seamed client: relay inbox, task
  list/get/terminate, delegation offers/claim. Same seam pattern as
  `lib/connections.ts`.
- Touchpoints: `App.tsx` (route + slot), `AppShell.tsx` (nav label/icon),
  `crumbs.ts` (breadcrumb).

## Test plan

- Tab exclusivity and badge count from a seamed inbox.
- Resources: merged list renders connections + vault ceilings; search
  filters; authorize/revoke call through.
- Sessions: list → expand → ceiling table; terminate calls with state
  version.
- Requests: pending render, approve/deny echo the digest, 404 →
  already-decided wording; delegation claim.
- Policies: policy save and bind/unbind call through.
- Locked/empty vault and offline-Host states render the right notes.
