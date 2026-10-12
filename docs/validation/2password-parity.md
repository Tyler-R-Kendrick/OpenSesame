# 2password parity gauntlet

The oracle is kitlangton/2password commit
`e011177d3e35f97a580b8903df6fff7e02593d16`. The command table, implementation,
tests and shipped agent skill were audited together. The machine-readable
matrix is `spec/conformance/2password-parity.json`. The expanded PR/issue oracle
and pinned branch heads are described in
[the upstream review](2password-upstream-review.md). Parity requires every
contract in the current matrix to pass.

Run `node scripts/test/2password-parity.mjs` from the repository root.
The gate builds the native CLI with Rust 1.88 and the static PWA before their
runtime suites. Set `PLAYWRIGHT_CHROMIUM` when Chromium is installed outside
Playwright's default location. `CARGO_TARGET_DIR` selects the shared Rust
target cache; the native fixture uses the corresponding fresh executable.
An unbound scenario fails. A failed suite, missing assertion report or missing
passing named assertion also fails. Reports are removed before each suite so
an earlier run cannot satisfy the gate. Pending implementation is never
treated as verified parity.

Each matrix entry names the observable contract and the surfaces that must
exercise it. Bindings identify a runtime suite and the exact passing Vitest
assertion name. Tests must invoke core operations against recording adapters,
the CLI parser and dispatcher, or the actual surface handler. Source-text
searches and component-name existence are insufficient evidence.
Layered bindings require both the primary surface invocation and named
supporting adapter assertions. For example, a real browser Audit click proves
the UI calls the workflow, while a clock-controlled adapter fixture checks
five-year-old logins. A handoff check alone cannot satisfy the destination's
credential behavior.

The Rust `opensesame password-agent` and TypeScript `opensesame-id` commands
have separate subprocess suites. Passing one does not satisfy the other's
bindings. The browser suite drives the built PWA at desktop and phone widths.
Every run writes `work/2password-parity-report.json` with the pinned oracle,
parity status and any missing or failed surface checks.

The core fixtures must check calls, outputs and failure paths using fictional
sentinel credentials. In particular, uncertain writes execute once, never
retry and never claim verification; readback mismatch is a failure. Discovery
and resolution batch work. Broken saved authentication fails closed. Child
processes receive selected credentials but not the authentication token.

The browser draws no password-workflow screen. Its surfaces are the places the
vault already shows what each capability acts on: the item's toolbar (a
reference-only template, and a plaintext `.env` that asks twice), a login's password row (compare by a mark, replace through the verified
write), Password health (items to file or rename, as findings) and New item. The
list is the inventory, and a field's own reveal and copy are the explicit read.
They operate on the unlocked local sealed vault using `os://` references;
native 1Password workflows use `op://` references. The browser does not
administer 1Password service accounts, hold the native lease store or execute
provider processes, and the Access section draws no form for native requests.
Service tokens never enter these browser workflows. Native process execution
is verified on the CLI. The desktop webview shares the Pages/PWA surface. The
browser extension has no password workflow and is not a parity surface.

Pages WebMCP metadata handlers have their own runtime assertions. Sensitive
operations are exposed as deliberate human workflow handoffs, with the actual
destination workflow verified separately. Protocol MCP (`mcp-client` and
`mcp-host`) and the native mobile wallet are excluded by the custody boundaries
in [ADR 0177](../adr/0177-password-workflow-surface-boundaries.md). A passing
report establishes the matrix's stated surface scope, not universal provider
support across every application.

Provider administration is part of the oracle: service-account setup,
connect, status, recover and forget cannot be replaced by an unrelated generic
vault setting. Platform persistence must protect the token and verify stored
readback. Tests may use recording fake provider and storage adapters; genuine
provider access is an additional integration check, not a reason to skip
deterministic conformance cases.

The upstream implementation has two limitations that should not be copied:
duplicate creation checks are not an atomic lock, and the CLI help describes
`--repair-imported-fields` as requiring `--apply` without enforcing that pair.
OpenSesame should keep its stronger concurrency and validation protections.

The [canonical report](2password-parity-result.json) covers 52 scenarios and
197 surface checks. All nine upstream PRs and both issues are pinned in the
upstream review. The matrix includes contextual Account actions, selected
login methods, organization Health, travel withdrawal, and private-prompt
withdrawal without account resurrection. Native requests and leases are a CLI
contract (`request.*`, `lease.*`); the browser draws nothing for them.

The six runtime suites contain 49 core, 35 client CLI, 29 native CLI,
12 real-browser, 29 shared adapter/write-path and 11 human UI assertions. The
browser exercises both 1280px and 390px, including actual clipboard, downloads,
Health navigation, the item toolbar's template and twice-asked plaintext file,
the password row's compare mark and verified update, an abandoned account draft
leaving no credential type switched on, and preservation of sibling Account
methods. The 197 surface checks bind 316 primary and supporting assertions; a
meaningful runtime scenario may support more than one surface.

