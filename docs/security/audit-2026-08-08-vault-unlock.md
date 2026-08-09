# Audit 2026-08-08 — the vault unlock, and one definition of loopback

Tick 72 read `apps/pages/src/lib/lock.ts`, the PIN gate in front of the Pages
vault. The gate is honest about what it is — the app says the PIN never decrypts
anything, and the catalog behind it is metadata only — so what is at stake here is
the lockout and the cost of guessing, not confidentiality of secrets.

## A new PIN stood in for knowing the old one

`setUnlockPin` wrote a fresh record, cleared the attempt counter, and set the
session unlocked, without asking for anything. Only the UI decided when to offer
it (`firstRun = !hasUnlockPin()` at mount). So the progressive lockout — the whole
point of the attempt counter — was escaped by choosing a new PIN instead of
guessing the old one.

`setUnlockPin` now refuses to replace an existing PIN unless the session is already
unlocked, and `changeUnlockPin(current, next)` proves the current PIN first. The
internal writer both paths share is what the legacy and weak-parameter upgrades
call, so those still work without a hole in the guard.

## A stored record chose its own KDF cost

`unlock` derived with `stored.iterations` verbatim. Storage is not a place that
earns trust: a record naming `iterations: 1` is cheap to guess against offline,
and one naming `1e12` hangs the tab — a lockout by another name. A zero-length or
malformed salt was accepted too, and bad base64 escaped as a raw `atob` exception.

Records are now bounded on the way in: an integer count within a sane ceiling, a
salt of at least 16 bytes, and base64 that decodes. A record below today's floor
is accepted once — so nobody is shut out of their own vault — and then rewritten
at current cost, the same upgrade the unsalted-SHA-256 path already had.

## A planted deadline locked the vault forever

`readAttempts` returned whatever `lockedUntil` it found. A value a year out — from
a rewritten record or a skewed clock — meant the vault stayed shut for a year. The
deadline read back is now clamped to the policy maximum of fifteen minutes.

## One fence, not three copies

Tick 71 hand-rolled loopback and base-URL checks in `apps/pages` and
`apps/console`, while `@opensesame/api-client` already exported
`normalizeLoopbackBaseUrl` and `normalizeHttpBaseUrl` — the fence the extension
uses, with tests for credential smuggling and lookalike hosts. Both surfaces now
delegate to those, which also fixed a real gap in the copy: a base carrying a
query or fragment was accepted and would have swallowed every path joined to it.

## Not fixed here

- Client-side lockout state is advisory; anything that can write our storage can
  reset the counter, and nothing in a browser can prevent that. It costs an
  attacker the derivation work, which is why the iteration floor matters.
- The legacy unsalted SHA-256 record is still accepted (and upgraded) forever.
  Retiring it needs a migration deadline someone owns.
