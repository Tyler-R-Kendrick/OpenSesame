# CI migration map

**Status: proposed implementation plan; no active workflow or repository setting is changed by this document.**
Baseline: `Tyler-R-Kendrick/OpenSesame` at `aad2c85b4b567fd632d0e409d53d17bb66e8fba4`.
The YAML examples in this proposal live outside `.github/workflows/` and are inert.
Names below are implementation targets; a named helper or reusable is not evidence that it has been implemented or run.

## 1. Scope and promotion contract

The first implementation promotes the Pages PWA and the existing x86_64/aarch64 Linux release kits.
Android, Apple, Windows and extension checks remain compatibility evidence; this phase does not claim to publish those products.
Main remains the development branch. Integration, dev, prerelease and release are candidate states/channels, not additional Git branches.
One candidate binds source SHA, source CI run/attempt, builder run/attempt, artifact IDs/digests, payload digests and build configuration.
Every qualification result identifies that candidate. A successful check on another SHA, artifact or profile cannot qualify it.
Candidate preparation fixes workspace versions and embedded metadata before qualification; promotion does not rebuild or restamp the payload.
The nightly controller selects a successful main revision and materializes or reuses its complete candidate; the weekly controller freezes a dev-qualified candidate and executes prerelease before deep release checks.
Neither controller resolves a moving branch again between stages. Missing, expired, failed or mismatched evidence blocks promotion.
Test-only binaries and alternate verification builds are labelled separately and are never selected as production payloads.

## 2. Inventory of all 14 current workflows

| Current workflow | Disposition | Destination and retained behavior |
| --- | --- | --- |
| `ci.yml` | Split | Controller `ci.yml` calls `ci-fast-checks.yml`; retain top-level required reporters. `candidate-build.yml` produces artifacts for accepted main source. Move broad browser/native qualification to `ci-prerelease-checks.yml`. |
| `codeql.yml` | Convert | Six-language `security-extended` matrix becomes candidate-bound work called by `ci-release-checks.yml`; remove duplicate main-push and general PR runs only when replacement coverage is operational. |
| `complete-verify.yml` | Convert | Preserve the complete `pnpm verify` chain, exact-source assertions and evidence capture in `ci-prerelease-checks.yml`; retire its broad automatic PR trigger. |
| `container-build-pr.yml` | Split | Keep Dockerfile/build-input validation when needed; move the general image-build check to prerelease. It currently builds on every non-draft PR without a path filter. OCI publishing is outside phase one. |
| `deploy-pages.yml` | Convert | Candidate builder owns preparation/stamping; `release-publish.yml` uploads and deploys the approved payload, then verifies the live release digest. Disable the old main-push rebuild/deploy path at cutover. |
| `full-suite.yml` | Fold in | `dev-nightly.yml` calls `ci-dev-checks.yml` for the existing whole-TS suite, native-asset preparation and real Postgres checks. Retire the independent nightly schedule after the new controller is proven. |
| `native-platform-validation.yml` | Convert | Preserve real-host core, CLI and release-artifact matrices under prerelease, including startup/provenance assertions and failure logs. Cross-compilation alone does not replace these tests. |
| `password-parity.yml` | Convert | Preserve `pnpm test:2password-parity` and assertion reports under prerelease; retire the broad PR-triggered gauntlet. |
| `publish-containers.yml` | Disable legacy publishing at cutover | Remove its ungated `v*` automatic publisher from the activated path. Later implement candidate-bound OCI publishing; until then this path must not publish around release qualification. |
| `publish-npm.yml` | Disable legacy publishing at cutover | Its manual rebuild/publish also bypasses qualification. Reintroduce only as a gated candidate publisher, or explicitly exclude and disable it until that implementation exists. |
| `pwa-native-wasm.yml` | Keep diagnostic | Preserve explicit/manual cold-build proof and owner/source guards. It is not a recurring PR gate and does not authorize deployment. |
| `release-kit.yml` | Split | `candidate-build.yml` owns existing bridge/native builds and archives; `release-publish.yml` verifies version/tag/source, provenance and checksums and publishes identical approved bytes. Disable the old tag-triggered rebuild/publish path at cutover. |
| `security.yml` | Split | Enforced candidate scans move under `ci-release-checks.yml`. Repository-wide Scorecard/history monitoring may remain independently scheduled; dashboard upload success cannot satisfy the release gate. |
| `sync-target-security.yml` | Consolidate | Preserve its four Rust regression commands in the affected fast Rust lane or retain this targeted workflow until equivalent coverage is demonstrated. Remove duplicate invocation only after that proof. |

