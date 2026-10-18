# GitHub security remediation, 2026-10-18

Base inspected: `495f1d42082dcd56b7a3d50bf39cfc645c2f7acd`. Changes are in signed, stacked draft pull requests; they have not been merged or represented as closed GitHub alerts.

## Patch stack

| PR | Change |
| --- | --- |
| [1485](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1485) | TURN x/crypto 0.56.0, x/sys 0.47.0, Pion STUN 3.1.5 and transport 4.0.2; Go 1.26 minimum |
| [1487](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1487) | Missing native store key refuses daemon fill; preserves age/GPG reads |
| [1491](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1491) | Missing native key refuses bridge reads/writes before mutation |
| [1492](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1492) | rustls 0.23.46, quinn-proto 0.11.18, Wasmtime 36.0.18; independent fuzz lockfile too |
| [1493](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1493) | Isolated DeepSec workspace: Undici 7.29.1/8.10.2, brace-expansion 5.0.12, MCP SDK 1.31.0 including peers |
| [1494](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1494) | Advanced CodeQL with explicit Android Kotlin and iOS Swift builds and Go test extraction |
| [1499](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1499) | Bound unauthenticated issuer input before normalization; replace quadratic input parsers |
| [1500](https://github.com/Tyler-R-Kendrick/OpenSesame/pull/1500) | Private tool/state files, protected shared paths, and confined loopback static serving |

Independent read-only investigation preceded fixes; fresh candidate reviews identified compatibility regressions that were corrected before shipping. Full repository verification and post-fix CodeQL results are recorded below when complete. No new alert suppressions were added.

## Local scans and verification

CodeQL CLI 2.27.2 matches the version in the supplied screenshots. Security-extended suites were run locally. Python (10 files) and Actions (10 workflows) report zero findings. Go extracts all six repository Go files and reports one test-only reflected-XSS warning: `nativehttp_test.go` echoes a fixed binary request in an owned loopback TLS fixture.

The full JavaScript/TypeScript baseline reports 135 findings across 7,699 scanned files out of 7,803 extracted files. Source review separates actual input-complexity and file-handling weaknesses from test assertions, protocol-required algorithms, and existing safeguards. The scoped JavaScript post-fix suite scans all 65 changed/new files: 48 baseline warnings in that file set become nine guarded file/path warnings, with zero polynomial-regex warnings. The remaining three path warnings are behind real-path confinement; six temporary-file warnings concern owned0700 directories or checked no-follow descriptors. Regression tests exercise raw/encoded traversal, symlinks, hardlinks, and ordinary behavior. This scoped comparison does not replace a default-branch rescan. Rust baseline and scoped post-fix analysis remain in progress; final counts must not be inferred from GitHub's screenshot count.

Focused verification includes 422 daemon/sealed-store tests; 94 bridge unit tests and nine KeePassXC handshake tests; 149 updated sealed-store tests; 230 Rust dependency runtime/integration tests and passing doc targets; 1,411 package tests for parser fixes; Pages typecheck and seven tooling tests; queue, cache, and snapshot regressions; strict Rust Clippy; and frozen dependency installs. TURN smoke checks exercise actual UDP/TCP/TLS allocations and relay traffic with static/REST credentials and refusal of bad or expired credentials. The two existing npm security backports pass their adversarial and legitimate controls against a fresh install.

## Remaining advisory version matches

Whole public OSV ecosystem databases were downloaded and compared to lockfiles locally. Neither `pnpm audit` nor a dependency-graph upload was used. Updated root, nested fuzz, Go, and DeepSec lockfiles have no remaining advisory matches with an upstream fixed version. Eight unpatched-version matches remain, including one duplicate across the two Cargo lockfiles:

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

These dispositions are review evidence, not bulk GitHub alert dismissal. Repository security APIs return HTTP403 to this integration, so live alert IDs/counts and secret-scanning history cannot be exhaustively matched or updated through it. The screenshots and local scans nevertheless provide enough information for the concrete fixes above.

## Activation and completion criteria

Before advanced CodeQL uploads can run, switch the repository's CodeQL setup from **default** to **advanced** in Code scanning settings. GitHub rejects advanced uploads while default setup is enabled. Changing Codex app scopes is not a remedy. Android and macOS builds must pass on their native GitHub runners; this Linux environment does not establish those results. The repository has no independent C/C++ translation unit; its generated FFI header is compiled through Swift.

Keep the stack draft until required checks and full repository verification pass. Merge in stack order, run CodeQL on the resulting default-branch commit, and reconcile the remaining fixture/backport/unpatched advisories against the live dashboard. No claim of zero open GitHub alerts is made before that reconciliation.
