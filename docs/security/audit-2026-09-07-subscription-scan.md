# Subscription-backed security review — 2026-09-07

Status: incomplete. This is not a repository-wide security clearance.

## Scope and scanner configuration

The clean, read-only scan clone was at
`c0a9eaea58bcf25e773bb127d26bda0004fdd17f`. Unmerged integration work,
stashes, and local artifacts were not included or removed.

The first scan used Codex Security 0.1.20 / plugin 0.1.37, explicit
`--auth chatgpt --provider openai`, GPT-5.6 Luna / low, standard mode,
and a shared $15 estimated-cost cap. It returned no reportable findings,
but reviewed only 20 files from a 3,961-file inventory and explicitly
reported partial coverage. Estimated usage was $0.11352248, not an API
billing claim. The report itself mentions 3,967 tracked files; the scanner
inventory and report totals differ and must not be treated as full coverage.

The operator then explicitly authorized deep mode, GPT-6 Astra / low,
and removal of the cost cap. The scanner was upgraded to 0.1.25 / plugin
0.1.94. Its bundled Codex 0.149.1 was rejected by Astra, so the launcher
was configured to use the installed stable Codex 0.153.4 through
`CODEX_CLI_PATH`. Authentication remained ChatGPT-only; API-key environment
variables were removed from the scan container.

Deep scanning did not start: enforced host policy does not permit the
`codex_security_deep_scan_worker` permission profile. No policy was changed
or bypassed. An administrator must permit the documented read-only profile
before deep mode can proceed. Standard-mode Astra scans passed live preflight
and started for `packages/auth-upstream/src` (23 files),
`packages/agent-protocols/src` (12 files), and the full committed repository
(3,961 inventory files). They use the same explicit subscription authentication,
low effort, read-only clone, and no cost cap. Raw reports remain private outside
the checkout. Started scans are not completed coverage.

The agent-protocol scan completed all 12 files with no reportable findings
(scan `e6382ae3-4dfe-4edb-86c2-cc12ab780558`). The authentication scan reached
23/23 files and candidate validation but had not completed. After a session
restart, the temporary output directory was no longer available; neither that
scan nor the repository scan is counted as complete. The repository scan was
restarted with reports and its launcher in persistent, owner-only user state.

The persistent repository scan (`a9345515-2b8f-493e-be6c-5a96c4eab3c7`)
reached 67/3,961 files, then failed after five connection retries. Its two
deferred candidates were independently traced and fixed below; the scanner
did not finish validating them. A follow-up authentication scan of commit
`d6254d6c` reached 23/23 files but stopped during validation with a service-side
cyber-access restriction. No attempt was made to bypass that restriction.

## Remediation

- Confirmed webhook SSRF in both the worker and generic notification adapter.
  Default delivery now shares a DNS-pinned, HTTPS-only transport that reuses
  the existing metadata URL/address policy, refuses private destinations and
  userinfo, preserves TLS hostname checks, bounds DNS/request lifetime, and
  never follows redirects. The signing-only module remains free of I/O.
  Explicit development-only insecure delivery and trusted injected transports
  remain opt-ins; redirects are disabled on those calls too.
- Confirmed ordinary organization members could mint GitHub App installation
  tokens using organization-held signing material. Both the connection route
  and KV facade now require integration-administrator authority as well as
  existing ownership/materialization checks. Member delegation is denied until
  an administrator-issued installation/repository/permission grant exists;
  this patch does not claim that current administrator tokens are attenuated.
- Confirmed a passkey ownership-overwrite candidate in the shared registration
  seam. Enrollment now rejects an existing credential ID atomically instead of
  replacing its principal, public key, or counter. Both same-owner and
  cross-owner replacement regression tests failed before the fix and pass after
  it. The reported prerequisite is knowledge of the target credential ID; this
  does not establish victim impersonation or a general enumeration endpoint.
- Tracing that seam also reproduced concurrent acceptance of the same advancing
  signature counter. The update now compares against the current stored counter
  after the asynchronous verifier returns. A concurrent regression test failed
  before the change and passes afterward; counterless authenticators retain
  their existing behavior.
- Updated both direct pins of `@simplewebauthn/server` from 13.2.2 to
  13.3.2, the patched release for
  [GHSA-6hxq-p678-4hr2](https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-6hxq-p678-4hr2).
