# Settings › Security: every row acts, or is not drawn

Two real builds walked the same way: **before** is `origin/main` at `d97827a9`
(built in its own worktree), **after** is this branch. Numbers are read from the
browser (`capture-evidence.mjs`, `count` steps), not from the diff. Decision:
[ADR 0158](../../adr/0158-settings-rows-act-or-are-absent.md).

| Sheet | What it shows |
|---|---|
| [`1280-guest-top.png`](1280-guest-top.png) | Security as a guest, desktop, top of the page |
| [`1280-guest-lower.png`](1280-guest-lower.png) | Formats, Age keys, Transport as a guest (Transport unchanged: ADR 0132's `AT-STATIC-EMPTY` requires its idle rows) |
| [`390-guest-top.png`](390-guest-top.png) | The same at 390 × 844 |
| [`1280-vault-top.png`](1280-vault-top.png) | Security with a sealed personal vault |

## Measurements (`section.panel` on the Security page)

| | Before | After |
|---|---|---|
| **Guest** — panels | 8 | 5 |
| **Guest** — disabled keys | 5 | 1 (*Seal identity*: a form submit waiting for its own field) |
| **Guest** — status marks (locks, ticks, "not checked") | 22 | 6 (five are Transport's, left as is) |
| **Guest** — keys that lead to another page instead of acting | 2 | 0 |
| **Personal vault** — panels | 8 | 6 |
| **Personal vault** — disabled keys | 1 | 1 (same) |
| **Personal vault** — status marks | 23 | 8 |

Panels in the guest list — before: Vault key protection, Unlock methods, Second
step, Recovery, Automatic sign-in, Formats, Age keys, Transport. After: Unlock
methods, Second step, Formats, Age keys, Transport.

## Behaviour verified live (attached dev server, real browser)

Every key on the page pressed, as a guest and with a sealed personal vault, in a
throwaway profile: all act, except *Seal identity* (disabled until its field has
text). On the personal vault, with the old code and then this branch:

| Action | Before | After |
|---|---|---|
| Preferred unlock | `Protector password_… is not enrolled` | Preferred protector updated; the mark moves |
| Add recovery key | Downloaded, but never listed | Downloaded and listed; Preferred and Remove work on it |
| Remove the last protector | — | Refused: "last verified independent unlock path" |
| Test on Password | Same "not enrolled" error | Not drawn (the service proves Password/PIN/passkey only at unlock); drawn for a recovery key |
| Rotate | — | Vault key rotated |
| Email/Text with no sign-in service | Locked row, gear to a Host connection form | Key opens the Sign-in service sheet; saving enables Add |
