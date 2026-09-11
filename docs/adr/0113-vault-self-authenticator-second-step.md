# ADR 0113 — The vault as its own authenticator: supplying the second-step code

- Status: Accepted
- Date: 2026-09-11
- Supplements: [ADR 0091](0091-account-exits-and-unlock-ceremony.md) (the
  unlock ceremony and its second steps), [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (the static front end holds the whole ceremony)

## Context

ADR 0091 made the authenticator (TOTP) gate a second step taken after a
primary method produces the vault key. The gate's seed is sealed under that
same key. That makes the ceremony's two steps **non-independent by
construction**: whoever has the key can open the seed and compute every code,
so a person retyping a code on the same device that just produced the key
proves nothing the key did not already prove. The non-independence was
accepted at enrollment; what was not examined is what the retype costs:

- **It trains the exact habit phishing exploits.** Every unlock teaches the
  person to read a one-time code off a screen and type it into whatever asks
  next. The day the asking surface is an attacker's site, the training fires.
- **It puts the code on the clipboard.** Copy/paste is how most people move a
  TOTP code, and the clipboard is readable by any page and any app on the
  device.

The optimization the unlock screen wanted is therefore not "ask less often"
but "stop showing the code at all": when the vault itself is the registered
authenticator for the vault, the current code can be computed in memory and
handed to the very same `confirmTotp` check a typed code takes.

## Decision

1. **Enrollment registers the vault as its own authenticator.** When a TOTP
   gate is enrolled (or a legacy gate without a registration first sees a
   correct code), the store seals an ordinary login item titled
   `OpenSesame (this vault)` holding the same seed, and the gate's header
   record gains `selfItemId` pointing at it (`lib/vault/self-authenticator.ts`).
   The entry is a real item — it works as an authenticator entry in the item
   list — and a second device adopting the same titled entry registers by
   reference instead of duplicating it.
2. **Unlock supplies the code, never shows it.** After a primary unwrap, when
   the gate carries `selfItemId` and the entry is live, the store computes
   the current code in memory and calls `confirmTotp` with it
   (`#afterPrimaryUnwrap`). The code is never rendered, never placed on the
   clipboard, and never crosses an intent, a message channel or any other
   IPC — the whole supply is one function call inside the store. Anything
   unusual (entry trashed, seed unreadable, a code that fails anyway on a
   skewed clock) falls back to the manual challenge exactly as before.
3. **Trashing the entry is the opt-out.** Withdrawal is the ordinary item
   lifecycle: trash the entry and the next unlock asks for the code again;
   restore it and the supply resumes. The `selfItemId` marker is deliberately
   left on the gate, so a manual code after withdrawal does not resurrect the
   entry — the opt-out persists. Removing the gate trashes the entry with it.

## Rejected alternatives

- **Clipboard hand-off** (copy the code for the person): keeps the code on a
  shared, sniffable surface — the attack surface this ADR removes.
- **Custom intents / postMessage supply**: spoofable and sniffable by any
  listener; the supply must not leave the store.
- **Always skipping step 2 for a registered vault**: the manual road must
  stay live — trashing the entry is the opt-out, and a wrong clock must not
  lock anyone out.

## Consequences

- The second step still exists and still gates a wrong key; what changes is
  that on the registered device the person stops handling the code. The
  phishing rehearsal — "read a code here, type it there" — no longer happens
  on the unlock screen.
- Security copy that said "every unlock asks for a code" was corrected: this
  vault supplies the code itself; anything else still asks.
- `verify:auth` walks both roads: the guest/PIN journey opens with the code
  supplied and asserts no code was asked; the password journey trashes the
  entry through the UI and walks the manual road (wrong code refused, real
  code accepted) that the opt-out leaves behind.