The target controllers are `ci.yml`, `dev-nightly.yml` and `release-weekly.yml`.
Their reusable targets are `ci-fast-checks.yml`, `candidate-build.yml`, `ci-dev-checks.yml`,
`ci-prerelease-checks.yml`, `ci-release-checks.yml` and `release-publish.yml`.
The controller/reusable split does not require a custom orchestration service.

## 3. Exact current CI job allocation

The table covers every job ID in the baseline `ci.yml`; moving a job changes when it runs, not its assertions.

| Existing job ID | New tier / reusable | Required implementation treatment |
| --- | --- | --- |
| `changes` | Fast / `ci-fast-checks.yml` | Keep signatures, evidence, repository-size, shared-skills checks, affected selection, draft admission and trusted runner selection. |
| `typescript-tests` | Fast / `ci-fast-checks.yml`; complete source suite in dev/prerelease | Keep changed-file lint, auth-artifact lint, quality, affected typecheck/tests, conditional Postgres contracts and experience contracts. Preserve native-asset preparation before Pages tests. |
| `bundle` | Split across builder, dev and prerelease | Build the production candidate once; retain actual default bundle-budget measurement fast. Move profile builds and browser walks to the explicit catalog below. |
| `ai-connections-e2e` | Prerelease / `ci-prerelease-checks.yml` | Preserve its declared AI verification profile and real protocol assertions as profile-specific evidence. |
| `tailnet-browser-node-e2e` | Prerelease / `ci-prerelease-checks.yml` | Preserve official browser SDK, Headscale/native-peer fixture and evidence. |
| `device-inbox` | Prerelease / `ci-prerelease-checks.yml` | Preserve receipts/inbox/local-notification verification with no backend. |
| `push-e2e` | Prerelease / `ci-prerelease-checks.yml` | Preserve production driver, push service and browser path; label its special build profile. |
| `device-identity-e2e` | Prerelease / `ci-prerelease-checks.yml` | Preserve proof that the device can supply identity without an Identity API. |
| `tutorials-e2e` | Prerelease / `ci-prerelease-checks.yml` | Preserve every declared viewport/shard, not a sampled replacement. |
| `live-join-e2e` | Prerelease / `ci-prerelease-checks.yml` | Preserve all owner/joiner browser combinations and pinned live-server fixtures. |
| `rust` | Fast / `ci-fast-checks.yml`; complete workspace in prerelease | Keep affected crates/dependents, all targets, conditional Bitwarden feature coverage and trusted Node bridge setup. |
| `android-native` | Prerelease / `ci-prerelease-checks.yml` | Preserve packaged Rust ABIs, JVM crypto/FFI, app assembly and all four APK architectures. |
| `apple-native` | Prerelease / `ci-prerelease-checks.yml` | Preserve Swift envelope tests, iOS package targets and simulator evidence. |
| `mtls` | Prerelease / `ci-prerelease-checks.yml` | Preserve fast/unit/static-boundary and pinned real-protocol suites; required manifest steps must actually execute. Retain affected unit regressions fast. |
| `typescript` | Top-level reporter / `ci.yml` | Keep exact required context `TypeScript`; fail if preflight or a selected fast check fails, is cancelled or fails to report. |
| `bundle-check` | Top-level reporter / `ci.yml` | Keep exact context `Bundle budgets`; attest actual fast build/budget results, not the weekly browser catalog. |
| `rust-check` | Top-level reporter / `ci.yml` | Keep exact context `Rust`; attest selected fast Rust results. Prerelease now owns native matrix completion. |

