# D7-2 device-key stack — agent working notes (from Tyler brief)

Units U1–U11 on top of #1352 + D7-1b folded in.

## U1
- Remove any self-arm of registration.
- Reject `confirm`, `arm_registration`, `register_webauthn`, `exchange` until a **root trust key** is enrolled on the daemon.

## U2
- Persistent **trust store** for enrolled root / device trust material.

## U3
- **PAKE enrollment** protocol to enroll the root key (before pairing flows work).

## U4 — host-side enrollment entry (held until headless Linux policy confirmed)
- OS secure prompt where available; refuse TTY by default; opt-in `--allow-tty-enroll` with audit log (Tyler queue message may override hold).

## U7 / U8 (also close Infisical N7-2/N7-3 style findings)
- U7: daemon pin default-on + verify transport actually used (UDS vs TCP).
- U8: pin-probe must not enter human pending queue; stable per-process TCP correlation + prune stale tcp terminal sessions.
