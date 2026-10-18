# GitHub security remediation, 2026-10-18

Base inspected: `495f1d42082dcd56b7a3d50bf39cfc645c2f7acd`. Changes are in signed, stacked draft pull requests; they have not been merged or represented as closed GitHub alerts.

## Patch stack

| PR | Change |
| --- | --- |
| [1485](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1485) | TURN x/crypto 0.56.0, x/sys 0.47.0, Pion STUN 3.1.5 and transport 4.0.2; Go 1.26 minimum and pinned 1.26.9 CI toolchain |
| [1487](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1487) | Missing native store key refuses daemon fill; preserves age/GPG reads |
| [1491](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1491) | Missing native key refuses bridge reads/writes before mutation |
| [1492](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1492) | rustls 0.23.46, quinn-proto 0.11.18, Wasmtime 36.0.18; independent fuzz lockfile too |
| [1493](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1493) | Isolated DeepSec workspace: Undici 7.29.1/8.10.2, brace-expansion 5.0.12, MCP SDK 1.31.0 including peers |
| [1494](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1494) | Advanced CodeQL with explicit Android Kotlin and iOS Swift builds and Go test extraction |
| [1499](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1499) | Bound unauthenticated issuer input before normalization; replace quadratic input parsers |
| [1500](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1500) | Private tool/state files, protected shared paths, and confined loopback static serving |
| [1512](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1512) | Require explicit interactive reveal for generated/updated passwords; stop printing prior passwords and trailers |
| [1524](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1524) | Kotlin Android/Compose 2.4.20, supported R8 9.1.31 override, and JVM 17 compiler-options migration |
| [1528](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1528) | Patch 46 advisory IDs in Android build-only dependencies through a Netty BOM and scoped constraints |

Independent read-only investigation preceded fixes; fresh candidate reviews identified compatibility regressions that were corrected before shipping. Full repository verification and post-fix CodeQL results are recorded below when complete. No new alert suppressions were added.

## Local scans and verification

CodeQL CLI 2.27.2 matches the version in the supplied screenshots. Security-extended suites were run locally. Python (10 files) and Actions (10 workflows) report zero findings. Go extracts all six repository Go files and reports one test-only reflected-XSS warning: `nativehttp_test.go` echoes a fixed binary request in an owned loopback TLS fixture.

Java/Kotlin analysis now succeeds locally with CLI 2.27.2 and official java-queries 1.11.12: all 124 security-extended query plans execute successfully with zero findings. The traced build extracts all 10 expected Kotlin compilation units (seven production, two unit-test, one generated binding), plus generated BuildConfig.java. The scanner denominator also includes three Gradle .kts scripts, which are outside application compilation. Extraction reports zero errors and 46 modeling warnings (29 primitive mappings, 15 Compose EQ origins, two source offsets); those warnings may limit expression modeling, so this is not a warning-free precision claim.

The full JavaScript/TypeScript baseline reports 135 findings across 7,699 scanned files out of 7,803 extracted files. Source review separates actual input-complexity and file-handling weaknesses from test assertions, protocol-required algorithms, and existing safeguards. The scoped JavaScript post-fix suite scans all 73 changed/new files: 48 baseline warnings in that file set become nine guarded file/path warnings, with zero polynomial-regex warnings. The remaining three path warnings are behind real-path confinement; six temporary-file warnings concern owned 0700 directories or checked no-follow descriptors. Regression tests exercise raw/encoded traversal, symlinks, hardlinks, and ordinary behavior. This scoped comparison does not replace a default-branch rescan. Rust extracts all 1,999 files without errors and reports 380 baseline findings: 286 hard-coded cryptographic values, 76 cleartext logging, 10 log injection, and eight other findings. Independent source review covers every row. The actionable production rows are the two missing-key fallbacks and three ungated CLI password-output locations; fixture values, fully overwritten buffers, explicit credential-protocol transfers, and checked boundaries account for the other rows. The scoped native-key post-fix query removes both production fallback findings and retains only three deliberately malicious-ciphertext test fixtures. That query snapshot precedes mechanical module extraction; moved bodies match exactly, and final source passes compilation, strict scoped Clippy, and regression tests. These local counts are not live GitHub alert counts.

