# ADR 0054 — The Agents screen becomes Access, a PAM surface

Status: Accepted
Date: 2026-08-29
References: ADR 0005 (ConnectionRef), ADR 0018 (standing grants vs task
authority), ADR 0019 (immutable ceiling), ADR 0021 (frozen intent), ADR 0044
(claimable connection delegation), ADR 0046 (relayed execution and the
authorization inbox), ADR 0048 (daemon invoke-through), competitor reference
[`docs/competitors/border0-tailscale-pam.md`](../competitors/border0-tailscale-pam.md),
design spec [`docs/design/access-screen.md`](../design/access-screen.md)

## Context

The Pages PWA's **Agents** screen grew around agent registration: register an
agent key, inspect a task run by id, list agent audit events, and show the
vault's secret ceilings. It answers "how does an agent prove itself" — but
the question an operator actually brings to that part of the app is the PAM
question: **who can reach what, right now, and who decided that?**

The authority plane already answers it. The gateway ships a complete PAM
substrate: connections with policies and bindings (ADR 0005), task runs with
immutable capability ceilings (ADR 0019), receipts, the relay authorization
inbox where a human approves or denies a relayed execution (ADR 0046), and
claimable delegations (ADR 0044). The last two have **no UI at all** — the
approval inbox exists only as API routes today.

Meanwhile the market has converged on what this surface looks like. Border0 —
now Tailscale PAM — defines the reference information architecture: an admin
plane (resource inventory, policies, session logs, access requests) and an
end-user plane (a searchable card dashboard of resources with one-click
connect and a just-in-time access-request flow), all under a Zero Standing
Privileges posture. The parity target and its terminology are captured in
[`docs/competitors/border0-tailscale-pam.md`](../competitors/border0-tailscale-pam.md).

## Decision

The Agents screen is replaced by **Access** (`/access`), a PAM screen whose
information architecture matches Border0's admin plane, bound entirely to
APIs the Host already serves:

| Tab | Border0 counterpart | Bound to |
|---|---|---|
| **Resources** | Sockets inventory / client-portal dashboard | Host connections + bindings, vault secret ceilings, discovery |
| **Sessions** | Session Logs | Host task runs (list, inspect, terminate), receipts, connection events, identity audit events |
| **Requests** | Access Requests / Approval Flows | Relay authorization inbox (pending → approve/deny, digest-pinned) + delegation offers |
| **Policies** | Policies | Per-connection policy editor, bindings (who may invoke), ceiling review |

The screen's connect UX mirrors the client portal: searchable resource rows
with per-type icons, status, and one-click authorize. The approval UX mirrors
Border0's inbox: pending requests show who/what/which parameters; deciding
requires the request digest, so consent binds to exact bytes — the OpenSesame
equivalent of Border0's "approval materializes a fine-grained policy."

Agent registration, task inspection, and agent audit events — the old Agents
screen's content — move into the tabs they belong to (Resources, Sessions)
rather than disappearing.

### Terminology

The UI speaks Border0's language where it maps cleanly — *resources*,
*sessions*, *requests*, *policies* — and keeps OpenSesame terms where the
concepts genuinely differ: *connection* (not socket), *ceiling* (not max
permissions), *receipt* (not recording). The nav label is **Access**; the
route is `/access`; `/agents` redirects.

### Deviations, recorded honestly

- **No session video recording.** Border0's Video/Text/Events replay has no
  server-side counterpart here; the Sessions tab shows receipts, ceiling
  state, and event streams instead. Recordings are a possible future Host
  feature, not something a screen can fake.
- **No network layer.** Tailscale's Machines/ACL/policy-file plane is a
  different product layer; OpenSesame's egress allowlists (invoke-through)
  appear as resource metadata, not as a second policy editor.
- **No requester-side flow in this iteration.** Submitting relay requests is
  a runtime/API act (ADR 0046); the Requests tab is the *approver's* inbox
  plus delegation offers, which is the half with a real API and no UI.

### What this does not change

No server routes, no trust boundaries, no new secrets surface. Every tab
binds existing read/decide endpoints through the existing `hostFetch` /
`identityJson` clients with the same caller identity as the rest of Pages.
The "Agent secrets" vault item kind is untouched — it is a vault taxonomy,
not this screen.

## Consequences

- The approval inbox and delegation offers get their first UI; ADR 0046's
  human-in-the-loop becomes operable from a browser instead of `curl`.
- The Agents screen's five mechanical touchpoints (`App.tsx` route and slots,
  `AppShell` nav, `crumbs.ts`, the section file trio) move to `Access*`;
  `/agents` redirects so existing links land.
- New client code is confined to one seamed lib (`apps/pages/src/lib/access.ts`)
  covering relay inbox, task list/terminate, and delegation offers — the same
  pattern as `lib/connections.ts`, so tests seam it the same way.
- Parity is graded against the competitor reference doc: the tab set, the
  entities per tab, the connect flow, and the approval flow must each be
  traceable to a row in the mapping table. Future PAM work (recordings,
  requester-side submission, network-layer policy) extends the same screen
  rather than inventing a new one.
