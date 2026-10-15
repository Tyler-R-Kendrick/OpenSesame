# D7-2 cross-model review (Grok cross-check)

**Status:** Same override authority as `d7-2-rubber-duck.md`.

## Unit stack revisions (U1–U11)

| Unit | Prior | Revised |
|------|-------|---------|
| U1 | Root enrolled gate | Unchanged gate; pairing still blocked until authenticated store present |
| U2 | Sealed trust blob | **v2 store**: version, `D_pub` fingerprint, epoch, **ARK signature** over epoch binding; PWA read/verify route; tamper → fail closed |
| U3 | PAKE + operator begin | **Bootstrap transcript**: frozen origin + approver key in message 1; daemon signature proof; **no operator token** on enroll; SAS/fingerprint compare |
| U4 | Host enroll + optional TTY | **OS prompt only**; host **arms** window; headless **refuse**; drop `--allow-tty-enroll` |
| U5 | (research) | Enrollment arming API + TTL on daemon |
| U6 | (research) | PWA trust-store verifier + alarm UI on ARK/`D_pub` change |
| U7 | Pin probe / transport | Default-on pin probe; **UDS-only** approvals; pin-probe never in human pending queue |
| U8 | TCP session id | Per-peer kernel session; **reject TCP** for ensure/respond; prune stale sessions |
| U9 | Downgrade | Wipe legacy pairings; reject `oschip1`; block ARK-only when passkey enrolled |
| U10 | Passkey tiering | Software/virtual passkey proofs capped to low-risk verbs |
| U11 | Pending hygiene | `pending.len() > 1` → refuse/clear all; single-flight approvals |

## Implementation note

Full ARK/PWA signing and platform-specific secure prompts land across U2–U6 and Pages modules; transport and proof hardening (U7–U11) can land in `cli-app-integration` + daemon first.