### Browser catalog and source checks

`ci-bundle-shards.json` currently declares 15 legs. Preserve its exhaustive catalog and driver mapping.
Default-build-compatible dev smoke includes `verify:static`, `verify:local-iam`, `verify:auth`,
`verify:trusted-unlock`, `verify:encrypted-search`, `verify:portable-drop`, `verify:sw-dirty-edit`,
`verify:push-worker`, and customer-vault/WebCrypto verification. These also remain in complete prerelease qualification.
Prerelease retains every remaining walk: keyboard/SIOP, WebMCP, self-hosted and native connectors,
public OAuth/MCP/provider auth, identity connections, secret backends/GitHub App, quorum-browser,
KDBX DOM, experience journeys, relay/local pairing, peer-trust/peering diagnostics, fresh-vault login,
CLI public-site, all mobile layouts/header parity, plus all dedicated jobs above.
An executable catalog/test must require every existing driver exactly once within the complete qualification suite,
except intentional viewport/journey/browser partitions; nightly smoke repetition is explicit, not duplicate catalog membership.

Dev preserves the existing nightly `turbo run typecheck test --concurrency=4`, both real Postgres suites,
and canonical native-asset preparation. Prerelease preserves complete `pnpm verify`, password parity,
native matrices, container build validation and measured coverage floors. Coverage is not silently replaced by mutation scores.
The release tier adds the existing scoped TS/Rust mutation suites and enforced security checks after prerelease passes.
No mutation or coverage floor is lowered. Targeted trust-boundary regressions stay in the fast affected tests.

### Necessary source/profile builds

The profile catalog includes `minimal-local`/`family-local` hardened, `enterprise-selected` hardened,
and `rich-explicit` selective builds; the emitted-module boundaries are security-relevant assertions.
Dev can run these daily; complete prerelease must require their evidence for the selected candidate.
`bundle-budget-gate.mjs` currently skips missing profile outputs: add an explicit expected-output assertion for qualification.
AI, Tailscale, push, identity, secret-backend and dedicated-live verification use specialized build commands.
`verify:fresh-vault-login` also rebuilds its opted-in distribution. These must be labelled source/profile evidence.
Tests that compile Rust test targets, native platforms, fuzz harnesses, proofs or mutants necessarily build test code.
They must not overwrite the immutable production archive or be mistaken for verification of that exact packaged artifact.
Use separate test outputs; verify original payload digests before and after qualification and again before publishing.
Adapt artifact-capable drivers to consume the candidate; retain source/profile tests until their equivalent coverage is proven.

## 4. Required-check and governance migration

Keep `TypeScript`, `Rust` and `Bundle budgets` as top-level `ci.yml` reporter job names during phase one.
Calling reusable jobs can change emitted check contexts; do not assume a nested job preserves the old context string.
Reporters must always run, reject failed/cancelled/missing selected work, and retain draft failure behavior.
An intentionally unselected area can pass only after successful classification; an unexpected skipped required job cannot.
Verify the actual emitted context names and GitHub Actions app identity before applying any required-check change.

The checked-in `ops/github/default-branch.json` currently requests those three contexts with integration ID `15368`,
`strict_required_status_checks_policy: false`, and an `ALLGREEN` squash merge queue.
`AGENTS.md` still describes strict up-to-date checks and no supported personal-repository queue: these statements conflict.
Neither file proves the live setting. Read/verify live governance during implementation and reconcile the documentation;
do not silently add/remove a queue or change signature, squash, review-thread, deletion or force-push protections.
Retain `merge_group` reporting if a queue is active. Do not cancel its required runs using a main-wide concurrency group.
Keep existing tag version/main-ancestry checks, protected `v*` creation/update/deletion policy and publication provenance.
Changing the attesting/publishing workflow identity requires updating and testing downstream signer-workflow verification.

