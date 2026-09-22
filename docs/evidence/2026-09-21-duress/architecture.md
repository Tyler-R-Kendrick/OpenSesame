# Architecture — Duress profiles

## Trust boundaries
1. **Browser-local application** (`apps/pages`): offline after enrollment; OPFS/VFS; application codes; sealed slots; local fence.
2. **Cryptographic compartments**: independently generated keys; PRF-and-code two-layer envelopes; PIN KDF floor 1,200,000.
3. **Independent authority (optional Host/daemon)**: holds/quarantine/sign refusal; not required for local scenarios.
4. **External observations**: alerts, peer receipts, provider revocation — non-atomic relative to local restrictions.

## Pre-unlock bootstrap
Activation manifest + sealed profile slots are independent of the protected root. Alert packages use dedicated sealing keys.

## Runtime commit points
1. Verified trigger match
2. Durable incident fence + session generation bump
3. Issue opaque `AccessContext`
4. Queue optional alert (async)
5. Apply local removal / presentation only for admitted compartments

## Lock ordering
ProtectionSessionGuard bump → read durable fence → IAM checks (no nested IAM lock acquisition from duress path).

## Explicit non-claims
No personal safety, undetectability, forensic erasure, hardware UV=biometrics, or guaranteed emergency response.