The exact matrix SHA-256 is
`3315679d5fc6da83b61251598e2ccb37f588a791a691daa3b40ba11adfff4cf6`.
The implementation integrates OpenSesame main
`22ec373ab59a85271040b3341d5474a862a8a905`, including Account login methods,
the shared password production facade, current copy/gesture/tray controls, one-line credential editing, Settings pages,
customer-context-bound authority envelopes and browser/CLI session envelopes.
Password workflow authority and surface boundaries are documented in ADR 0177.
Derived references return the produced password, never its root; slotted and legacy
methods keep their human boundary. The fresh dependency review is recorded in
[the October 6 audit](../security/audits/2026-10-06-password-parity-dependencies.md).

The old baseline blockers were addressed: the expired-certificate test now
uses a valid certificate with an explicit verification clock, anti-slop debt
was reduced, authored tutorial startup proceeds independently of optional agents, and consent capacity
is verified independently of repeated expensive authorization ceremonies.
Canonical Account readback verifies the exact shared-stamper field-clock transition,
including legitimate future logical clocks, while checking every other value exactly.
Five regression cases exercise the real shared store stamper and reject clock or
credential corruption without retries. Private-prompt and queued writes
reject concurrent changes and withdrawal.

Final self-review also closed credential-bearing interpreter startup gaps in
both CLI adapters. Reserved startup keys are rejected by shared core before
provider access, and private environment snapshots prevent source-file
changes after validation. Agent initialization rejects stale selections
after model acquisition and treats routine cancellation as cancellation.
Existing shared-session streams now revalidate closure and seat status
before each frame; actual HTTP tests verify termination and the operator's
retained record.

Broader verification walks all 174 desktop/phone tutorials, including popup
focus and the front-door, sign-in, seal and unlock gates. The mobile contract
covers six widths: 320, 390, 430, 844, 1024 and 1366 pixels. Each run pins the
actual PWA build; the final pull-request review records its completed results
and assertion count. These checks supplement the scenario-bound parity
assertions; they are not additional parity scenarios.

Native preparation snapshots the fresh production CLI and exact CLI/connector-host test executables with SHA-256 digests. Runtime contracts execute those verified binaries by exact test name under the unchanged 180-second deadlines, so unrelated Cargo feature-graph recompilation cannot consume an assertion window.

The integrated customer-envelope code exposed a hardened-profile entry budget regression. AWS/GCP key adapters now load during their selected async enrollment/proof operations, and enrollment checks cancellation again after loading before any transport call. Existing provider checks and two cancellation regressions pass. Fresh minimal-local and family-local hardened builds both pass their capability graphs and measure a largest asset of 695,091 bytes (678.8 KiB), below the latest 686 KiB ceiling. The default build and both hardened profiles pass the full bundle-budget gate; no ceiling was raised.

The new cancellation tests were verified in an isolated copy: removing only the post-import guards made both AWS/GCP cases fail, and restoring them passed. A native executable-digest negative control likewise rejects a modified manifest digest before execution; restoring the exact digest passes the named runtime assertion. Neither control mutates production source or changes deadlines.

Final local verification on October 6 completed with `pnpm verify` exit 0: all 70 workspace test tasks, integration checks, the full Rust workspace/all-target suite and all battle tests pass. The freshly rebuilt seven-suite parity run against the latest integrated main passes and exactly matches the canonical report. AST, working-tree secret and advisory gates pass. Latest-main CI contract tests and installed dependency regressions pass. Android JVM crypto/FFI, app assembly and four-architecture APK checks pass in CI; Swift envelope tests, iOS package compilation and simulator XCTest checks pass too. The implementation preserves main’s native-wallet storage and platform CI gates. Required CI on each final signed PR head still gates its squash merge; actual merge results belong in the PR review.

After the implementation squash, main advanced to `aaa15658eca44aabf9d2f8087fc96c6264868fbe` with secret-envelope downgrade rejection and customer-isolated encrypted indexes. The verification PR preserves those changes unchanged. Its dedicated parity and required repository checks run again on the restacked signed head; the earlier full local verification receipt remains the completed pre-restack run. Final current-head results are recorded in the PR self-review before merging.

## Correction, 2026-10-07

The matrix above was rewritten when the standalone password-workflow screen was
removed (ADR 0177, amendment). Everything stated earlier about that screen, the
Access request-command form, the extension handoff and the 53-scenario /
237-check totals describes the superseded matrix. Rerun for this correction:
the full six-suite gauntlet (fresh native and PWA builds, canonical result
regenerated), the app-core, Pages, capability-registry, MCP client and CLI unit
suites, the structural, anti-slop and design gates, and the real-browser
verifier at 1280 and 390. The all-tutorials, six-width mobile, WebMCP-count and
bundle-budget walks recorded above were not rerun by this change. The
local PWA build skipped `tsc --noEmit`, which already reports eight
duplicate-`@types/react` errors on the untouched base in this environment.
