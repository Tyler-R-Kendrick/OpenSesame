# Automatic certificate issuance implementation evidence

## Reconciled baseline and stack

Integration base: `291992f987185c99f24c105397a8411bc7c75a3c`
(`origin/main`, 2026-08-25). Pull requests #188 through #191 are merged in this
base; their guest-to-registered principal preservation remains intact. The
reconciled implementation head before this evidence update is `9c7982d`.

The original work was split into three dependency-ordered branches:

- `feat/auto-certificates-core`: custody ADR, automatic Pages ceremony,
  storage migration, private/external issuer adapters, fuzz and mutation
  coverage, CLI output constraints, and threat-model documentation.
- `feat/auto-certificates-hardening`: browser bearer removal, extension build
  pin, atomic origin tests, isolated visual server, sanitized SBOM generation,
  real Shuttle schedules, corrected replay-cache fuzz oracle, and executable
  formal gates.
- `feat/auto-certificates-security`: MCP administrative-response minimization.

Those commits were replayed and conflict-resolved on
`feat/security-review-integrated`; `git log origin/main..HEAD` records the
integrated stack. No unrelated working-tree file is part of it.

## Delivered behavior

The normal certificate ceremony asks for a primary hostname, optional DNS/IP
SANs, lifetime, and an optional configured issuer. OpenSesame generates the
P-256 leaf key and CSR. With no external default, it generates and uses an
OpenSesame private CA; users do not paste a certificate, private key, CSR, or
issuing CA.

Configured issuer Connections support Let's Encrypt production/staging,
ZeroSSL with EAB, Cloudflare DNS-01, and Cloudflare Origin CA. External failure
never silently falls back to the private CA. Results carry the explicit trust
class `private_local`, `public_web`, `test_only`, or `origin_only`.

CA/account material and one-time leaf delivery are sealed with actor- and
organization-bound AAD. Production requires durable storage and a sealing key.
Delivery is idempotent, single-reader, expiring, and acknowledged only after
Pages has stored the result in its encrypted vault. The server persists public
issuance metadata and digests, never a delivered plaintext credential.

Boy-scout fixes made while validating the boundary:

- upstream guest bearer state no longer uses browser storage;
- MCP administrative tools return bounded, redacted summaries;
- visual tests use an isolated preview server;
- SBOM generation strips unsafe inherited environment;
- extension output is pinned to the supported target;
- replay-cache fuzzing models expiry rather than cumulative historical accepts;
- Kani, Miri, and Shuttle gates execute their intended proof targets.

## Schema and configuration

`migrations/0013_certificate_issuance.sql` adds sealed certificate authorities,
issuance orders, one-time deliveries, replay/idempotency constraints, and
public issuance metadata. The application migration validates and seals a
legacy `certs.dev_ca` pair, reloads it, verifies the key/certificate match, and
only then deletes plaintext. Conflicts fail closed.

Automatic private-CA issuance is the default Host behavior and therefore has
no availability flag. External issuers are selected through existing scoped
Connections; flags cannot disable validation. Existing experimental trust
protocol flags remain independently default-off as documented in
`.env.schema`. Production certificate routes require the existing durable DB,
connection sealing key, and receipt-signing configuration.

## Standards and dependencies

- RFC 8555 ACME, DNS-01 profile only.
- `instant-acme = 0.8.5`, exact-pinned with `aws-lc-rs`; its account/order/JWS
  implementation is reused instead of custom ACME cryptography.
- P-256 generated leaf and private-CA keys through the repository's existing
  Rust crypto stack.

Dependency review found `instant-acme` 0.8.5 current on 2026-08-21,
Apache-2.0, actively maintained, without a postinstall surface. Deterministic
fixtures cover EAB, account recovery, retries, DNS cleanup, key binding, SANs,
issuer allowlists, response bounds, and redirect refusal. Local tests use no
personal provider credentials.

## Security findings and regression proof

The implementation enforces generated-key custody, authenticated encryption,
tenant/actor isolation, exact issuer hosts, HTTPS, no redirects, bounded
responses, DNS cleanup on terminal paths, idempotent issuance, one-time
delivery, no trust downgrade, no production ephemeral CA, and redacted
logs/audit/errors. The enforcement boundaries have atomic, adversarial,
contract, behavior, characterization/snapshot, chaos, property, fuzz,
concurrency, mutation, and end-to-end tests.