`ops/github/governance.mjs --apply` also changes Pages deployment-branch policies and tag governance.
It is not a check-name-only operation. The proposal does not run it or modify live rulesets/environments.
Keep deployment controllers on the authorized main workflow; select the candidate explicitly instead of widening Pages access.
If renaming required contexts later, first emit/test the new contexts, then update the owned ruleset, then retire old reporters.
Update `github-governance.test.mjs` only to reflect the deliberately chosen policy, retaining its ownership/drift safeguards.

## 5. Existing contract tests to migrate, not delete

| Test file | Preserve the semantic contract; change the wiring assertion |
| --- | --- |
| `scripts/lib/ci-full-run.test.mjs` | Full validation still has an explicit complete mode; move main-push/full-suite assumptions to scheduled/candidate qualification. Keep exact-source, native-preparation, bounded concurrency and Postgres assertions. |
| `scripts/lib/ci-bundle-shards.test.mjs` | Point exhaustive browser coverage to the prerelease reusable/catalog; preserve exactly-once driver ownership and complete viewport/journey partitions. |
| `scripts/lib/ci-changed-areas-push.test.mjs` | Keep server-side push dependency reachability; move browser-result aggregation assertions to the qualification gate. |
| `scripts/lib/ci-live-join-job.test.mjs` | Preserve all browser combinations, live fixture selection and failure aggregation in prerelease. |
| `scripts/lib/ci-tutorials-job.test.mjs` | Preserve every width/shard and require successful complete results in prerelease. |
| `scripts/lib/ci-native-mobile.test.mjs` | Keep native/ABI change classification; move full platform-result requirements from fast Rust to prerelease. |
| `scripts/lib/ci-container-build-pr.test.mjs` | Replace the hard-coded six auxiliary PR workflows with the approved trigger inventory; retain no-push image validation, draft guards and absence of publication permissions. |
| `scripts/lib/ci-changed-areas.test.mjs` | Preserve required context names, unknown-path fallback and fail-closed preflight; distinguish area selection from tier selection. |
| `scripts/lib/ci-affected-tests.test.mjs` | Preserve dependency closure, all-targets coverage and fallback for unreadable diffs; update workflow path/env assertions. |
| `scripts/lib/ci-gates.test.mjs` | Preserve every-driver classification and unknown-path fallback; recognize moved workflow/catalog inputs. |
| `scripts/lib/ci-pages-build.test.mjs` | Preserve canonical build-step ordering and typecheck ownership; test artifact reuse separately from source builds. |
| `scripts/lib/release-contract.test.mjs` | Stamp in the producer before archive upload; verify after deployment; replace unconditional main deployment with approved-candidate publication. |
| `scripts/lib/ci-release-kit.test.mjs` and `ci-release-kit-bridge.test.mjs` | Preserve archive contents, checksum/provenance, version checks, bridge behavior and production/test-plugin separation across producer and publisher. |
| `scripts/lib/release-tag-check.test.mjs` | Preserve annotated-tag peeling, exact checkout, version agreement and full-ref main ancestry checks. |
| `scripts/lib/github-governance.test.mjs` | Preserve owned-policy comparison and privilege boundaries; reconcile declared/live queue and Pages policy deliberately. |
| `apps/pages/src/lib/keyboard-delivery.contract.test.ts` | Outside the initial sparse checkout: replace its `ci.yml` bundle-job text split with proof of a required built-page keyboard walk in complete prerelease. |

`ci-scoped-tests.test.mjs`, `ci-unit-commands.test.mjs` and `ci-run-lanes.test.mjs` remain unless their implementations change.
Add negative tests for wrong SHA/run/artifact/digest, expired evidence, absent tools/results, cancelled prerequisites,
unexpected skipped required work, publishing from a fork/untrusted source and attempts to publish without all candidate gates.
Tests must exercise admission and failure behavior, not just match the new YAML strings.
Update `AGENTS.md` sections 5/8/9, contributor CI instructions, agent routines, publishing and release-kit documentation.
The agent workflow must describe the revised fast/promotion boundaries; otherwise agents will recreate the previous serial policy.

## 6. Security gates: hardening required before enforcement

