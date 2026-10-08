# ADR 0128 — The Pages PWA no longer speaks Host

## Status

Accepted.

Amended by: [ADR 0136](0136-join-a-session-restored.md) (a second, bounded
exception: joining a session), [ADR 0144](0144-tailnet-vault-sync.md) (a
third: the tailnet vault drive) and [ADR 0169](0169-tailnet-device-management.md)
(a fourth: the tailnet device routes of a paired daemon).

## Context

The Pages PWA is a static front end (ADR 0090) whose live roads run on
Vercel Connect: browse, authorize, revoke, and GitHub backup all complete
with no Host. What remained Host-shaped — pairing ceremonies, Host session
gates, Host secret/sync/task/changelog/backup panels, Host OAuth-client
setup, and the word itself across copy, comments, identifiers, and file
names — made every connector page read as half-built: the controls exist,
but with no Host behind them they dead-end.

## Decision

Remove Host from the PWA entirely (`apps/pages`):

- No Host session, pairing, grant, or fetch machinery in Pages
  libraries; the Connect transport and the sealed local stores are the
  only live roads.
- No Host-only panels, ceremonies, notes, or hints in Pages UI. Where a
  Host feature has a Connect or local equivalent (authorize, backup), the
  page offers that road; where it has none (Host secret configs, sync
  targets, task bus, Host changelog, server-side backup), the surface goes
  away with its tests.
- The word appears zero times in `apps/pages`: copy, comments,
  identifiers, file names, and tests.

The Host plane itself (gateway, daemon, CLI, ADRs 0005/0017/0039/0041)
is untouched — this is about what the static PWA speaks, not about what
exists. The capability registry marks the removed Pages mappings
excluded by this ADR.

**Exception (2026-09-19):** GitHub App Manifest registration, installation
listing, and backup authorize run through the Connect callback relay
(`apps/connect-backend`, ADR 0127) and browser-held App credentials
(ADR 0126). Pages does not call a Host GitHub App API. Other Connect
providers remain Host-free under this ADR.

**Exception (2026-09-24, [ADR 0136](0136-join-a-session-restored.md)):**
the join ceremony speaks to the one endpoint it names — delegation present
and claim, public-session listing and join requests, under a browser grant
the endpoint's operator approved and a passkey verified. It never configures
the app's Host, and nothing else in Pages speaks Host.

**Exception (2026-09-24, [ADR 0144](0144-tailnet-vault-sync.md)):** tailnet
vault sync reads and replaces one sealed snapshot on the drive a person
paired, through that daemon's two device routes, holding only the slot's
access key. It sends no operator token, calls no slot or Host route, and
never configures the app's Host.

**Amendment (2026-10-03,
[ADR 0151](0151-connector-pages-act-on-the-roads-a-device-has.md)):** the
connector pages kept the Host's forms and calls after this ADR removed the
rest — organisation OAuth clients, custom providers, token forms, Host
repository listing, and a "Host road" that no build could open. They are gone,
and `connections.ts` refuses what no road on the device can take instead of
sending it. No ceremony was added to open that road: it would be a
Host-speaking surface, which this ADR says must overturn it first.

## Consequences

- A Host API URL in Endpoints is optional advanced wiring for deployments
  that still speak Host elsewhere; Pages never requires it and never
  gates Connect or guest roads on it.
- Connector pages work end to end on Connect alone.
- Any future Host-speaking surface in Pages must overturn this ADR first.
