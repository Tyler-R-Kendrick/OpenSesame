# D7-2 device-key units (agent stack)

**Authority:** `d7-2-rubber-duck.md` and `d7-2-cross-model.md` override any older research notes.

## Secure revision branch (`cursor/persona-d7-2-secure-revision-b5a1`)

Stacked on U1–U4 (#1364–#1372). This branch revises units in place:

| Unit | Change in secure revision |
|------|---------------------------|
| U4 | Removed `--allow-tty-enroll` and `tty-opt-in`; OS secure prompt only; headless bail |
| U7 | `DAEMON_PIN_PROBE_VERB` hidden from pending; ambiguous pending cleared |
| U8 | Ensure and respond require UDS peer (kernel session); no loopback TCP approvals |
| U10 | `oschip1` rejected; `software-passkey` proofs blocked for `run`, `env-resolve`, `pass-reveal` |
| U11 | `pending.len() > 1` clears queue on ensure, approve, and list |

**Still open on this branch (follow-up PRs):** U2 v2 ARK-signed trust store + PWA verify, U3 bootstrap without operator token on enroll, U5 enrollment arming TTL, U6 alarm UI, U9 legacy pairing wipe + ARK-only block after passkey, remote CLI endorsement docs.

## Residual risks

See `d7-2-rubber-duck.md` § Residual risks.