Codex Security CLI `0.1.20` with bundled plugin `0.1.37` completed a targeted
review of all 12 files resolved from seven certificate/custody paths. It used
ChatGPT subscription authentication, GPT-5.6 Luna at low effort, standard mode,
and a USD 15 scanner estimate cap. The complete run cost estimate was
USD 0.09094584 and produced one confirmed medium finding: the development-only
ephemeral issuance-history fallback used a host-global key and could return one
organization's metadata to another organization. Commit `5da2361` scopes that
key by organization and adds
`adversarial_ephemeral_history_isolated_between_organizations`; no raw
certificate, key, or claim value was involved. Lower reasoning and the narrow
path scope remain explicit coverage limitations.

## Validation results

Clean disposable checkout results:

- `pnpm install --offline --frozen-lockfile`: pass.
- `pnpm lint:all`, `pnpm lint:anti-slop`, `cargo fmt --all -- --check`: pass.
- `pnpm build`: 13/13 tasks; `pnpm typecheck`: 46/46 tasks.
- `pnpm test`: 48/48 tasks; Pages 119 files / 1,701 tests; red-team 19/19;
  visual 6/6.
- `cargo +1.88.0 test --workspace --all-targets`: pass.
- `pnpm test:integration`: 6/6 tasks, including database 5/5, MCP Host 21/21,
  structural red-team 15/15, and visual 6/6.
- `pnpm test:security`: 3/3.
- `pnpm test:e2e` with the documented local Gateway fixture: 2/2 Playwright
  journeys plus 3/3 extension contract checks.
- `pnpm generate:openapi`: pass and produces no tracked diff; certificate
  issuance remains on the separate Host API.
- `pnpm verify`: pass, including changed-file lint, `test:all`, the complete
  Rust workspace, Wasm client smoke, adversarial broker checks, and battle
  tests.

Depth gates run against the same implementation:

- TypeScript coverage: 92.24% statements, 85.42% branches, 93.39% functions,
  93.31% lines. Rust coverage: 73.374% lines, 71.083% functions, 73.065%
  regions.
- TypeScript mutation: 469 killed, 2 timeout, 50 ignored, zero survived or
  uncovered. Focused certificate Rust mutation: 22 caught, 8 unviable, zero
  missed. The prior broad Rust run caught 138, found 18 unviable, and exposed
  seven out-of-scope survivors; the focused certificate boundary is green.
- JavaScript fuzz: 12 targets for 30 seconds each, pass. Certificate cargo-fuzz:
  357,906 executions in 31 seconds, pass. A batch replay-cache target exposed a
  false oracle that counted expired historical entries; the oracle was fixed
  and its focused 30-second rerun passed 295,932 executions. The complete
  33-target batch rerun was interrupted by harness state loss, so no full-batch
  green claim is made.
- Kani: 4/4 harnesses. Miri: selected audit, claims, domain, grants, redaction,
  proof-replay, and vault refusal suites pass. Shuttle: 3 tests across 1,000
  schedules each.
- ast-grep, Semgrep, OSV, cargo-audit, cve-lite, Clippy, daemon dependency,
  gitleaks working-tree, and DeepSec deterministic/pattern gates pass. Gitleaks
  history reports 51 pre-existing historical candidates and is not represented
  as a clean-history result.

## Residual risk and intentionally unsupported profiles

- No HTTP-01, TLS-ALPN-01, arbitrary ACME directory, automatic deployment,
  imported-key issuance fallback, or silent external-to-private downgrade.
- Cloudflare Origin certificates are explicitly origin-only; staging
  certificates are test-only.
- Live Let's Encrypt, ZeroSSL, and Cloudflare issuance was not exercised because
  mandatory tests cannot require provider credentials. Production onboarding
  must validate scoped provider Connections and operational key rotation.
- The work claims the documented RFC 8555 subset, not general ACME, CA, WebPKI,
  provider, hardware, NIST, or browser-wallet conformance.
- Codex Security covered only the selected certificate/custody boundary; it is
  not evidence of a complete repository-wide model review.

## Evidence paths

- Architecture decision:
  `docs/adr/0052-automatic-certificate-authority-selection.md`
- Threat model: `docs/security/threat-model.md`
- Custody audit:
  `docs/security/audit-2026-08-21-certificate-key-custody.md`
- MCP minimization audit:
  `docs/security/audit-2026-08-22-mcp-response-minimization.md`
- Certificate tenant-isolation audit:
  `docs/security/audit-2026-08-25-certificate-tenant-isolation.md`
- Protocol/support matrix: `docs/protocol-conformance.md`
- This implementation record:
  `docs/validation/trust-broker-implementation-evidence.md`
