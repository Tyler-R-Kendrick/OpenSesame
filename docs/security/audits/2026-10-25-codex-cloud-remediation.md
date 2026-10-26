# Codex Security Cloud finding remediation

Reviewed the 22 OpenSesame occurrences from the October 9 and October 24
repository scans against main at `aad2c85b`.

## Boundaries

- Publication accepts exact workspace names as data, uses shell-free argv,
  and restricts publication to main or a version tag whose commit main holds.
  Container publication uses a separate `GHCR_PUBLISH_TOKEN` in the
  `container-release` environment; independent package access controls still
  require operator configuration before that finding can be closed.
- Organization issuer reservations are serialized across replicas and both
  issuer columns. Ambiguous legacy reservations fail closed. An operator must
  approve the exact organization and issuer before tenant federation is trusted.
- OIDC metadata fetches have finite body limits; dynamic registration requires
  an adapter-backed initial access token and remains disabled by default.
- Webhook admission counts and creates under the same principal lock and
  transaction, with matching memory-transaction behavior.
- Organization cipher sharing charges actual attachment bytes and pending
  reservations in one transaction, including the entire bulk operation.
- Queued relay work rechecks current delegation and grant ancestry before
  disclosure, approval and result acceptance.
- Public agent/device initiation has a bounded, transport-derived source
  budget; capacity exhaustion preserves existing live device flows.
- Browser-local OIDC subjects are opaque and pairwise. File-selected Argon2
  parameters are rejected before derivation when they exceed browser budgets.
- Autofill pairing tokens live in browser session storage. Legacy persisted
  bearer tokens are invalidated. Pairing alone cannot enumerate or release
  credentials: a separate local operator approves the exact site and operation.
- Upstream logout terminates sessions without deprovisioning memberships.

The existing main-branch fixes for sync-target authorization, actual-byte
upload accounting, identity-link and logout audiences, and the global public
BYO registration ceiling were retained and exercised rather than replaced.

## Operator changes

Tenant federation defaults to denied. Create the organization without issuer
configuration, then configure `OPENSESAME_ORGANIZATION_ISSUER_ALLOWLIST` with
`<organization-id>|<issuer>` entries before configuring that organization's SSO
or SAML issuer. Removing approval also prevents trusting existing tenant rows.

Autofill requires pairing again after a browser restart. Review queued local
operations with `opensesame daemon fill requests`; authorize the selected
request with `opensesame daemon fill authorize <id>` on an interactive local
terminal. Credential grants expire after 90 seconds and can be used once.

## Occurrence disposition

Overall outcome is **blocked** on independent GHCR configuration. Browser
end-to-end evidence was subsequently obtained in GitHub CI. Merge remains
subject to the PR's required checks; no Cloud occurrence was closed.

| Finding | Scan title | Disposition |
| --- | --- | --- |
| csf_3cb4fc98cd546a36d149c6ae | Manual npm publication input is interpolated into a secret-bearing shell step | fixed — focused verification passed |
| csf_fb4ebaa35dbdc1edd25a38c8 | Sync-target routes bypass the durable Host authorization ceiling | no_change — existing fix verified |
| csf_12a30196c04678c10ff985ac | Bitwarden file uploads bypass storage quota through attacker-declared sizes | no_change — existing fix verified |
| csf_4d4a5d289bd932b8d9fb27b0 | Concurrent issuer reservation permits duplicate organization claims | fixed — focused verification passed |
| csf_955006820f7e0aba1a9ac4a4 | Enabled dynamic client registration buffers unbounded relying-party metadata responses | fixed — focused verification passed |
| csf_bed178c4a8c94fffabb95bf6 | Autofill extension stores its daemon pairing token in plaintext browser storage | fixed — focused checks and Chromium E2E passed |
| csf_5f0a456b66b1116e85758420 | Browser-local OIDC exposes the canonical principal as downstream subject | fixed — focused verification passed |
| csf_785e75b6230bb5f75ddede24 | Relay requests can execute after delegation is revoked, expired, or narrowed | fixed — focused verification passed |
| csf_844626ce73b577b54fd2f9fc | Manual container publication can push unverified branch code to official GHCR | blocked — separate release credentials/package policy |
| csf_e4547f3f168c2c3f4917e707 | Sharing personal ciphers transfers attachments without enforcing destination organization quota | fixed — focused verification passed |
| csf_463c5bad30fad8b88281e7fe | Organization owners can claim an identity-provider issuer without proving control | fixed — focused verification passed |
| csf_dd453af617a548f01f2d90fb | Paired autofill extension can request passwords for arbitrary origins without tab- or gesture-bound authorization | fixed — focused checks and Chromium E2E passed |
| csf_f5f84db24aefa060ee6b4532 | Unauthenticated agent-identity creation can exhaust the pending-claim pool | fixed — focused verification passed |
| csf_1b2f924a268b9ad03fd45f76 | Identity linking accepts ID tokens minted for other clients | no_change — existing fix verified |
| csf_aa81613362f6291c60985081 | Public device authorization evicts legitimate pending logins | fixed — focused verification passed |
| csf_0601c22769d60ee9d70f876d | Duplicate organization issuers break federation tenant binding | fixed — focused verification passed |
| csf_540b6adb547b4cbfe7ecd337 | Bitwarden quota accounting trusts declared file sizes | no_change — existing fix verified |
| csf_df0b4edc7a03e6a2cb60c307 | Ordinary upstream logout is treated as tenant deprovisioning | fixed — focused verification passed |
| csf_df9e0cabf6e3855c2bbbc607 | Back-channel logout accepts tokens for other relying parties | no_change — existing fix verified |
| csf_8a0e6bb1170e2200e3328fb3 | Spoofable BYO-upstream limits permit unbounded public registration work | no_change — existing fix verified |
| csf_d0e258a61e9a186b98ab9e5b | KDBX imports accept Argon2 parameters large enough to freeze or crash the browser | fixed — focused verification passed |
| csf_6459a29b484140bc876dc9da | Concurrent webhook registration bypasses the per-principal endpoint quota | fixed — focused verification passed |

