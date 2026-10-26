# OpenSSF Scorecard maintenance

The [public result](https://api.scorecard.dev/projects/github.com/Tyler-R-Kendrick/OpenSesame)
dated 2026-10-26 reports 5.5/10 for commit
`aad2c85b4b567fd632d0e409d53d17bb66e8fba4`. It is a snapshot, not a scan of
the working checkout. Merge fixes and wait for a subsequent public result before
claiming a higher score.

## Dependency findings

`pnpm audit:osv` scans every tracked Cargo, pnpm and npm lockfile, including
`.deepsec/pnpm-lock.yaml`, `.cursor/tools/package-lock.json` and
`tests/fuzz/cargo/Cargo.lock`, and the TURN module's `go.mod`.
Untracked dependency caches and private reports are excluded. Scanner errors,
missing reports and every reported advisory fail the gate; no new exceptions
were added.

The root npm and isolated DeepSec locks already contain the fixes for the
reported body-parser, fast-uri, ip-address, Undici, Zod, MSAL and Vitest
advisories. The root Rust lock already contains Wasmtime 36.0.19, Tokio
1.53.3, ctutils 0.4.5, crypto-bigint 0.7.9 and webpki-roots 1.0.10.

The independent fuzz lock needed regeneration against the current manifests,
including their existing pinned age Git revision and RustCrypto dependency
generation. Its certificate/runtime fixes are:

| Package | Previous | Updated | Advisory |
| --- | --- | --- | --- |
| tokio | 1.53.1 | 1.53.3 | RUSTSEC-2026-0386 |
| rustls-webpki | 0.103.14 | 0.103.16 | RUSTSEC-2026-0382 |
| webpki-roots | 1.0.9 | 1.0.10 | RUSTSEC-2026-0381 |
| webpki-root-certs | 1.0.9 | 1.0.10 | RUSTSEC-2026-0383 |

The follow-up removes the two remaining advisory implementations:

- [RUSTSEC-2026-0374](https://osv.dev/RUSTSEC-2026-0374): both Cargo locks
  remove `basic-toml`. Immutable upstream fixes in Askama
  `3863808cf594054f7644979ed92caaafc878f378` and i18n-config
  `2ce7b1dfe9a8cc224288bf50cbc2a67a6de863c4` migrate their consumers to
  maintained TOML parsers. Parser compatibility, existing age encryption
  paths and byte-identical UniFFI binding generation are verified.
- [GO-2026-5932](https://osv.dev/GO-2026-5932): TURN retains only the
  unchanged upstream cryptobyte and ChaCha20-Poly1305 packages it needs,
  their dependencies, tests, vectors, licenses and architecture implementations.
  Unsupported OpenPGP source is physically absent. The subset keeps the real
  upstream module identity and exact version/commit/checksum provenance;
  it is explicitly maintained here rather than represented as an upstream
  separate release.

**OSV omits local Go replacements.** Its clean result alone is insufficient.
The same gate first checks every retained source byte against checksum-verified
upstream, rejects omitted/extra/symlinked files and missing package coverage,
runs upstream optimized/generic crypto tests, and runs pinned govulncheck against
a temporary real TURN module with its upstream dependency restored. Package-level
analysis covers all functions in the imported packages. The restored full module
still reports a module-only OpenPGP advisory, while reporting zero affected
imported packages; the delivered subset contains no OpenPGP. There is no advisory
ignore or VEX exception. See [source maintenance](../../scripts/test/live-turn/README.md).

That expanded audit discovered an additional standard-library advisory,
[GO-2026-6809](https://osv.dev/GO-2026-6809), fixed by requiring Go 1.26.10.
The integrated OSV and companion package audit pass on the prepared stack.
This does not claim that all original findings were newly fixed by this change;
many dependency versions were already patched on the checked-out main commit.

## Signed releases

The public result says **no releases found**. The release workflow already
creates signed build provenance; it now also attaches the original Sigstore
bundles as `.sigstore.json` release assets and verifies those exact bundles
before publishing. See [release verification](../operators/release-kit.md).
Run the normal reviewed release process when a release is ready. A workflow
edit or a dry run cannot change a check that examines published releases.

## OpenSSF Best Practices badge

This check reads the project's assessment at
[bestpractices.dev](https://www.bestpractices.dev/), rather than inferring
compliance from repository files. A maintainer must register the repository
and complete the [passing criteria](https://www.bestpractices.dev/en/criteria/0)
with truthful answers and evidence. Useful starting evidence is:

| Assessment area | Repository evidence |
| --- | --- |
| Project and contribution process | [README](../../README.md), [CONTRIBUTING](../../CONTRIBUTING.md), [license](../../LICENSE) |
| Vulnerability reporting and response | [Security policy](../../SECURITY.md) with a direct private-report link and response timelines |
| Security design and analysis | [Security index](README.md), threat models, audit history and scanner gates |
| Build, testing and release integrity | [Contributor verification](../../AGENTS.md#8-verification-expectations), pinned workflows and [release guide](../operators/release-kit.md) |

Verify each criterion, resolve gaps, and add the project's real badge URL
only after enrollment. Enrollment is currently deferred; no badge ID or
certification is asserted here.

## Other low checks

| Check | Remediation or remaining constraint |
| --- | --- |
| Token-Permissions | Remove unused issue-write permissions from scheduled scans. Keep the release publishing job's required contents-write permission scoped to that job. |
| Pinned-Dependencies | Pin public Rust, Debian, Node and OSS-Fuzz images by verified digest; replace mutable Grok/Cursor installers with versioned SHA-256 checked artifacts and lock Kimi's npm dependency inventory. OSS Verify's base is supplied by its external local-builder framework, not a public registry tag to which a fabricated digest can be attached. |
| Security-Policy | Add the direct private-report URL. GitHub confirms private vulnerability reporting is enabled. |
| Code-Review | GitHub accepted a real Copilot review request. It does not create a second human maintainer or guarantee an approving review. Do not manufacture review records to change the score. |
| Branch-Protection | Reconcile the checked-in policy with the supported strict up-to-date checks on this personal repository, replacing an unsupported merge-queue specification. Existing signatures, checks, resolved threads and force-push/deletion protection remain. Applying release-tag protection returns HTTP 403 to this integration. The owner approved the exact release-environment protections recorded in ops/github. Activation remains blocked by HTTP 403 because this integration lacks Environment/Administration write access. |
| Binary-Artifacts | Retain the required Gradle wrapper bootstrap. Its SHA-256 matches the official Gradle 8.13 wrapper checksum, and the downloaded distribution has a checked-in checksum. A regression test rejects changed bootstrap bytes. This verifies artifact identity, not absence of implementation vulnerabilities, and does not pretend the bootstrap is source text. |
| Maintained / Contributors | Project age and independent contributor diversity require real time and contributions; do not create artificial activity or identities for the score. |

The separate native WASM compiler also required Go 1.27.3 for the new
crypto/x509 distrust advisory (GO-2026-6809). Auditing its actual compiled WASM
package graph found affected SSH imports as well (GO-2026-6303,
GO-2026-6354 and GO-2026-6355); verified composition pins update the maintained
crypto, network, text and required transitive modules.
The upstream source archive remains immutable. The OSV gate inventories the
compiler's Go standard library through a generated CycloneDX component and
requires a companion audit of the exact composed native package graph. That
package analysis excludes unimported upstream tools and OpenPGP, without
advisory exceptions or pretending the whole upstream module is advisory-free.
Native audits retire invocation-owned compiler, source and build caches after
confirmed child-group shutdown, preserving receipts, package graphs and
diagnostics. An abrupt driver death with uncertain nested state fails closed
and retains its unique scratch directory for inspection. Shared verified
archives and other audit invocations remain untouched.

The three app-core unit failures found during broad verification were stale
expectations: native identity now reserves its popup before network work, all
native identity modes refuse the legacy OAuth path, and an image response
rejected before text streaming takes custody remains untouched for its owner.
Updated tests preserve those security properties and explicitly check that no
body reader is acquired or cancelled before the owner performs cleanup.