Repository lint, the anti-slop gate and its 366 tests, 596 quality tests, 17 security tests, structural/log-hygiene/package/boundary gates, and plugin-boundary negative controls pass. Module splits reduce the structural ledger without raising limits; the first fill PR compiles independently. Full workspace Rust formatting and strict Clippy pass all targets/features with every repository deny flag.

All 69 TypeScript package typechecks pass. The non-CLI unit run completes with all 71 tasks successful (67 cached). Control-plane passes 1,450 tests; app-core passes 10,011 with 28 skipped; Pages passes 5,776 across 760 files plus 115 Node tooling checks. The complete TypeScript CLI suite passes all 336 tests across 39 files with one worker, after two timing failures under the initial loaded run. Database (5), MCP (22), red-team (16), and browser visual (6) integration tests pass. The browser production build initially exceeded the suite's 180-second startup timeout; building it separately and using the existing prebuilt mode completes the same six browser assertions successfully. Full workspace Rust runtime tests are in progress; full `pnpm verify` has not been represented as passed.

The original Rust CLI independently reproduces generated-password and prior-password output leaks. All four candidate real-process regressions pass, covering generated/provided mutations, private-trailer preservation, declined updates, and denied piped reveal before mutation. Native Gradle 8.13 configuration and runtime class loading confirm Kotlin 2.4.20 and R8 9.1.31. On full checksum-verified JDK 17, compileDebugKotlin, compileDebugJavaWithJavac, dexBuilderDebug and mergeExtDexDebug pass with cache disabled and tasks rerun (24 tasks, 3m19s). After build-only constraints, actual changed-source Kotlin/Java compilation and DEX generation pass again (25 tasks, 2m31s); assembleDebug passes and SDK apksigner verifies its v2 signature. The APK lacks the OpenSesame core JNI library, so runtime FFI, native ABI packaging, and native GitHub runner checks remain unverified.

Focused verification includes 422 daemon/sealed-store tests; 95 bridge unit tests and nine KeePassXC handshake tests; 149 updated sealed-store tests; 34 final-source focused tests after mechanical module extraction; 230 Rust dependency runtime/integration tests and passing doc targets; 1,411 package tests for parser fixes; Pages typecheck and seven tooling tests; queue, cache, and snapshot regressions; strict scoped Rust Clippy; and frozen dependency installs. TURN smoke checks exercise actual UDP/TCP/TLS allocations and relay traffic with static/REST credentials and refusal of bad or expired credentials. The two existing npm security backports pass their adversarial and legitimate controls against a fresh install.

## Remaining advisory version matches

Whole public OSV ecosystem databases were downloaded and compared to lockfiles locally. Neither `pnpm audit` nor a dependency-graph upload was used. Updated root, nested fuzz, Go, and DeepSec lockfiles have no remaining advisory matches with an upstream fixed version. Go standard-library/toolchain advisory records were compared against 1.26.9 too; the pinned setup-go action honors the module's toolchain directive. Additional complete public databases (7,192 Maven, 64 SwiftURL, and 56 GitHub Actions records) were matched locally against the native/plugin manifests. This identified Kotlin GHSA-r937-wjx7-w2jp / CVE-2026-53914, addressed by PR 1524. The vulnerable upstream path is KAPT incremental-cache deserialization; this application does not enable KAPT, so a currently exploitable build path was not demonstrated. Kotlin 2.4.20 contains the upstream filtering fix. Swift pins are unaffected; reviewed Action pins use v4 where the matched advisory concerns v2/v3. Native Maven resolution covers 420 distinct package/version pairs across 407 names. It finds 46 advisory IDs / 47 affected entries entirely in the root buildscript/plugin classpath, with none in app compile, runtime or unit-test runtime classpaths. PR 1528 removes these affected build dependencies with a Netty 4.1.139.Final BOM and constraints for Bouncy Castle 1.86, Commons Compress 1.28.0, jose4j 0.9.7 and JDOM 2.0.6.1. Actual changed-source resolution yields 422 external package/version pairs across 409 names, with zero affected matches against the full Maven database, including newly introduced transitives. App dependency sets remain unchanged. See the [per-advisory build inventory](android-build-advisories-2026-10-18.md). These matches were not 46 demonstrated application vulnerabilities. The Multipaz iOS binary has no matching SwiftURL advisory identity.