## Verification limits

### Ordered verification

1. Syntax, types and static checks: `pnpm lint` passed; `pnpm typecheck`
   passed all 69 tasks, and the affected package typechecks passed again after
   fixture/helper edits. Rust formatting and `cargo +1.88.0 check -p
   opensesame-cli` passed. Strict Clippy passed for all six changed Rust packages
   and all their targets, including the transport-security testkit. The
   structural gate passed with a tightened ledger.
   The full anti-slop scan covered 8,520 files and found three new diagnostics;
   those were corrected, and a subsequent 78-file changed-source comparison
   reported no regressions, improvements needing recording, unused directives
   or unrecognized diagnostics. Late test-file diagnostics were also fixed.
2. Security triggers and legitimate controls: gateway relay/enrollment/device
   and sync tests passed; upload/share quota tests passed 14 cases and nearest
   organization/role tests passed 11. Daemon `fill::` passed 68 tests. Browser
   core passed 100 focused tests, extension passed 139 plus three structural
   pacts, and capability registry passed 40. OIDC registration tests reject
   unauthenticated registration, oversized declared bodies without reading,
   and unbounded chunked bodies by cancellation; a valid authorized sector
   document still registers. SCIM cleanup survives withdrawal of issuer approval
   and directory input cannot select unrelated deprovision targets.
3. Package checks: the gateway's complete 1,114-name library set yielded 1,113
   passes and one preexisting ignored live-NATS case. Two initial snapshot
   harness failures passed after workspace detection was corrected, without
   modifying snapshots. Transport-security with
   `--features testkit` passed all 76 cases. Provider's 214-case suite passed,
   followed by three actual metadata-response regressions. The final federation
   fixture rerun passed 104 cases. Full Bitwarden checks yielded 125 unique
   passes and 14 explicitly ignored external oracle cases. Repository script
   checks passed 1,000 Vitest
   and 75 Node tests. The extension production build passed. Broader workspace
   test runs hit timing failures; the mock IdP's 60 tests and redteam's 40 tests
   passed separate lower-concurrency reruns. `pnpm verify` as a whole has not
   passed, and the full workspace/all-feature Clippy audit was not completed.

Real PostgreSQL was not configured; PGlite exercised the PostgreSQL repository
implementation. Official Bitwarden/SignalR oracle tests that require external
fixtures remain explicitly ignored. The session did not access production data.

An additional SCIM input guard strips reserved reconciliation markers supplied
by a directory. Preexisting malicious marker rows are indistinguishable from
legitimate retry state and need a separate data audit; none was performed here.

Focused regression suites exercise malicious requests, legitimate controls,
concurrency and revocation. The session's private remediation report records
the exact validation results and remaining merge gates.

Managed local Chromium policy blocks extension installation and URLs; it was
left intact. GitHub Chromium E2E subsequently passed all 46 cases, with zero
failures or skips, in run `40249092877` at source `7262670`. This covers legacy
pairing-token migration, independent site and one-use field approval, hostile
pages/frames and legitimate filling. Artifact `12620296235` was downloaded,
its digest verified, and both actual popup screenshots inspected: pending
approval exposes no Fill control, and neither screenshot exposes credentials
or a pairing token. These are temporary review captures, not promoted evidence.

PR review also required exact named issuer-admission proofs, frozen delegation
lookup by ID, separate verified-ingress client budgets, and tenant-scoped logout
revocation while retaining membership. Those fixes passed 136 identity tests,
control-plane typechecking with misuse tests, six relay tests and four enrollment
tests. Classic-script ownership and offline-plan regressions passed 52 tests.

Container publication remains blocked until an operator configures the release
environment to allow only branch `main` and tags `v*`, supplies its separate
credential, and removes the source repository automatic token's write access to
the official GHCR package. Workflow guards alone cannot constrain an actor who
can edit the workflow itself. No GitHub environment policy was changed.
