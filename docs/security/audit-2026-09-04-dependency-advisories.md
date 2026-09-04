# Audit 2026-09-04 — seven open dependency advisories

## Scope

The npm dependency closure recorded in `pnpm-lock.yaml`, and the
`pnpm.overrides` block in the root `package.json` that pins parts of it.
`Cargo.lock` was scanned in the same pass and was already clean.

## How they were found

`pnpm audit` cannot reach npm's advisory endpoint from the sandboxed build
environment, and the GitHub Dependabot alerts API is refused by the same
proxy. Neither blocks the answer: `pnpm audit:osv`
(`scripts/osv-scanner-gate.sh`) downloads osv-scanner and queries OSV
directly, which is the advisory corpus the GitHub Advisory Database feeds
into. Use it as the source of truth here rather than the alert count on the
repository page — it scans both lockfiles and is reproducible offline of
GitHub.

## Findings

| Severity | Package | Advisory | Impact |
| --- | --- | --- | --- |
| High | `fast-uri@3.1.5` | [GHSA-5jgf-p345-68v8](https://github.com/advisories/GHSA-5jgf-p345-68v8) | Host confusion: IDN canonicalisation skipped on scheme-relative references |
| High | `fast-uri@3.1.5` | [GHSA-f65p-4m7j-42xc](https://github.com/advisories/GHSA-f65p-4m7j-42xc) | SSRF via malformed IPv6 normalisation |
| High | `fast-uri@3.1.5` | [GHSA-fph4-wmhf-6fwf](https://github.com/advisories/GHSA-fph4-wmhf-6fwf) | SSRF via repeated hostname percent-decoding |
| High | `fast-uri@3.1.5` | [GHSA-jqff-g426-hqxp](https://github.com/advisories/GHSA-jqff-g426-hqxp) | Host confusion via percent-encoded scheme normalisation |
| Moderate | `qs@6.15.3` | [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) | Denial of service via attacker-controlled `isBuffer` |
| Moderate | `qs@6.15.3` | [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) | `arrayLimit` bypass via bracket-key comma parsing |
| Moderate | `@xmldom/xmldom@0.8.13` | [GHSA-6gmq-8vp8-gcm6](https://github.com/advisories/GHSA-6gmq-8vp8-gcm6) | XML fragment injection via invalid `EntityReference.nodeName` |

All three packages sit on live request paths, not build-only tooling:

- **`fast-uri`** backs `ajv`'s `uri-reference` format, so it validates URIs
  wherever a JSON Schema does — including OAuth/OIDC metadata handling. Four
  of the seven are here, and all four are host-confusion or SSRF primitives,
  which is the worst shape for a component whose whole job is deciding what a
  URL points at.
- **`qs`** parses every Express/`body-parser` query string reached through
  the identity plane's HTTP surface.
- **`@xmldom/xmldom`** parses SAML assertions via `@node-saml/node-saml`,
  `xml-crypto` and `xml-encryption` — attacker-supplied XML by definition.

## Root cause

Two overrides already existed and were scoped to a single parent, so they
never covered the copies that actually resolved:

- `kdbxweb>@xmldom/xmldom` did not cover `apps/mock-upstream-idp`'s **direct**
  dependency, nor the copies pulled in by node-saml, xml-crypto and
  xml-encryption.
- `typed-rest-client>qs` did not cover the copies from express, body-parser
  and google-auth-library.

`fast-uri` had no override at all.

A scoped override is the right tool when one parent needs a different version
from everybody else. It is the wrong tool for a vulnerability, because the
vulnerable copy is wherever the resolver put it, not wherever the override
author happened to look.

## Fix

`fast-uri` → 3.1.6, `qs` → 6.16.0, `@xmldom/xmldom` → 0.8.15. Both scoped
overrides became whole-tree pins, and `apps/mock-upstream-idp`'s direct
dependency was bumped to match so the manifest does not disagree with the
resolution. Exactly one version of each now resolves.

Two pins do not satisfy a declared range, and both were already deliberate
before this change:

- `kdbxweb@2.1.1` asks for `^0.7.4` of `@xmldom/xmldom`; the repository has
  been forcing it onto the 0.8 line since the pre-existing `0.8.13` override.
  0.8.15 is a patch within that already-chosen line.
- `typed-rest-client@2.3.1` pins `qs` at exactly `6.15.1`; the repository was
  already overriding it to `6.15.3`.

Everything else is satisfied normally: express `^6.14.0`, body-parser
`^6.15.2`, googleapis-common `^6.7.0`, node-saml and xml-crypto `^0.8.10`,
xml-encryption `^0.8.5`, ajv `^3.0.1`.

## Verification

- `pnpm audit:osv` — CLEAN over `Cargo.lock` and `pnpm-lock.yaml`.
- `pnpm typecheck` (59/59) and `pnpm test` (63/63). The control-plane SAML
  security suite exercises the `@xmldom/xmldom` path specifically, including
  its signature-rejection and audience-mismatch negative cases; the Pages
  KDBX import suite exercises `kdbxweb` against the forced 0.8 line.

## Residual risk

Overrides are a mitigation, not a resolution: the upstream packages still
declare the ranges they declare, and a future `pnpm install` that adds a
consumer with a genuinely incompatible range will resolve against the pin
without warning. The durable fix is upstream — `typed-rest-client` loosening
its exact `qs` pin, and `kdbxweb` moving to the 0.8 line — at which point
both pins can be dropped. Re-check with `pnpm audit:osv`, not with the
GitHub alert count, which this environment cannot read.