Eight unpatched-version matches remain in the original lockfile ecosystems, including one duplicate across the two Cargo lockfiles:

| Package/advisory | Evidence and disposition |
| --- | --- |
| node-forge 1.4.0, GHSA-86w9-cpqp-85rv | Existing exact repository backport; patch/installed-source hashes and malicious/legitimate signature tests pass. GitHub version-only matching can still display this alert. |
| braces 3.0.3, GHSA-vfj7-8cjw-p6xm | Existing exact repository backport; patch/source hashes and nested-pattern controls pass. |
| x/crypto, GO-2026-5932 | Advisory concerns the unmaintained OpenPGP subpackage. The TURN dependency import graph does not import it; x/crypto is updated for the separate fixed advisories. |
| rsa 0.9.10, RUSTSEC-2023-0071 | No patched release. Existing repository policy documents SQLx lockfile ancestry and no OpenSesame RSA private-key operations over observable timing channels. No new exception added. Appears in both Cargo lockfiles. |
| zvariant, zbus_names, zvariant_derive, RUSTSEC-2026-0370/0371/0372 | Unmaintained transitive packages, no fixed release. Remain outstanding for dependency replacement planning; not silently dismissed. |

## Secret-pattern and code-scanning dispositions

The visible secret warnings point to AWS example responses and Tailscale canaries in test, mock-upstream, config-test, and credential-envelope fixtures. Inspected locations include `native-sts.test.ts`, `credential_envelope_tests.rs`, `upstream_tests.rs`, `tailnet_admin_conformance_tests.rs`, `tailnet_admin_routes_tests.rs`, and tailnet-admin config tests. No provider credential was validated or used, and no actual service credential was identified for rotation. Current-tree Gitleaks produced 25 redacted generic-pattern matches in test/docs/conformance fixtures, including published HPKE vectors. This is not proof that all historical secrets are absent. Values are intentionally omitted here.

Visible Rust hard-coded-value warnings also include negative password tests, KeePassXC nonce vectors, and zero-initialized buffers overwritten by checked reads or secure randomness before use. Those are distinct from the real daemon/bridge missing-key fallbacks fixed above. Test vectors were not randomized or split to evade scanning.

Reviewed JavaScript false positives include:

- JSON responses with explicit content types, complete HTML attribute escaping, and test-only reflected data;
- `Array.includes` exact-origin comparison and JSON-stringified generated module specifiers;
- dedicated Web Worker IPC, whose creator owns the channel;
- random alphabets of length 32, which divide 256 without modulo bias, plus non-secret polling jitter;
- protocol-required TURN HMAC-SHA1, mock HIBP SHA1 responses, and SHA256 asset integrity checks;
- filename allowlists, path confinement, and native artifact readers that compare inode/revision metadata before and after descriptor reads;
- bounded configuration/test/evidence inputs without a demonstrated remote attacker boundary.

These dispositions are review evidence, not bulk GitHub alert dismissal. Repository security APIs return HTTP 403 to this integration, so live alert IDs/counts and secret-scanning history cannot be exhaustively matched or updated through it. The screenshots and local scans nevertheless provide enough information for the concrete fixes above.

## Activation and completion criteria

Before advanced CodeQL uploads can run, switch the repository's CodeQL setup from **default** to **advanced** in Code scanning settings. GitHub rejects advanced uploads while default setup is enabled. Changing Codex app scopes is not a remedy. Android and macOS builds must pass on their native GitHub runners; this Linux environment does not establish those results. The repository has no independent C/C++ translation unit; its generated FFI header is compiled through Swift.

Keep the stack draft until required checks and full repository verification pass. Merge in stack order, run CodeQL on the resulting default-branch commit, and reconcile the remaining fixture/backport/unpatched advisories against the live dashboard. No claim of zero open GitHub alerts is made before that reconciliation.