No scanner is claimed to be clean: this proposal inspects code and wiring, not completed candidate scan results.
Missing ast-grep, gitleaks, Semgrep, Kani, Miri and cargo-fuzz already fail at this baseline; preserve that behavior.
Provision required tools explicitly and capture versions, rules/config identity, exit status and report completeness.

| Existing gate or report | Implementation requirement |
| --- | --- |
| `security.yml` OSV action | `continue-on-error: true` and `--fail-on-vuln=false` make this informational. Use enforced `audit:osv` or equivalent validated results for release; keep report upload separate from verdict. |
| `scripts/audit/osv-scanner-gate.sh` | Preserve rejection of scanner errors, absent/invalid reports and omitted findings; pin/verify installed tool inputs for CI. |
| `scripts/audit/semgrep-gate.sh` | It handles statuses 1 and 2 but otherwise prints CLEAN. Reject every unexpected nonzero exit; require a valid complete report before applying the findings policy. |
| `scripts/audit/cargo-audit-gate.sh` | It discards scanner exits and treats absent `vulnerabilities` as zero. Require successful completion or the documented findings status plus valid expected schema; error JSON must fail. |
| `scripts/audit/ast-grep-security-gate.sh` | Fail on reported scanner failure/findings consistently; do not rely solely on matching `error[` text or availability of a secondary `rg` invocation. |
| `scripts/audit/cve-lite-gate.sh` | Preserve dependency-compatibility tests and override hygiene; validate scanner status and report schema rather than treating missing findings fields as an empty result. |
| `scripts/audit/gitleaks-gate.sh` | Working-tree findings already block; history findings warn unless `OPENSESAME_GITLEAKS_HISTORY_FAIL=1`. Keep that distinction explicit and never label history clean when findings remain. |
| `scripts/audit/deepsec-gate.sh` | Default mode skips AI processing and reports pattern-scan completion. Do not count it as AI review or absence of findings; model-backed assessment needs a separate completed-result policy. |
| `scripts/fuzz/jazzer-gate.sh` | Keep `JAZZER_ALLOW_FALLBACK=0` for required release coverage; its explicit fallback can exit successfully while reporting DEGRADED. |
| Kani, Miri, Rust fuzz and Shuttle | Provision their real toolchains/fixtures; absent required execution fails. Keep optional investigative runs visibly separate from required qualification. |
| Mutation and coverage | Preserve scoped TS `break: 100`, Rust no-survivor policy and coverage ratchets. Include test/config/tool/dependency changes in reuse invalidation; a cached old score is not current evidence. |

Keep deterministic trust-boundary regressions near the changed code. Weekly depth supplements them.
Scorecard and an uploaded SARIF document measure/report different things from a candidate security verdict.
Model credentials or live-service fixtures that are unavailable must produce a declared blocked/unexecuted result, never a fabricated pass.

## 7. Activation and implementation follow-up

1. Implement the planned candidate/evidence interfaces and all reusable targets; validate them without publishing.
2. Run source-selection, catalog-completeness, negative admission and security-wrapper tests; retain existing assertions.
3. Produce phase-one PWA/Linux candidates, execute their complete qualification, and demonstrate identical payload digests at every stage.
4. Verify real check contexts, live rulesets, environments, artifact retention and signer identities; resolve the documented governance mismatch.
5. Stage the replacement controllers. At the same cutover, disable legacy main Pages deployment and tag-triggered kit/OCI publishing; disable ungated npm dispatch.
6. Preserve targeted early security regressions while retiring duplicated broad PR workflows and the duplicate nightly schedule.
7. Exercise a failed prerelease, failed deep gate, expired artifact and wrong-candidate attempt; prove each prevents publication.
8. Activate schedules only after the frozen-candidate chain and deployment smoke checks work. Rollback restores a known approved payload, not a rebuild from a moving branch.

The proposal PR is reviewable design work. Copying its YAML into `.github/workflows/` without the listed implementations,
test updates and publisher cutover would not constitute a working or equivalent migration.
