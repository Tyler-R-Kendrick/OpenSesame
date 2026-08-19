# DeepSec follow-up and independent security audit (2026-08-18)

## Scope

This follow-up reviewed the prior DeepSec report (110 findings across 200
analyzed files), the remediation commits already present on this branch, all
11 files currently pending DeepSec AI analysis, and the repository security
gates. The fresh local matcher run was
`20260819015523-3bf8279f98c41d17` (532 candidates across 210 files).

No unresolved prior DeepSec finding was found. The report counts shown by
`deepsec status` are historical findings, not a post-remediation rescan result.

## Additional findings fixed

- Repository tools accepted absolute, parent-relative, and symlink-escaped
  paths. All reads and greps now resolve through one canonical repository-root
  confinement check, with traversal and symlink regression coverage.
- The passkey enrollment handoff used `sessionStorage` across
  `127.0.0.1` → `localhost`, where origin isolation drops the flag. The handoff
  now uses a one-shot query flag that is removed from browser history on use.
- Queue identifiers used `Math.random()` as a fallback. They now fail closed to
  the browser's `crypto.randomUUID()` implementation.
- The sealed-store path parser stripped leading `/` before checking whether a
  path was absolute. It now rejects the original absolute path before joining
  it to the store root.
- `async-nats 0.42` pulled vulnerable `rustls-webpki 0.102.8`; `async-nats 0.50`
  removes it. `age 0.11` pulled unmaintained `proc-macro-error2`; `age 0.12.1`
  removes it. OSV and Cargo Audit now report zero vulnerabilities.
- OpenBao and OpenFGA outbound bases now require HTTPS or a typed IPv4/IPv6
  loopback host with no URL userinfo. Regression tests cover IPv6 loopback and
  verify every OpenFGA send is preceded by the guard.
- The DeepSec config contained duplicate model and route keys. The duplicates
  were removed.
- Secret scanning now excludes only documented local runtime state and marks
  individual public/fake fixtures. The working tree has zero gitleaks findings.

Validation failures discovered during the audit were also repaired: PACT test
modules had missing delimiters, changelog tests cleared shared state while
running in parallel, the visual contract depended on live Host state, and the
fuzz runner included ordinary `*.test.ts` files.

## Verification

Clean:

- `pnpm test:all`
- `cargo +1.88.0 test --workspace --all-targets`
- `pnpm test:security`
- `pnpm test:task-access`
- `pnpm audit:ast-grep`
- `pnpm audit:clippy`
- `pnpm audit:semgrep`
- `pnpm audit:gitleaks` (working tree; 56 historical matches reduce to nine
  unique public/fake fixtures repeated across commits and generated assets)
- `pnpm audit:cve-lite`
- `pnpm audit:osv`
- `pnpm audit:cargo-audit`
- `FUZZ_SECONDS=1 pnpm test:fuzz`

The changed-file Biome gate remains blocked by 236 formatting diagnostics in
the pre-existing broad PACT branch diff (206 files). This audit did not apply a
repository-wide formatting rewrite over unrelated work.

## DeepSec processing limitation

The local DeepSec matcher scan completed. AI processing of the 11 pending files
was not run because it would send repository contents to an external paid
gateway and that egress was not specifically approved. Those files were
reviewed locally; the repository-tool confinement issue above was found there
and fixed.
