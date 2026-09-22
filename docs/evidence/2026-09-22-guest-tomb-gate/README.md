# The guest tomb keeps its gate — 2026-09-22

Two real builds, one walk: a guest presses Add on the authenticator row, is
walked through the PIN card first, scans, confirms a code, saves the recovery
codes, then locks. Both captures are that locked screen — the guest tomb with a
PIN and an authenticator code enrolled.

- **before** — `d596573b` (the base branch), `apps/pages` built with
  `VITE_BASE=/OpenSesame/`.
- **after** — `70612766` (this branch), same build flags, same walk.

## The pair

| | before (`d596573b`) | after (`70612766`) |
|---|---|---|
| screen | `before/1_guest_locked.png` | `after/1_guest_locked.png` |
| method tabs | 0 | 1 (`PIN`) |
| key fields | 0 | 1 (`PIN`) |
| step rail | `1 · Key` / `2 · Authenticator code` | unchanged |
| guest road on the form | 0 (suppressed) | 1 (`Continue as guest`) |
| recovery road | 0 | 1 (`Forgotten how to unlock?`) |
| commit | `Unlock`, nothing to submit | `Unlock`, opens with the PIN |

Measured from the browser DOM dumps beside each capture
(`before/1_guest_locked.txt`, `after/1_guest_locked.txt`) — the on-screen
strings in order are:

```text
before: guest-1 | 1 · Key | 2 · Authenticator code | Unlock
after:  guest-1 | 1 · Key | 2 · Authenticator code | PIN | PIN | Unlock
        | Continue as guest | Forgotten how to unlock?
```

The before screen is the bug: a guest who enrolled a gate had no way to answer
it (and no guest road either — AGENTS.md §5 lists that link as load-bearing and
forbids gating it on vault status). The before run of `verify:auth` stops at
this screen with `locator.fill: waiting for getByLabel('PIN')` timing out; the
after run completes 45/0 including its reload leg.