- Three SQL-formatting alerts were test-only, using fixed table names.
  Replaced interpolation with bound SQLite schema queries while retaining
  migration and schema-snapshot assertions; no production injection was
  established.
- Reviewed secret-scanner matches in synthetic fixtures, PEM delimiter
  checks, storage-key names, and documentation. Added precise annotations,
  not blanket test-file exemptions. Excluded generated Serena caches and
  Impeccable live-server state from repository secret scanning.
- Restricted the existing local live-server state file to owner-only access.
  Quarantined three stale installed dependency copies only after confirming
  that the lockfile and workspace symlinks did not reference them. The temporary
  quarantine is no longer present after the session restart; these were
  reinstallable dependency copies, not user data. Active versions were retained.

## Evidence and remaining work

- Auth-upstream: 85 tests passed after both passkey fixes.
- Webhooks: 19 tests; notification adapters: 137 tests; worker: 102 tests passed.
  Self-review added malformed HTTP-status handling so a hostile response cannot
  throw from the transport callback; its regression test passes.
- Gateway: 11 mint-related tests passed, including member refusal through both
  routes and a successful administrator GitHub App mint.
- Storage: 181 tests passed, including schema snapshots.
- Deterministic red-team tests: 27 passed; shared security tests: 3 passed.
- The live MCP structural corpus passed all 14 cases with no model provider.
  The 16 join-session and two agent-auth chaos tests passed after fixture cleanup.
- AST-grep and dependency/CVE gates passed after remediation.
- OSV, Semgrep, and cargo-audit gates passed. Cargo-audit reported one allowed
  yanked-version warning for `chacha20` 0.10.1, not a vulnerability.
- Auth-upstream typecheck and 112 wallet tests passed; changed TypeScript/JSON
  files passed Biome checks.
- Gitleaks working-tree scan passed. Historical scan reported 98 matches;
  they were not rewritten or individually adjudicated in this pass.
- The live red-team runner could not bind its fixture ports because existing
  services own them. Those services were left running.
- Full `pnpm verify` stopped at 107 anti-slop errors. Its later gates did not
  run; focused successes are not a substitute for complete verification.
- The refreshed full anti-slop run reports 104 errors after three fixture
  assertions were removed. No lint suppression or baseline increase was used.
- Follow-up delivery repairs resolved all 104 errors, and the full strict
  anti-slop gate passed. AgentAuth responses retain inferred concrete fields;
  assertion headers use JOSE's decoder, with malformed-header regression tests.
  Existing domain readers validate JSON fields. Unnecessary test casts were
  removed; two database casts are justified by migration 0022's CHECK constraints.
  The registration row mapper was extracted to keep structural debt decreasing.
  Full verification is being rerun; this lint result alone is not that gate.
- That rerun found three stale Stryker sandbox copies being rediscovered by
  the root lint-plugin test command (1,452 tests instead of 363). The command
  now uses the existing plugin-root configuration, and lint excludes generated
  `.stryker-tmp` copies. All 363 canonical plugin tests passed in 3.8 seconds;
  no test timeout was increased and no sandbox was deleted.
- Integration verification then exposed a stale `Nothing here yet` visual
  assertion and pre-ADR-0090/0091 screen baselines. The test now asserts the
  current `Nothing here` heading. All six desktop/mobile captures were reviewed
  against the shipped Google/guest, seal, and empty-vault screens, refreshed,
  and passed a separate normal comparison run with the unchanged 1.5% budget.
  No application UI or guest-access behavior was changed for this repair.
- Independently, workspace typecheck passed 59/59 tasks after remediation.
  Workspace tests passed 63/63 tasks on an unchanged rerun after one vault
  cryptography test timed out in the first run. No timeout was increased.
  The subsequent malformed-status transport fix passed its package tests
  and typecheck separately.
- After lint repairs, all 59 typecheck tasks passed and all 63 workspace test
  tasks passed on rerun. A support-journey test timed out once under concurrent
  validation load; no timeout or assertion was weakened.
- Full-feature Clippy passed with disposable Cargo source and build directories.
  Earlier attempts failed on cached `const_oid` metadata and UniFFi template
  includes crossing the shared registry symlink; no Rust lint was suppressed
  and the shared dependency cache was left untouched.
- Most of the repository remains unreviewed by the model-backed scanner.
  No claim of finding or fixing every vulnerability is made.
