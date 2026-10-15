# D7-2 residual risk mitigations

| Risk | Mitigation | Status |
|------|------------|--------|
| Same-user overwrites trust store | `opensesame-cli-trust-guard` + systemd/launchd; daemon `load`/`save` via RPC; `OPENSESAME_CLI_TRUST_GUARD_REQUIRED` fail-closed | **Fixed** (PR trust-guard) |
| Compromised desktop clicks OS prompt | Enrollment arming TTL; arm only after operator path post-OS-prompt on CLI | **Partly fixed** — cannot prevent a live desktop compromise |
| Enrollment window race | Single-flight arm; disarm on finish; begin refused when not armed | **Partly fixed** — narrow TTL window remains |
| Remote CLI endorsement trust | Documented in rubber duck; no new wire protocol in this stack | **Not fixable here** — trust anchor is endorser machine |
| Software passkey misclassification | `software-passkey` vs `passkey` kinds; passkey required when paired; tiering on high-risk verbs | **Partly fixed** — depends on PWA emitting correct kind |
| Binary swap on enroll/daemon | `daemonBinarySha256` on begin; env pins `OPENSESAME_DAEMON_BINARY_SHA256` / `OPENSESAME_ENROLL_BINARY_SHA256` | **Fixed** (PR bootstrap) |
| Approval spam | Rate limit per terminal session; coalesce identical pending; refuse all when >1 pending | **Fixed** |
| SAS / changed key | `spkiSas` on finish; `GET /v1/cli/app-integration/root-trust/status`; PWA `compareRootTrustFingerprint` | **Fixed** (alarm UI wiring is caller-side) |
| Downgrade / rollback | `oschip1` rejected; passkey-paired bindings require passkey proofs; legacy pairings wiped on enroll; guard epoch monotonic seal | **Fixed** |
| Recovery without silent re-enroll | OS `confirm_enrollment` before arm/enroll; guard `reset` argv on helper (root only) | **Fixed** for enroll path |
