# ADR 0208 — Hosting starts at the Share key, not a Settings page

- Status: Accepted
- Date: 2026-10-20
- Amends: [ADR 0150](0150-live-sessions-browser-to-browser.md) (where the
  owner hosts: §2's panel and §6's routes move out of Settings)

## Context

ADR 0150 put hosting on a Settings › Live sessions tab: a form of seven
fields before a session could start, and a Routes panel of address, ICE
and carrier fields beside it. Nobody goes to Settings to share something;
they are looking at the vault they mean to share. The form also made the
common case — share this vault, with the defaults the form itself
pre-selected — cost a page of fields, and put relay configuration, which
almost nobody has, at the same weight as starting.

## Decision

- There is no Settings › Live sessions page. The capability contributes
  no `settings-category`.
- A **Share key sits beside the vault's name in the shell prompt, next
  to the lock**, while Live sessions is on and the vault is the owner's
  own (never a guest's). The shell owns only an empty seat there
  (`components/vault-share-seat.tsx`); the capability's shell wrapper
  fills it and owns the sheet behind the key, so a build without the
  capability draws nothing.
- The sheet needs **no fields to start**: one key, *Start sharing*,
  starts a session named for the vault, sharing the whole vault, values
  copy only, link-and-code admission, one hour — the old form's own
  defaults. While a session runs, the same sheet is the session (link,
  code, who is asking and who is in, end for everyone), and the Share
  key carries a live mark.
- Everything else is **Advanced, collapsed by default**: the start
  choices (scope and chosen items, policy, admission, duration,
  devices) and Routes — the owner's own relay: addresses, STUN/TURN,
  relay only, carriers — still written to the sealed
  `settings/live/transport.json` and still read as a session starts, so
  a relay is named there before the press. With none named, a session
  is direct only and contacts nothing, as before.
- The rail menu's Share › Session opens the same sheet instead of
  navigating to the retired tab. The `/live` join road is unchanged.

## Consequences

- `settings/live/transport.json` is no longer listed in the Settings
  file viewer through a category; it is edited from Advanced (and
  remains a sealed vault file).
- The guide target `settings.live` and its panel targets retire; the
  walkthrough points at `shell.share` on the vault screen.
- Rejected: keeping a settings page as a second door. Two places to
  host is one too many, and the settings page was the form dump this
  removes.
