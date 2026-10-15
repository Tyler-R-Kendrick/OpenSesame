# D7-2 PWA peer trust (Tyler constraint audit)

**Rule:** The static Pages PWA must run peering and trust without a host, daemon,
root helper, or CLI. Those surfaces stay **optional add-ons** only.

## Changed units

| Unit | PWA-only | CLI/daemon optional | Action |
|------|----------|---------------------|--------|
| U1 root gate | N/A (CLI enroll) | Yes | Unchanged on CLI path; PWA uses ARK in IndexedDB |
| U2 trust store | **`peer-trust/store.ts`** ARK-signed epoch | Daemon file + optional trust-guard | PWA implementation; guard **not** required |
| U3 PAKE enroll | Future PWA QR + WebRTC signal | Daemon `root_enroll` | CLI-only until PWA PAKE lands |
| U4 host enroll entry | Dropped for PWA | `opensesame enroll` | PWA never calls |
| U5 enrollment arming | Passkey unlock arms PWA store | Daemon arm route | CLI-only arming |
| U6 SAS / alarm | **`peer-trust/alarm.ts`**, **`live/peer-trust-admit.ts`** | Daemon status route | PWA verifies signal + remembers fingerprint |
| U7–U11 CLI approvals | **`peer-trust/approval-queue.ts`** (in-browser) | Daemon UDS store | Same hygiene; PWA queue has no UDS/TCP |
| Trust guard helper | **Dropped** as PWA dependency | Optional `opensesame-cli-trust-guard` | Do not wire Pages boot to guard |
| P7 pairing defaults | Unchanged | CLI | No daemon requirement for guest/live |
| B7 share/pepper UI | Unchanged | — | No trust-guard coupling |

## PWA implementation map

- **ARK:** `peer-trust/ark-key.ts` — non-extractable P-256 in `opensesame-peer-trust` IDB.
- **Signed record:** `peer-trust/envelope.ts` + `store.ts` — monotonic `enrollmentEpoch`, `highWaterEpoch` rollback refusal.
- **Peering signal:** `peer-trust/signaling.ts` — JSON for QR / manual paste beside WebRTC.
- **Live admit:** `live/peer-trust-admit.ts` — verify before catalog exchange.
- **Approvals:** `peer-trust/approval-queue.ts` — refuse >1 pending, rate limit, coalesce.
- **Passkey tiering:** `peer-trust/human-proof-tier.ts` — software passkeys blocked on high-risk verbs.

## Residual (honest)

- PWA PAKE enrollment between two browsers is not in this PR; signaling carries an already-signed trust intro.
- Software vs hardware passkey classification still depends on WebAuthn authenticator metadata at approval time.
- Same-origin malware with an unlocked vault can still approve peer prompts.
